import * as Effect from "effect/Effect";
import { runPrimaryHttp } from "../../lib/runtime";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

export const getLocalApiKeyStatus = () =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.auth.localApiKeyStatus({ headers: {} })),
    ),
  );
export const generateLocalApiKey = () =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.auth.createLocalApiKey({ headers: {} })),
    ),
  );
export const revokeLocalApiKey = () =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.auth.revokeLocalApiKey({ headers: {} })),
    ),
  );
