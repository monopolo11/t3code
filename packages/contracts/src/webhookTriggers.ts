import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ChatAttachment,
  UploadChatAttachment,
  RuntimeMode,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./orchestration.ts";
import { ModelSelection, ProviderInteractionMode } from "./orchestration.ts";

export const WebhookIntegrationProvider = Schema.Literals(["github", "linear"]);
export type WebhookIntegrationProvider = typeof WebhookIntegrationProvider.Type;
export const WEBHOOK_EVENTS = {
  github: [
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "push",
    "release",
    "workflow_run",
    "check_run",
    "check_suite",
    "create",
    "delete",
    "discussion",
    "discussion_comment",
  ],
  linear: [
    "Issue",
    "Comment",
    "IssueLabel",
    "Project",
    "ProjectUpdate",
    "Cycle",
    "Reaction",
    "Document",
    "Initiative",
    "InitiativeUpdate",
    "Customer",
    "CustomerRequest",
    "User",
  ],
} as const;

export const WebhookPrompt = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  attachments: Schema.Array(Schema.Union([ChatAttachment, UploadChatAttachment])).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  startFromOrigin: Schema.Boolean,
  runSetupScript: Schema.Boolean,
});
export type WebhookPrompt = typeof WebhookPrompt.Type;
export const WebhookTrigger = Schema.Struct({
  id: Schema.String,
  provider: WebhookIntegrationProvider,
  name: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  events: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  actions: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(30)),
  enabled: Schema.Boolean,
  prompt: Schema.NullOr(WebhookPrompt),
  webhookId: Schema.NullOr(Schema.String),
});
export type WebhookTrigger = typeof WebhookTrigger.Type;
export const WebhookIntegrationStatus = Schema.Struct({
  provider: WebhookIntegrationProvider,
  publicUrl: Schema.String,
  clientId: Schema.String,
  connected: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
});
export const WebhookDelivery = Schema.Struct({
  id: Schema.String,
  triggerId: Schema.String,
  threadId: ThreadId,
  status: Schema.Literals(["pending", "started", "failed"]),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export const WebhookState = Schema.Struct({
  integrations: Schema.Array(WebhookIntegrationStatus),
  triggers: Schema.Array(WebhookTrigger),
  deliveries: Schema.Array(WebhookDelivery),
});
export type WebhookState = typeof WebhookState.Type;
export const WebhookOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("list") }),
  Schema.Struct({
    type: Schema.Literal("connect"),
    provider: WebhookIntegrationProvider,
    publicUrl: TrimmedNonEmptyString,
    clientId: TrimmedNonEmptyString,
    clientSecret: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("disconnect"), provider: WebhookIntegrationProvider }),
  Schema.Struct({
    type: Schema.Literal("create"),
    provider: WebhookIntegrationProvider,
    name: TrimmedNonEmptyString,
    target: TrimmedNonEmptyString,
    events: Schema.Array(TrimmedNonEmptyString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(30),
    ),
    actions: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(30)),
  }),
  Schema.Struct({ type: Schema.Literal("savePrompt"), id: Schema.String, prompt: WebhookPrompt }),
  Schema.Struct({ type: Schema.Literal("setEnabled"), id: Schema.String, enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("delete"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("retry"), id: Schema.String }),
]);
export type WebhookOperation = typeof WebhookOperation.Type;
export const WebhookOperationResult = Schema.Struct({
  state: WebhookState,
  authorizationUrl: Schema.optionalKey(Schema.String),
  triggerId: Schema.optionalKey(Schema.String),
});
export class WebhookError extends Schema.TaggedErrorClass<WebhookError>()(
  "WebhookError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
