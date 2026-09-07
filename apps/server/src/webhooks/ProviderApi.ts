import {
  WebhookError,
  type WebhookIntegrationProvider,
  type WebhookTrigger,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export const OAuthCredentials = Schema.Struct({
  publicUrl: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.String,
  accessToken: Schema.optionalKey(Schema.String),
  refreshToken: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.Number),
  account: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.String),
});
export type OAuthCredentials = typeof OAuthCredentials.Type;
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
});

const decodeToken = Schema.decodeUnknownEffect(TokenResponse);
const decodeGithubAccount = Schema.decodeUnknownEffect(
  Schema.Struct({ id: Schema.Number, login: Schema.String }),
);
const decodeLinearAccount = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
    }),
  }),
);
const decodeGithubWebhook = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Number }));
const decodeLinearWebhook = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      webhookCreate: Schema.Struct({
        success: Schema.Literal(true),
        webhook: Schema.Struct({ id: Schema.String }),
      }),
    }),
  }),
);
const decodeLinearDelete = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({ webhookDelete: Schema.Struct({ success: Schema.Literal(true) }) }),
  }),
);

export const requestJson = Effect.fn("webhooks.requestJson")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    request.pipe(
      HttpClientRequest.setHeaders({ Accept: "application/json", "User-Agent": "T3-Code" }),
    ),
  );
  if (response.status < 200 || response.status >= 300)
    return yield* new WebhookError({
      message: `Integration request failed (HTTP ${response.status}). Check your credentials and repository or team permissions.`,
    });
  return yield* response.json;
}, Effect.timeout("20 seconds"));

export const exchangeToken = Effect.fn("webhooks.exchangeToken")(function* (
  provider: WebhookIntegrationProvider,
  credentials: OAuthCredentials,
  params: Record<string, string>,
) {
  const result = yield* requestJson(
    HttpClientRequest.post(
      provider === "github"
        ? "https://github.com/login/oauth/access_token"
        : "https://api.linear.app/oauth/token",
    ).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        ...params,
      }),
    ),
  );
  const token = yield* decodeToken(result);
  const scopes = typeof token.scope === "string" ? token.scope.split(/[ ,]+/) : token.scope;
  if (
    provider === "github"
      ? !scopes.includes("admin:repo_hook") && !scopes.includes("repo")
      : !scopes.includes("admin")
  )
    return yield* new WebhookError({
      message:
        "The integration did not grant permission to manage webhooks. Reconnect and approve the requested scopes.",
    });
  return token;
});

const graphql = Effect.fn("webhooks.graphql")(function* (
  token: string,
  query: string,
  variables: unknown,
) {
  return yield* requestJson(
    HttpClientRequest.post("https://api.linear.app/graphql").pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyJsonUnsafe({ query, variables }),
    ),
  );
});
export const accountIdentity = Effect.fn("webhooks.accountIdentity")(function* (
  provider: WebhookIntegrationProvider,
  token: string,
) {
  if (provider === "github") {
    const body = yield* requestJson(
      HttpClientRequest.get("https://api.github.com/user").pipe(
        HttpClientRequest.bearerToken(token),
      ),
    );
    const account = yield* decodeGithubAccount(body);
    return { id: String(account.id), name: account.login };
  }
  const body = yield* graphql(token, "query { organization { id name } }", {});
  return (yield* decodeLinearAccount(body)).data.organization;
});

export const createRemoteWebhook = Effect.fn("webhooks.createRemoteWebhook")(function* (
  trigger: WebhookTrigger,
  credentials: OAuthCredentials,
  secret: string,
) {
  const url = `${credentials.publicUrl}/api/webhooks/${trigger.id}`;
  if (trigger.provider === "github") {
    const body = yield* requestJson(
      HttpClientRequest.post(`https://api.github.com/repos/${trigger.target}/hooks`).pipe(
        HttpClientRequest.bearerToken(credentials.accessToken!),
        HttpClientRequest.bodyJsonUnsafe({
          name: "web",
          active: true,
          events: trigger.events,
          config: { url, content_type: "json", secret, insecure_ssl: "0" },
        }),
      ),
    );
    const hook = yield* decodeGithubWebhook(body);
    return String(hook.id);
  }
  const body = yield* graphql(
    credentials.accessToken!,
    "mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id } } }",
    {
      input: {
        url,
        label: `T3 Code: ${trigger.name}`,
        resourceTypes: trigger.events,
        secret,
        ...(trigger.target === "*" ? { allPublicTeams: true } : { teamId: trigger.target }),
      },
    },
  );
  const result = yield* decodeLinearWebhook(body);
  return result.data.webhookCreate.webhook.id;
});

export const deleteRemoteWebhook = Effect.fn("webhooks.deleteRemoteWebhook")(function* (
  trigger: WebhookTrigger,
  token: string,
) {
  if (!trigger.webhookId) return;
  if (trigger.provider === "github") {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.delete(
        `https://api.github.com/repos/${trigger.target}/hooks/${trigger.webhookId}`,
      ).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("User-Agent", "T3-Code"),
      ),
    );
    if (response.status !== 204 && response.status !== 404)
      return yield* new WebhookError({
        message: `Could not delete GitHub webhook (HTTP ${response.status}).`,
      });
    return;
  }
  const body = yield* graphql(
    token,
    "mutation($id: String!) { webhookDelete(id: $id) { success } }",
    { id: trigger.webhookId },
  );
  yield* decodeLinearDelete(body);
}, Effect.timeout("20 seconds"));

const decodeLinearEnable = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({ webhookUpdate: Schema.Struct({ success: Schema.Literal(true) }) }),
  }),
);

/** Restore subscriptions disabled by a provider after a tunnel outage. */
export const enableRemoteWebhook = Effect.fn("webhooks.enableRemoteWebhook")(function* (
  trigger: WebhookTrigger,
  token: string,
) {
  if (trigger.provider === "github") {
    yield* requestJson(
      HttpClientRequest.patch(
        `https://api.github.com/repos/${trigger.target}/hooks/${trigger.webhookId}`,
      ).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJsonUnsafe({ active: true }),
      ),
    );
    return;
  }
  const body = yield* graphql(
    token,
    "mutation($id: String!) { webhookUpdate(id: $id, input: { enabled: true }) { success } }",
    { id: trigger.webhookId },
  );
  yield* decodeLinearEnable(body);
});
