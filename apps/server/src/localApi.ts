import {
  type ProjectId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  MessageId,
  ThreadId,
  RuntimeMode,
  ProviderInteractionMode,
  ThreadEnvMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { failEnvironmentInternal } from "./auth/http.ts";
import { ProjectionProjectRepository } from "./persistence/Services/ProjectionProjects.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { T3ProjectFileLoader } from "./project/T3ProjectFileLoader.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { makeDispatchBootstrapTurnStart } from "./orchestration/BootstrapTurnStart.ts";
import {
  normalizeDispatchCommand,
  cleanupFailedUploadedAttachments,
} from "./orchestration/Normalizer.ts";

const badRequest = (message: string) => new EnvironmentHttpBadRequestError({ message });

export const localHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "local",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectionProjectRepository;
    const providers = yield* ProviderRegistry;
    const settings = yield* ServerSettingsService;
    const projectFiles = yield* T3ProjectFileLoader;
    const git = yield* GitWorkflowService;
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const dispatchBootstrap = yield* makeDispatchBootstrapTurnStart(engine.dispatch);

    const getProject = Effect.fn("localApi.getProject")(function* (projectId: ProjectId) {
      const result = yield* projects
        .getById({ projectId })
        .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
      if (Option.isNone(result) || result.value.deletedAt !== null)
        return yield* badRequest("Project was not found.");
      return result.value;
    });

    return handlers
      .handle(
        "composer",
        Effect.fn("localApi.composer")(function* ({ payload }) {
          if (payload.worktreePath && !payload.projectId)
            return yield* badRequest("worktreePath requires projectId.");
          const allProjects = yield* projects
            .listAll()
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          const project = payload.projectId ? yield* getProject(payload.projectId) : undefined;
          const config = yield* settings.getSettings.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          let snapshots = yield* providers.getProviders;
          if (payload.instanceId && !snapshots.some((p) => p.instanceId === payload.instanceId))
            return yield* badRequest("Provider instance was not found.");
          const cwd = payload.worktreePath ?? project?.workspaceRoot;
          if (cwd) {
            // Each refresh returns the whole registry. Read the final aggregate once
            // all targeted workspace probes finish to retain every provider's skills.
            yield* Effect.forEach(
              snapshots.filter(
                (p) =>
                  p.enabled &&
                  p.installed &&
                  (!payload.instanceId || p.instanceId === payload.instanceId),
              ),
              (p) => providers.refreshWorkspaceSnapshot({ instanceId: p.instanceId, cwd }),
              { concurrency: 4, discard: true },
            );
            snapshots = yield* providers.getProviders;
          }
          const projectFile = project
            ? Option.getOrUndefined(yield* projectFiles.load(project.workspaceRoot))
            : undefined;
          const refs = cwd
            ? yield* git
                .listRefs({
                  cwd,
                  ...(payload.refQuery ? { query: payload.refQuery } : {}),
                  ...(payload.refCursor !== undefined ? { cursor: payload.refCursor } : {}),
                  includeMatchingRemoteRefs: true,
                })
                .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)))
            : null;
          return {
            projects: allProjects
              .filter((p) => p.deletedAt === null)
              .map((p) => ({
                id: p.projectId,
                title: p.title,
                workspaceRoot: p.workspaceRoot,
                defaultModelSelection: p.defaultModelSelection,
                defaultThreadEnvMode: p.defaultThreadEnvMode,
              })),
            providers: snapshots.map((p) => ({
              ...p,
              workspaceSnapshots: cwd
                ? (p.workspaceSnapshots?.filter((snapshot) => snapshot.cwd === cwd) ?? [])
                : [],
            })),
            refs,
            defaults: {
              modelSelection: project?.defaultModelSelection ?? config.defaultModelSelection,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              threadEnvMode:
                project?.defaultThreadEnvMode ??
                projectFile?.defaultThreadEnvMode ??
                config.defaultThreadEnvMode,
              newWorktreesStartFromOrigin: config.newWorktreesStartFromOrigin,
            },
            runtimeModes: RuntimeMode.literals,
            interactionModes: ProviderInteractionMode.literals,
            threadEnvModes: ThreadEnvMode.literals,
          };
        }),
      )
      .handle(
        "createThread",
        Effect.fn("localApi.createThread")(function* ({ payload }) {
          const project = yield* getProject(payload.projectId);
          if (payload.createWorktree && (payload.worktreePath || payload.branch))
            return yield* badRequest(
              "createWorktree cannot be combined with branch or worktreePath.",
            );
          const available = yield* providers.getProviders;
          const provider = available.find(
            (p) => p.instanceId === payload.modelSelection.instanceId,
          );
          if (!provider?.enabled || !provider.installed || provider.availability === "unavailable")
            return yield* badRequest("The selected provider is unavailable.");
          const threadId = ThreadId.make(
            yield* crypto.randomUUIDv4.pipe(
              Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
            ),
          );
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const command = {
            type: "thread.turn.start" as const,
            commandId: CommandId.make(`local-api:${threadId}`),
            threadId,
            message: {
              messageId: MessageId.make(`local-api:${threadId}`),
              role: "user" as const,
              text: payload.prompt,
              attachments: payload.attachments ?? [],
            },
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            createdAt,
            bootstrap: {
              createThread: {
                projectId: project.projectId,
                title: payload.title,
                modelSelection: payload.modelSelection,
                runtimeMode: payload.runtimeMode,
                interactionMode: payload.interactionMode,
                branch: payload.branch ?? null,
                worktreePath: payload.worktreePath ?? null,
                createdAt,
              },
              ...(payload.createWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: project.workspaceRoot,
                      ...payload.createWorktree,
                    },
                  }
                : {}),
              ...(payload.runSetupScript !== undefined
                ? { runSetupScript: payload.runSetupScript }
                : {}),
            },
          };
          const normalized = yield* normalizeDispatchCommand(command).pipe(
            Effect.catch((cause) => badRequest(cause.message)),
          );
          if (normalized.type !== "thread.turn.start")
            return yield* badRequest("Invalid turn command.");
          const result = yield* dispatchBootstrap(normalized).pipe(
            Effect.tapError(() => cleanupFailedUploadedAttachments(command, normalized)),
            Effect.catch((cause) => badRequest(cause.message)),
          );
          return { threadId, sequence: result.sequence };
        }),
      );
  }),
);
