import { ThreadEnvMode } from "./environment.ts";
import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  UploadChatAttachment,
} from "./orchestration.ts";
import { ServerProvider } from "./server.ts";
import { VcsListRefsResult } from "./git.ts";

export const LocalApiKeyStatus = Schema.Struct({ enabled: Schema.Boolean });
export const LocalApiKeyCreated = Schema.Struct({ key: TrimmedNonEmptyString });

export const LocalComposerQuery = {
  projectId: Schema.optional(ProjectId),
  instanceId: Schema.optional(ProviderInstanceId),
  worktreePath: Schema.optional(TrimmedNonEmptyString),
  refQuery: Schema.optional(TrimmedNonEmptyString),
  refCursor: Schema.optional(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
};
export const LocalComposerOptions = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      id: ProjectId,
      title: Schema.String,
      workspaceRoot: Schema.String,
      defaultModelSelection: Schema.NullOr(ModelSelection),
      defaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
    }),
  ),
  providers: Schema.Array(ServerProvider),
  refs: Schema.NullOr(VcsListRefsResult),
  defaults: Schema.Struct({
    modelSelection: Schema.NullOr(ModelSelection),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    threadEnvMode: ThreadEnvMode,
    newWorktreesStartFromOrigin: Schema.Boolean,
  }),
  runtimeModes: Schema.Array(RuntimeMode),
  interactionModes: Schema.Array(ProviderInteractionMode),
  threadEnvModes: Schema.Array(ThreadEnvMode),
});

export const LocalThreadCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  attachments: Schema.optional(
    Schema.Array(UploadChatAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  ),
  branch: Schema.optional(TrimmedNonEmptyString),
  worktreePath: Schema.optional(TrimmedNonEmptyString),
  createWorktree: Schema.optional(
    Schema.Struct({
      baseBranch: TrimmedNonEmptyString,
      branch: Schema.optional(TrimmedNonEmptyString),
      startFromOrigin: Schema.optional(Schema.Boolean),
    }),
  ),
  runSetupScript: Schema.optional(Schema.Boolean),
});
export type LocalThreadCreateInput = typeof LocalThreadCreateInput.Type;
export const LocalThreadCreated = Schema.Struct({ threadId: ThreadId, sequence: Schema.Number });
