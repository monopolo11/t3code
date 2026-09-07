import * as TestClock from "effect/testing/TestClock";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { OAuthCredentials } from "./ProviderApi.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadTurnStartCommand,
  WebhookTrigger,
  WebhookState,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema, FileSystem, DateTime } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import migration from "../persistence/Migrations/050_WebhookTriggers.ts";
import { make } from "./WebhookService.ts";

const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(OAuthCredentials));
const encodeTrigger = Schema.encodeEffect(Schema.fromJsonString(WebhookTrigger));
const decodeTurnCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const encodeState = Schema.encodeEffect(Schema.fromJsonString(WebhookState));
const encodeJobFixture = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ trigger: WebhookTrigger, payload: Schema.Unknown })),
);

const projectId = ProjectId.make("project-1");
const fixture: WebhookTrigger = {
  id: "trigger-1",
  provider: "github",
  name: "Fix issue",
  target: "acme/app",
  events: ["issues"],
  actions: ["opened"],
  enabled: true,
  webhookId: "123",
  prompt: {
    text: "Fix {{payload.issue.title}}",
    attachments: [],
    projectId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    baseBranch: "main",
    startFromOrigin: true,
    runSetupScript: true,
  },
};

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-webhooks-test-" });
const baseLayer = Layer.mergeAll(
  NodeSqliteClient.layerMemory(),
  configLayer,
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const testLayer = ServerSecretStore.layer.pipe(Layer.provideMerge(baseLayer));

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* migration;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const secret = Buffer.alloc(32, 42);
  yield* secrets.set("webhook-signing-trigger-1", secret);
  yield* secrets.set(
    "webhook-oauth-github",
    new TextEncoder().encode(
      yield* encodeCredentials({
        publicUrl: "https://t3.example.com",
        clientId: "client",
        clientSecret: "secret",
        accessToken: "token",
        account: "alice",
      }),
    ),
  );
  yield* sql`INSERT INTO webhook_triggers (id, config_json) VALUES (${fixture.id}, ${yield* encodeTrigger(fixture)})`;
  const commands: OrchestrationCommand[] = [];
  const engine = Layer.mock(OrchestrationEngineService)({
    dispatch: (command) =>
      Effect.sync(() => {
        if (
          command.type === "thread.turn.start" &&
          !commands.some((c) => c.commandId === command.commandId)
        )
          commands.push(command);
        return { sequence: 1 };
      }),
  });
  const snapshot = Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: () => Effect.succeed(Option.none()),
    getProjectShellById: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          title: "App",
          workspaceRoot: process.cwd(),
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
  });
  const requests: string[] = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request.url);
      const body = request.url.includes("access_token")
        ? { access_token: "new-token", scope: "admin:repo_hook read:user" }
        : request.url.endsWith("/user")
          ? { id: 1, login: "alice" }
          : { id: 456 };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status: request.method === "DELETE" ? 200 : 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
    }),
  );
  const git = Layer.mock(GitWorkflowService)({
    remoteExists: () => Effect.succeed(false),
    createWorktree: (input) =>
      Effect.succeed({
        worktree: { path: `/tmp/${input.newRefName}`, refName: input.newRefName! },
      }),
    invalidateStatus: () => Effect.void,
  });
  const setup = Layer.mock(ProjectSetupScriptRunner)({
    runForThread: () => Effect.succeed({ status: "no-script" }),
  });
  const deletion = Layer.mock(ThreadDeletionReactor)({ drainThrough: () => Effect.void });
  const createService = make.pipe(
    Effect.provide(Layer.mergeAll(engine, snapshot, http, git, setup, deletion)),
  );
  const service = yield* createService;
  const send = (payload: Record<string, unknown>, delivery = "delivery-1", event = "issues") => {
    const body = Buffer.from(JSON.stringify(payload));
    const signature = NodeCrypto.createHmac("sha256", secret.toString("hex"))
      .update(body)
      .digest("hex");
    return service.receive(
      fixture.id,
      {
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    );
  };
  return { service, sql, secrets, commands, requests, send, createService };
});

it.effect(
  "accepts and deduplicates deliveries, creating a fresh thread and worktree through orchestration",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.send({ action: "opened", issue: { title: "Broken build" } });
      yield* h.send({ action: "opened", issue: { title: "Broken build" } });
      yield* h.service.drain;
      assert.equal(h.commands.length, 1);
      const command = yield* decodeTurnCommand(h.commands[0]);
      assert.equal(command.message.text, "Fix Broken build");
      assert.equal(command.bootstrap, undefined);
      const result = yield* h.service.operate({ type: "list" });
      assert.equal(result.state.deliveries[0]?.status, "started");
      assert.equal(result.state.deliveries[0]?.threadId, command.threadId);
      yield* h.send({ action: "opened", issue: { title: "Another issue" } }, "delivery-2");
      yield* h.service.drain;
      assert.equal(h.commands.length, 2);
      assert.notEqual(command.threadId, (yield* decodeTurnCommand(h.commands[1])).threadId);
    }).pipe(Effect.provide(testLayer)),
  { timeout: 10_000 },
);

