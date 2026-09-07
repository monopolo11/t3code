import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import {
  EnvironmentHttpForbiddenError,
  EnvironmentHttpUnauthorizedError,
  LocalApiAuth,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerSecretStore } from "./ServerSecretStore.ts";
import { failEnvironmentInternal } from "./http.ts";

const SECRET_NAME = "local-api-key-sha256";
const hashKey = (key: string) => NodeCrypto.createHash("sha256").update(key).digest();

export const localApiKeyStatus = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  return { enabled: Option.isSome(yield* secrets.get(SECRET_NAME)) };
});

export const createLocalApiKey = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const secrets = yield* ServerSecretStore;
  const key = `t3_local_${Buffer.from(yield* crypto.randomBytes(32)).toString("base64url")}`;
  yield* secrets.set(SECRET_NAME, hashKey(key));
  return { key };
});

export const revokeLocalApiKey = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  yield* secrets.remove(SECRET_NAME);
  return { enabled: false };
});

export const isLoopbackAddress = (address: string): boolean => {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "::1" || (NodeNet.isIP(normalized) === 4 && normalized.startsWith("127."));
};

// Never use forwarded addresses as proof of locality. These routes require a
// direct loopback connection, including when a local tunnel fronts the server.
export const isDirectLocalRequest = (request: HttpServerRequest.HttpServerRequest): boolean => {
  if (Option.isNone(request.remoteAddress) || !isLoopbackAddress(request.remoteAddress.value))
    return false;
  if (
    Object.keys(request.headers).some(
      (header) =>
        header === "forwarded" ||
        header.startsWith("x-forwarded-") ||
        header.startsWith("cf-") ||
        header.startsWith("tailscale-") ||
        header === "x-real-ip",
    )
  )
    return false;
  if (!request.headers.host) return false;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return false;
  const hostname = url.value.hostname.replace(/^\[|\]$/g, "");
  if (hostname !== "localhost" && !isLoopbackAddress(hostname)) return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      const originHost = new URL(origin).hostname.replace(/^\[|\]$/g, "");
      if (originHost !== "localhost" && !isLoopbackAddress(originHost)) return false;
    } catch {
      return false;
    }
  }
  return true;
};

export const authenticateLocalApiRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!isDirectLocalRequest(request)) {
    return yield* new EnvironmentHttpForbiddenError({
      message: "This API requires a direct localhost connection.",
    });
  }
  const secrets = yield* ServerSecretStore;
  const stored = yield* secrets
    .get(SECRET_NAME)
    .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
  const credential = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (
    !credential ||
    Option.isNone(stored) ||
    stored.value.length !== 32 ||
    !NodeCrypto.timingSafeEqual(stored.value, hashKey(credential))
  ) {
    return yield* new EnvironmentHttpUnauthorizedError({
      message: "A valid localhost API key is required.",
    });
  }
  yield* HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
  );
});

export const localApiAuthLayer = Layer.effect(
  LocalApiAuth,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    return (httpEffect) =>
      authenticateLocalApiRequest.pipe(
        Effect.provideService(ServerSecretStore, secrets),
        Effect.andThen(httpEffect),
      );
  }),
);
