import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  authenticateLocalApiRequest,
  createLocalApiKey,
  isDirectLocalRequest,
  localApiKeyStatus,
  revokeLocalApiKey,
} from "./LocalApiKey.ts";

const localRequest = (
  headers: Record<string, string> = {},
  peer = "127.0.0.1",
  url = "http://localhost/api/local/composer",
) =>
  HttpServerRequest.fromWeb(
    new Request(url, { headers: { host: new URL(url).host, ...headers } }),
  ).modify({ remoteAddress: Option.some(peer) });

it("accepts IPv4 and IPv6 loopback peers and rejects remote or forwarded callers", () => {
  for (const peer of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"])
    assert.isTrue(isDirectLocalRequest(localRequest({}, peer)));
  for (const peer of ["192.168.1.2", "100.64.0.1", "::ffff:10.0.0.1", "localhost", "127.evil"])
    assert.isFalse(isDirectLocalRequest(localRequest({}, peer)));
  for (const header of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "cf-connecting-ip",
    "tailscale-user-login",
    "x-real-ip",
  ])
    assert.isFalse(isDirectLocalRequest(localRequest({ [header]: "127.0.0.1" })));
  assert.isFalse(
    isDirectLocalRequest(
      HttpServerRequest.fromWeb(new Request("http://localhost/api/local/composer")),
    ),
  );
  assert.isFalse(
    isDirectLocalRequest(localRequest({}, "127.0.0.1", "http://remote.example/api/local/composer")),
  );
  assert.isFalse(isDirectLocalRequest(localRequest({ origin: "https://remote.example" })));
  assert.isFalse(isDirectLocalRequest(localRequest({ origin: "null" })));
});

it.layer(NodeServices.layer)("localhost API key", (it) => {
  it.effect("is opt-in, stores only a hash, rotates and revokes immediately", () =>
    Effect.gen(function* () {
      const authenticate = (key?: string) =>
        authenticateLocalApiRequest.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            localRequest(key ? { authorization: `Bearer ${key}` } : {}),
          ),
        );
      assert.deepEqual(yield* localApiKeyStatus, { enabled: false });
      assert.equal((yield* Effect.flip(authenticate()))._tag, "EnvironmentHttpUnauthorizedError");
      const first = yield* createLocalApiKey;
      assert.match(first.key, /^t3_local_[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(yield* localApiKeyStatus, { enabled: true });
      const store = yield* ServerSecretStore.ServerSecretStore;
      const stored = yield* store.get("local-api-key-sha256");
      assert.isTrue(Option.isSome(stored));
      assert.equal(Option.getOrThrow(stored).length, 32);
      yield* authenticate(first.key);
      assert.equal(
        (yield* Effect.flip(authenticate("invalid")))._tag,
        "EnvironmentHttpUnauthorizedError",
      );
      const second = yield* createLocalApiKey;
      assert.notEqual(first.key, second.key);
      assert.equal(
        (yield* Effect.flip(authenticate(first.key)))._tag,
        "EnvironmentHttpUnauthorizedError",
      );
      yield* authenticate(second.key);
      yield* revokeLocalApiKey;
      assert.deepEqual(yield* localApiKeyStatus, { enabled: false });
      assert.equal(
        (yield* Effect.flip(authenticate(second.key)))._tag,
        "EnvironmentHttpUnauthorizedError",
      );
    }).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-api-key-" })),
        ),
      ),
    ),
  );
});
