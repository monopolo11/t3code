import { makeWebhookTurnDispatcher } from "./dispatch.ts";
import { HttpClient } from "effect/unstable/http";
import { FileSystem, Path } from "effect";
import { ServerConfig } from "../config.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { copyWebhookAttachments } from "./attachments.ts";
import * as NodeCrypto from "node:crypto";
import {
  ThreadTurnStartCommand,
  OrchestrationDispatchCommandError,
  ChatAttachment,
  WebhookError,
  WebhookIntegrationProvider,
  WebhookTrigger,
  WebhookState,
  WEBHOOK_EVENTS,
  type WebhookOperation,
} from "@t3tools/contracts";
import { Context, DateTime, Effect, Layer, Option, Queue, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import {
  accountIdentity,
  createRemoteWebhook,
  enableRemoteWebhook,
  deleteRemoteWebhook,
  exchangeToken,
  OAuthCredentials,
} from "./ProviderApi.ts";
import { verifyWebhookSignature } from "./signature.ts";
import { renderWebhookPrompt } from "@t3tools/shared/webhookTemplate";
import { webhookTurnCommand } from "./command.ts";

const TriggerJson = Schema.fromJsonString(WebhookTrigger);
const Job = Schema.Struct({
  trigger: WebhookTrigger,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
const JobJson = Schema.fromJsonString(Job);
const isWebhookError = Schema.is(WebhookError);
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(OAuthCredentials));
const decodeTrigger = Schema.decodeUnknownEffect(TriggerJson);
const decodeState = Schema.decodeUnknownEffect(WebhookState);
const decodeStoredCommand = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadTurnStartCommand),
);
const decodeJob = Schema.decodeUnknownEffect(JobJson);
const decodeAttachments = Schema.decodeUnknownEffect(Schema.Array(ChatAttachment));
const decodeTurnCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const encodeStoredCommand = Schema.encodeEffect(Schema.fromJsonString(ThreadTurnStartCommand));
const encodeJob = Schema.encodeEffect(JobJson);
const decodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const errorMessage = (cause: unknown) =>
  isWebhookError(cause) || isDispatchError(cause)
    ? cause.message
    : "Webhook operation failed. Check the integration permissions and environment logs.";
const fail = (message: string) => new WebhookError({ message });

