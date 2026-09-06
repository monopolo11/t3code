import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";
import {
  createRemoteWebhook,
  deleteRemoteWebhook,
  enableRemoteWebhook,
  exchangeToken,
  type OAuthCredentials,
} from "./ProviderApi.ts";
import type { WebhookTrigger } from "@t3tools/contracts";

const credentials: OAuthCredentials = {
  publicUrl: "https://t3.example.com",
  clientId: "client",
  clientSecret: "client-secret",
  accessToken: "token",
};
const trigger: WebhookTrigger = {
  id: "trigger",
  provider: "linear",
  name: "Linear issues",
  target: "*",
  events: ["Issue", "Comment"],
  actions: ["create"],
  enabled: false,
  prompt: null,
  webhookId: null,
};
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
function requestBody(request: HttpClientRequest.HttpClientRequest): string {
  return request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
}
function httpLayer(
  response: unknown,
  requests: HttpClientRequest.HttpClientRequest[],
  status = 200,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(response), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
    }),
  );
}

it.effect("creates a signed Linear webhook for the requested resources and deletes it", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const id = yield* createRemoteWebhook(trigger, credentials, "signing-secret").pipe(
      Effect.provide(
        httpLayer(
          { data: { webhookCreate: { success: true, webhook: { id: "hook-id" } } } },
          requests,
        ),
      ),
    );
    assert.equal(id, "hook-id");
    const request = requests[0]!;
    assert.equal(request.url, "https://api.linear.app/graphql");
    assert.equal(request.headers.authorization, "Bearer token");
    assert.deepEqual(decodeJson(requestBody(request)), {
      query:
        "mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id } } }",
      variables: {
        input: {
          url: "https://t3.example.com/api/webhooks/trigger",
          label: "T3 Code: Linear issues",
          resourceTypes: ["Issue", "Comment"],
          secret: "signing-secret",
          allPublicTeams: true,
        },
      },
    });
    yield* deleteRemoteWebhook({ ...trigger, webhookId: id }, "token").pipe(
      Effect.provide(httpLayer({ data: { webhookDelete: { success: true } } }, requests)),
    );
    assert.equal(requests.length, 2);
  }),
);

it.effect("requests GitHub event subscriptions with HTTPS signature verification", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const id = yield* createRemoteWebhook(
      { ...trigger, provider: "github", target: "acme/app", events: ["issues"] },
      credentials,
      "signing-secret",
    ).pipe(Effect.provide(httpLayer({ id: 123 }, requests)));
    assert.equal(id, "123");
    assert.equal(requests[0]?.url, "https://api.github.com/repos/acme/app/hooks");
    assert.deepEqual(decodeJson(requestBody(requests[0]!)), {
      name: "web",
      active: true,
      events: ["issues"],
      config: {
        url: "https://t3.example.com/api/webhooks/trigger",
        content_type: "json",
        secret: "signing-secret",
        insecure_ssl: "0",
      },
    });
  }),
);

it.effect("refreshes Linear tokens and rejects grants without webhook administration", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const token = yield* exchangeToken("linear", credentials, {
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    }).pipe(
      Effect.provide(
        httpLayer(
          {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 86400,
            scope: "read admin",
          },
          requests,
        ),
      ),
    );
    assert.equal(token.refresh_token, "new-refresh");
    const params = new URLSearchParams(requestBody(requests[0]!));
    assert.equal(params.get("refresh_token"), "old-refresh");
    assert.equal(params.get("client_secret"), "client-secret");
    const denied = yield* exchangeToken("github", credentials, { code: "code" }).pipe(
      Effect.provide(httpLayer({ access_token: "token", scope: "read:user" }, requests)),
      Effect.result,
    );
    assert.equal(denied._tag, "Failure");
  }),
);

it.effect("re-enables an existing provider webhook when resuming a trigger", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    yield* enableRemoteWebhook({ ...trigger, webhookId: "hook-id" }, "token").pipe(
      Effect.provide(httpLayer({ data: { webhookUpdate: { success: true } } }, requests)),
    );
    assert.deepEqual(decodeJson(requestBody(requests[0]!)), {
      query:
        "mutation($id: String!) { webhookUpdate(id: $id, input: { enabled: true }) { success } }",
      variables: { id: "hook-id" },
    });
    yield* enableRemoteWebhook(
      { ...trigger, provider: "github", target: "acme/app", webhookId: "123" },
      "token",
    ).pipe(Effect.provide(httpLayer({ id: 123 }, requests)));
    assert.equal(requests[1]?.method, "PATCH");
    assert.deepEqual(decodeJson(requestBody(requests[1]!)), { active: true });
  }),
);