it.effect(
  "filters unselected events and actions, ignores paused triggers, and rejects invalid signatures",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.send({ action: "closed" });
      yield* h.send({ action: "opened" }, "delivery-2", "pull_request");
      yield* h.service.operate({ type: "setEnabled", id: fixture.id, enabled: false });
      yield* h.send({ action: "opened", issue: { title: "Paused" } });
      assert.equal(
        (yield* h.service.receive(fixture.id, {}, Buffer.from("{}")).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* h.service.drain;
      assert.equal(h.commands.length, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("records template failures and lets the user repair the prompt and retry", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.send({ action: "opened" });
    yield* h.service.drain;
    const failed = (yield* h.service.operate({ type: "list" })).state.deliveries[0]!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /Missing template variable/);
    yield* h.service.operate({
      type: "savePrompt",
      id: fixture.id,
      prompt: { ...fixture.prompt!, text: "Review {{payload.action}}" },
    });
    yield* h.service.operate({ type: "retry", id: failed.id });
    yield* h.service.drain;
    assert.equal(h.commands.length, 1);
    assert.equal(
      (yield* h.service.operate({ type: "list" })).state.deliveries[0]?.status,
      "started",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("uses one-time expiring OAuth state and keeps secrets out of settings responses", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const result = yield* h.service.operate({
      type: "connect",
      provider: "github",
      publicUrl: "https://t3.example.com",
      clientId: "client",
      clientSecret: "secret",
    });
    const url = new URL(result.authorizationUrl!);
    assert.equal(url.searchParams.get("scope"), "admin:repo_hook read:user");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      (yield* h.service.callback("github", "wrong", "code").pipe(Effect.result))._tag,
      "Failure",
    );
    yield* h.service.callback("github", url.searchParams.get("state")!, "code");
    assert.equal(
      (yield* h.service
        .callback("github", url.searchParams.get("state")!, "code")
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(
      (yield* h.service.operate({ type: "list" })).state.integrations[0]?.connected,
      true,
    );
    assert.ok(!(yield* encodeState(result.state)).includes("clientSecret"));
    const pending = yield* h.service.operate({
      type: "connect",
      provider: "github",
      publicUrl: "https://t3.example.com",
      clientId: "client",
      clientSecret: "secret",
    });
    yield* TestClock.adjust("11 minutes");
    assert.equal(
      (yield* h.service
        .callback("github", new URL(pending.authorizationUrl!).searchParams.get("state")!, "code")
        .pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("recovers pending deliveries on startup", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const job = yield* encodeJobFixture({
      trigger: fixture,
      payload: { action: "opened", issue: { title: "Recovered" } },
    });
    yield* h.sql`INSERT INTO webhook_deliveries (id, trigger_id, thread_id, job_json, created_at) VALUES ('restart', ${fixture.id}, 'webhook-restart', ${job}, '2026-01-01T00:00:00.000Z')`;
    const restarted = yield* h.createService;
    yield* restarted.drain;
    assert.equal(h.commands.length, 1);
    assert.equal((yield* decodeTurnCommand(h.commands[0])).message.text, "Fix Recovered");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "retains saved attachments across prompt edits and gives each delivery an independent copy",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("test image content");
      let result = yield* h.service.operate({
        type: "savePrompt",
        id: fixture.id,
        prompt: {
          ...fixture.prompt!,
          attachments: [
            {
              type: "image",
              name: "example.png",
              mimeType: "image/png",
              sizeBytes: bytes.length,
              dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
            },
          ],
        },
      });
      const saved = result.state.triggers[0]!.prompt!;
      result = yield* h.service.operate({
        type: "savePrompt",
        id: fixture.id,
        prompt: { ...saved, text: "Check {{payload.issue.title}}" },
      });
      assert.deepEqual(result.state.triggers[0]?.prompt?.attachments, saved.attachments);
      yield* h.send({ action: "opened", issue: { title: "First" } });
      yield* h.service.drain;
      const first = (yield* decodeTurnCommand(h.commands[0])).message.attachments[0]!;
      const firstPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: first,
      })!;
      yield* fs.writeFileString(firstPath, "agent modified its copy");
      yield* h.send({ action: "opened", issue: { title: "Second" } }, "delivery-2");
      yield* h.service.drain;
      const second = (yield* decodeTurnCommand(h.commands[1])).message.attachments[0]!;
      assert.notEqual(first.id, second.id);
      const secondPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: second,
      })!;
      assert.equal(yield* fs.readFileString(secondPath), "test image content");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("accepts signed Linear events and rejects stale deliveries", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const trigger = {
      ...fixture,
      provider: "linear" as const,
      events: ["Issue"],
      actions: ["create"],
      prompt: { ...fixture.prompt!, text: "Fix {{payload.data.title}}" },
    };
    yield* h.sql`UPDATE webhook_triggers SET config_json = ${yield* encodeTrigger(trigger)} WHERE id = ${fixture.id}`;
    const timestamp = DateTime.toEpochMillis(yield* DateTime.now);
    const send = (time: number, delivery: string) => {
      const body = Buffer.from(
        JSON.stringify({
          type: "Issue",
          action: "create",
          data: { title: "Linear issue" },
          webhookTimestamp: time,
        }),
      );
      return h.service.receive(
        fixture.id,
        {
          "linear-event": "Issue",
          "linear-delivery": delivery,
          "linear-signature": NodeCrypto.createHmac("sha256", Buffer.alloc(32, 42).toString("hex"))
            .update(body)
            .digest("hex"),
        },
        body,
      );
    };
    assert.equal((yield* send(timestamp - 61000, "expired").pipe(Effect.result))._tag, "Failure");
    yield* send(timestamp, "linear-1");
    yield* h.service.drain;
    assert.equal(h.commands.length, 1);
    assert.equal((yield* decodeTurnCommand(h.commands[0])).message.text, "Fix Linear issue");
  }).pipe(Effect.provide(testLayer)),
);