export const make = Effect.gen(function* () {
  const dependencies = yield* Effect.context<
    HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | ServerConfig | WorkspacePaths
  >();
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const dispatchTurn = yield* makeWebhookTurnDispatcher;
  const snapshots = yield* ProjectionSnapshotQuery;
  const mutex = yield* Semaphore.make(1);
  const wake = yield* Queue.sliding<void>(1);
  const workerMutex = yield* Semaphore.make(1);
  const pendingOAuth = new Map<
    string,
    {
      provider: WebhookIntegrationProvider;
      credentials: OAuthCredentials;
      verifier: string;
      expiresAt: number;
    }
  >();
  const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const readCredentials = Effect.fn("webhooks.readCredentials")(function* (
    provider: WebhookIntegrationProvider,
  ) {
    const bytes = yield* secrets.get(`webhook-oauth-${provider}`);
    if (Option.isNone(bytes)) return null;
    return yield* decodeCredentials(new TextDecoder().decode(bytes.value));
  });
  const writeCredentials = (provider: WebhookIntegrationProvider, credentials: OAuthCredentials) =>
    secrets.set(`webhook-oauth-${provider}`, new TextEncoder().encode(JSON.stringify(credentials)));
  const authenticated = Effect.fn("webhooks.authenticated")(function* (
    provider: WebhookIntegrationProvider,
  ) {
    let credentials = yield* readCredentials(provider);
    if (!credentials?.accessToken) return yield* fail("Connect this integration first.");
    if (credentials.expiresAt && credentials.expiresAt < (yield* now) + 60_000) {
      if (!credentials.refreshToken)
        return yield* fail("Your integration session expired. Reconnect it in Settings.");
      const token = yield* exchangeToken(provider, credentials, {
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
      });
      credentials = {
        ...credentials,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? credentials.refreshToken,
        expiresAt: (yield* now) + (token.expires_in ?? 86400) * 1000,
      };
      yield* writeCredentials(provider, credentials);
    }
    return credentials;
  });
  const listTriggers = Effect.fn("webhooks.listTriggers")(function* () {
    const rows = yield* sql<{
      config_json: string;
    }>`SELECT config_json FROM webhook_triggers ORDER BY rowid`;
    return yield* Effect.forEach(rows, (row) => decodeTrigger(row.config_json));
  });
  const getTrigger = Effect.fn("webhooks.getTrigger")(function* (id: string) {
    const rows = yield* sql<{
      config_json: string;
    }>`SELECT config_json FROM webhook_triggers WHERE id = ${id}`;
    if (!rows[0]) return yield* fail("Trigger not found.");
    return yield* decodeTrigger(rows[0].config_json);
  });
  const saveTrigger = (trigger: WebhookTrigger) =>
    sql`INSERT INTO webhook_triggers (id, config_json) VALUES (${trigger.id}, ${JSON.stringify(trigger)}) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`;
  const state = Effect.fn("webhooks.state")(function* () {
    const integrations = yield* Effect.forEach(
      WebhookIntegrationProvider.literals,
      Effect.fnUntraced(function* (provider) {
        const config = yield* readCredentials(provider);
        return {
          provider,
          publicUrl: config?.publicUrl ?? "",
          clientId: config?.clientId ?? "",
          connected: Boolean(config?.accessToken),
          account: config?.account ?? null,
        };
      }),
    );
    const deliveries =
      yield* sql`SELECT id, trigger_id AS triggerId, thread_id AS threadId, status, error, created_at AS createdAt FROM webhook_deliveries ORDER BY created_at DESC LIMIT 50`;
    return yield* decodeState({
      integrations,
      triggers: yield* listTriggers(),
      deliveries,
    });
  });

  const processDelivery = Effect.fn("webhooks.processDelivery")(function* (id: string) {
    const rows = yield* sql<{
      job_json: string;
      command_json: string | null;
      created_at: string;
    }>`SELECT job_json, command_json, created_at FROM webhook_deliveries WHERE id = ${id} AND status = 'pending'`;
    const row = rows[0];
    if (!row) return;
    let command;
    if (row.command_json) {
      command = yield* decodeStoredCommand(row.command_json);
    } else {
      const { trigger, payload } = yield* decodeJob(row.job_json);
      const project = trigger.prompt
        ? Option.getOrNull(yield* snapshots.getProjectShellById(trigger.prompt.projectId))
        : null;
      if (!project) return yield* fail("The trigger's project no longer exists on this machine.");
      const text = yield* Effect.try({
        try: () => renderWebhookPrompt(trigger.prompt!.text, payload),
        catch: (cause) => fail(cause instanceof Error ? cause.message : "Invalid prompt template."),
      });
      const clientCommand = webhookTurnCommand(
        trigger,
        id,
        text,
        project.workspaceRoot,
        row.created_at,
      );
      const attachments = yield* copyWebhookAttachments(
        yield* decodeAttachments(trigger.prompt!.attachments),
        clientCommand.threadId,
      );
      command = yield* decodeTurnCommand({
        ...clientCommand,
        message: { ...clientCommand.message, attachments },
      });
      yield* sql`UPDATE webhook_deliveries SET command_json = ${yield* encodeStoredCommand(yield* decodeTurnCommand(command))} WHERE id = ${id}`;
    }
    yield* dispatchTurn(command);
    yield* sql`UPDATE webhook_deliveries SET status = 'started', error = NULL, job_json = '{}', command_json = NULL WHERE id = ${id}`;
  });
  const drain = workerMutex.withPermit(
    Effect.gen(function* () {
      while (true) {
        const rows = yield* sql<{
          id: string;
        }>`SELECT id FROM webhook_deliveries WHERE status = 'pending' ORDER BY created_at LIMIT 20`;
        if (rows.length === 0) break;
        for (const row of rows) {
          yield* processDelivery(row.id).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("Webhook delivery failed", { deliveryId: row.id, cause });
                yield* sql`UPDATE webhook_deliveries SET status = 'failed', error = ${errorMessage(cause)} WHERE id = ${row.id}`;
              }),
            ),
          );
        }
      }
    }),
  );
  yield* Effect.gen(function* () {
    while (true) {
      yield* drain.pipe(
        Effect.catch((cause) => Effect.logError("Webhook delivery worker failed", cause)),
      );
      yield* Queue.take(wake);
    }
  }).pipe(Effect.forkScoped);

  const operate = Effect.fn("webhooks.operate")(
    function* (operation: WebhookOperation) {
      let authorizationUrl: string | undefined;
      let triggerId: string | undefined;
      switch (operation.type) {
        case "list":
          break;
        case "connect": {
          const publicUrl = yield* Effect.try({
            try: () => new URL(operation.publicUrl),
            catch: () => fail("Enter your public HTTPS tunnel URL."),
          });
          if (
            publicUrl.protocol !== "https:" ||
            publicUrl.username ||
            publicUrl.password ||
            publicUrl.search ||
            publicUrl.hash ||
            publicUrl.pathname !== "/"
          )
            return yield* fail(
              "Use the HTTPS origin of your Cloudflare tunnel, without a path or credentials.",
            );
          const existing = yield* readCredentials(operation.provider);
          if (
            existing &&
            (existing.publicUrl !== publicUrl.origin || existing.clientId !== operation.clientId) &&
            (yield* listTriggers()).some((t) => t.provider === operation.provider)
          )
            return yield* fail(
              "Delete this integration's triggers before changing its tunnel or OAuth app.",
            );
          const timestamp = yield* now;
          for (const [key, value] of pendingOAuth)
            if (value.expiresAt < timestamp || value.provider === operation.provider)
              pendingOAuth.delete(key);
          const state = NodeCrypto.randomBytes(32).toString("hex");
          const verifier = NodeCrypto.randomBytes(32).toString("base64url");
          pendingOAuth.set(state, {
            provider: operation.provider,
            credentials: {
              publicUrl: publicUrl.origin,
              clientId: operation.clientId,
              clientSecret: operation.clientSecret,
            },
            verifier,
            expiresAt: timestamp + 10 * 60_000,
          });
          const url = new URL(
            operation.provider === "github"
              ? "https://github.com/login/oauth/authorize"
              : "https://linear.app/oauth/authorize",
          );
          url.search = new URLSearchParams({
            client_id: operation.clientId,
            redirect_uri: `${publicUrl.origin}/api/webhooks/oauth/${operation.provider}`,
            response_type: "code",
            scope: operation.provider === "github" ? "admin:repo_hook read:user" : "read,admin",
            state,
            code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
          }).toString();
          authorizationUrl = url.toString();
          break;
        }
        case "disconnect": {
          if ((yield* listTriggers()).some((t) => t.provider === operation.provider))
            return yield* fail("Delete this integration's triggers before disconnecting.");
          for (const [key, value] of pendingOAuth)
            if (value.provider === operation.provider) pendingOAuth.delete(key);
          yield* secrets.remove(`webhook-oauth-${operation.provider}`);
          break;
        }
        case "create": {
          yield* authenticated(operation.provider);
          if (
            operation.events.some(
              (event) => !(WEBHOOK_EVENTS[operation.provider] as readonly string[]).includes(event),
            )
          )
            return yield* fail("Choose supported events for this integration.");
          if (
            operation.provider === "github"
              ? !/^[\w.-]+\/[\w.-]+$/.test(operation.target)
              : operation.target !== "*" && !/^[a-f0-9-]{36}$/i.test(operation.target)
          )
            return yield* fail(
              operation.provider === "github"
                ? "Enter a GitHub repository as owner/repository."
                : "Enter a Linear team UUID, or * for all public teams.",
            );
          const trigger: WebhookTrigger = {
            id: NodeCrypto.randomUUID(),
            provider: operation.provider,
            name: operation.name,
            target: operation.target,
            events: [...new Set(operation.events)],
            actions: [...new Set(operation.actions)],
            prompt: null,
            enabled: false,
            webhookId: null,
          };
          yield* saveTrigger(trigger);
          triggerId = trigger.id;
          break;
        }
        case "savePrompt": {
          const trigger = yield* getTrigger(operation.id);
          if (!operation.prompt.text.trim()) return yield* fail("Enter a prompt for the trigger.");
          const project = Option.getOrNull(
            yield* snapshots.getProjectShellById(operation.prompt.projectId),
          );
          if (!project) return yield* fail("Choose a project on this machine.");
          const retained = operation.prompt.attachments.filter(
            (attachment) =>
              "id" in attachment &&
              trigger.prompt?.attachments.some(
                (saved) => "id" in saved && saved.id === attachment.id,
              ),
          );
          const incoming = operation.prompt.attachments.filter(
            (attachment) => !retained.includes(attachment),
          );
          const candidate = { ...trigger, prompt: { ...operation.prompt, attachments: incoming } };
          // Claim pending uploads into a durable trigger namespace, reusable by every delivery.
          const normalized = yield* normalizeDispatchCommand(
            webhookTurnCommand(
              candidate,
              `template-${trigger.id}`,
              operation.prompt.text,
              project.workspaceRoot,
              DateTime.formatIso(yield* DateTime.now),
            ),
          );
          if (normalized.type !== "thread.turn.start")
            return yield* fail("Invalid trigger prompt.");
          yield* saveTrigger({
            ...trigger,
            prompt: {
              ...operation.prompt,
              attachments: [...retained, ...normalized.message.attachments],
            },
          });
          break;
        }
        case "setEnabled": {
          let trigger = yield* getTrigger(operation.id);
          if (operation.enabled && !trigger.prompt)
            return yield* fail("Compose a prompt before enabling this trigger.");
          if (operation.enabled && !trigger.webhookId) {
            const credentials = yield* authenticated(trigger.provider);
            const secret = yield* secrets.getOrCreateRandom(`webhook-signing-${trigger.id}`, 32);
            const webhookId = yield* createRemoteWebhook(
              trigger,
              credentials,
              Buffer.from(secret).toString("hex"),
            );
            trigger = { ...trigger, webhookId };
          } else if (operation.enabled) {
            const credentials = yield* authenticated(trigger.provider);
            yield* enableRemoteWebhook(trigger, credentials.accessToken!);
          }
          yield* saveTrigger({ ...trigger, enabled: operation.enabled });
          break;
        }
        case "delete": {
          const trigger = yield* getTrigger(operation.id);
          if (trigger.webhookId) {
            const credentials = yield* authenticated(trigger.provider);
            yield* deleteRemoteWebhook(trigger, credentials.accessToken!);
          }
          yield* sql`DELETE FROM webhook_triggers WHERE id = ${trigger.id}`;
          yield* secrets.remove(`webhook-signing-${trigger.id}`);
          break;
        }
        case "retry": {
          const rows = yield* sql<{
            job_json: string;
            command_json: string | null;
          }>`SELECT job_json, command_json FROM webhook_deliveries WHERE id = ${operation.id} AND status = 'failed'`;
          if (!rows[0]) return yield* fail("Failed delivery not found.");
          const job = yield* decodeJob(rows[0].job_json);
          const trigger = yield* getTrigger(job.trigger.id);
          if (!trigger.enabled)
            return yield* fail("Resume the trigger before retrying a delivery.");
          yield* sql`UPDATE webhook_deliveries SET status = 'pending', error = NULL, job_json = ${yield* encodeJob({ ...job, trigger })} WHERE id = ${operation.id}`;
          yield* Queue.offer(wake, undefined);
          break;
        }
      }
      return {
        state: yield* state(),
        ...(authorizationUrl ? { authorizationUrl } : {}),
        ...(triggerId ? { triggerId } : {}),
      };
    },
    mutex.withPermit,
    Effect.mapError((cause) => (isWebhookError(cause) ? cause : fail(errorMessage(cause)))),
  );

  const callback = Effect.fn("webhooks.callback")(function* (
    provider: WebhookIntegrationProvider,
    state: string,
    code: string,
  ) {
    const pending = pendingOAuth.get(state);
    pendingOAuth.delete(state);
    if (!pending || pending.provider !== provider || pending.expiresAt < (yield* now))
      return yield* fail("This sign-in expired. Start again from Settings → Integrations.");
    const token = yield* exchangeToken(provider, pending.credentials, {
      code,
      grant_type: "authorization_code",
      redirect_uri: `${pending.credentials.publicUrl}/api/webhooks/oauth/${provider}`,
      code_verifier: pending.verifier,
    });
    const account = yield* accountIdentity(provider, token.access_token);
    const existing = yield* readCredentials(provider);
    if (
      existing?.account &&
      (existing.accountId
        ? existing.accountId !== account.id
        : existing.account !== account.name) &&
      (yield* listTriggers()).some((t) => t.provider === provider)
    )
      return yield* fail(
        "Delete existing triggers before connecting a different account or workspace.",
      );
    yield* writeCredentials(provider, {
      ...pending.credentials,
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(token.expires_in ? { expiresAt: (yield* now) + token.expires_in * 1000 } : {}),
      account: account.name,
      accountId: account.id,
    });
  }, mutex.withPermit);

  const receive = Effect.fn("webhooks.receive")(function* (
    id: string,
    headers: Readonly<Record<string, string | undefined>>,
    body: Uint8Array,
  ) {
    const trigger = yield* getTrigger(id);
    const secret = yield* secrets.get(`webhook-signing-${trigger.id}`);
    if (
      Option.isNone(secret) ||
      !verifyWebhookSignature(
        trigger.provider,
        Buffer.from(secret.value).toString("hex"),
        body,
        headers[trigger.provider === "github" ? "x-hub-signature-256" : "linear-signature"],
      )
    )
      return yield* fail("Invalid webhook signature.");
    const payload = yield* decodePayload(new TextDecoder().decode(body)).pipe(
      Effect.mapError(() => fail("Invalid webhook JSON payload.")),
    );
    if (
      trigger.provider === "linear" &&
      (typeof payload.webhookTimestamp !== "number" ||
        Math.abs((yield* now) - payload.webhookTimestamp) > 60_000)
    )
      return yield* fail("Expired webhook timestamp.");
    const event = headers[trigger.provider === "github" ? "x-github-event" : "linear-event"];
    if (
      !trigger.enabled ||
      !trigger.prompt ||
      !event ||
      !trigger.events.includes(event) ||
      (trigger.actions.length > 0 &&
        (typeof payload.action !== "string" || !trigger.actions.includes(payload.action)))
    )
      return;
    const delivery =
      headers[trigger.provider === "github" ? "x-github-delivery" : "linear-delivery"];
    if (!delivery || delivery.length > 200) return yield* fail("Missing delivery identifier.");
    const deliveryId = NodeCrypto.createHash("sha256")
      .update(`${trigger.id}:${delivery}`)
      .digest("hex");
    yield* sql`INSERT OR IGNORE INTO webhook_deliveries (id, trigger_id, thread_id, job_json, created_at) VALUES (${deliveryId}, ${trigger.id}, ${`webhook-${deliveryId}`}, ${yield* encodeJob({ trigger, payload })}, ${DateTime.formatIso(yield* DateTime.now)})`;
    yield* Queue.offer(wake, undefined);
  });
  return {
    operate: (operation: WebhookOperation) =>
      operate(operation).pipe(Effect.provideContext(dependencies)),
    callback: (provider: WebhookIntegrationProvider, state: string, code: string) =>
      callback(provider, state, code).pipe(Effect.provideContext(dependencies)),
    receive,
    drain: drain.pipe(Effect.provideContext(dependencies)),
  };
});

export class WebhookService extends Context.Service<WebhookService, Effect.Success<typeof make>>()(
  "t3/webhooks/WebhookService",
) {
  static readonly layer = Layer.effect(WebhookService, make);
}
