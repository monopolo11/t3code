import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  WebhookIntegrationProvider,
  WebhookError,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import { WebhookService } from "./WebhookService.ts";

const decodeProvider = Schema.decodeUnknownEffect(WebhookIntegrationProvider);
const isWebhookError = Schema.is(WebhookError);

export const webhookHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "webhooks",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* WebhookService;
    return handlers.handle(
      "operate",
      Effect.fn("webhooks.http.operate")(function* ({ payload }) {
        yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        return yield* service.operate(payload.operation);
      }),
    );
  }),
);

export const webhookPublicRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* WebhookService;
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/api/webhooks/oauth/:provider",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://localhost");
          const provider = yield* decodeProvider(url.pathname.split("/").at(-1));
          yield* service.callback(
            provider,
            url.searchParams.get("state") ?? "",
            url.searchParams.get("code") ?? "",
          );
          return HttpServerResponse.text(
            "Connected. Return to T3 Code → Settings → Integrations and refresh the connections.",
            { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
          );
        }).pipe(
          Effect.catch(() =>
            Effect.succeed(
              HttpServerResponse.text(
                "Sign-in failed or expired. Start again from T3 Code Settings → Integrations.",
                {
                  status: 400,
                  headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
                },
              ),
            ),
          ),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/api/webhooks/:id",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const id = new URL(request.url, "http://localhost").pathname.split("/").at(-1) ?? "";
          const body = new Uint8Array(yield* request.arrayBuffer);
          yield* service.receive(id, request.headers, body);
          return HttpServerResponse.empty({ status: 200 });
        }).pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(2 * 1024 * 1024)),
          Effect.catch((cause) =>
            Effect.succeed(
              HttpServerResponse.text(
                isWebhookError(cause) ? cause.message : "Webhook could not be accepted.",
                { status: isWebhookError(cause) ? 400 : 503 },
              ),
            ),
          ),
        ),
      ),
    );
  }),
);
