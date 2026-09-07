import { WebhookError, type WebhookOperation } from "@t3tools/contracts";
import { Effect, Option, SubscriptionRef } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

export function createWebhookEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    operate: createEnvironmentCommand(runtime, {
      label: "environment:webhooks:operate",
      execute: Effect.fn("webhooks.operate")(function* (payload: WebhookOperation) {
        const supervisor = yield* EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* new WebhookError({ message: "Connect to this machine first." });
        const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
        const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          prepared: prepared.value,
          signer,
          remoteAuthorization,
          method: "POST",
          url: (base) => new URL("/api/integrations/webhooks", base).toString(),
          timeoutMs: 30_000,
          request: ({ client, headers }) =>
            client.webhooks.operate({ payload: { operation: payload }, headers }),
        });
      }),
    }),
  };
}
