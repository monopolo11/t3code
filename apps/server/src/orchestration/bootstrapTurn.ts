import {
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
  type ThreadId,
  type ProjectId,
} from "@t3tools/contracts";
import { Cause, Crypto, DateTime, Effect, Schema } from "effect";
import type { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import type { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";
import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";

const isDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export interface BootstrapTurnDependencies {
  readonly dispatchFromClient: OrchestrationEngineService["Service"]["dispatch"];
  readonly threadDeletionReactor: ThreadDeletionReactor["Service"];
  readonly gitWorkflow: GitWorkflowService["Service"];
  readonly projectSetupScriptRunner: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
  readonly crypto: Crypto.Crypto;
  /** Durable jobs retain partially prepared threads for their next attempt. */
  readonly retainThreadOnFailure?: boolean;
  readonly existingWorkspace?: {
    readonly projectId?: ProjectId | undefined;
    readonly projectCwd?: string | undefined;
    readonly worktreePath: string;
  };
}

/** First-turn setup shared by interactive clients and durable webhook jobs. */
export const dispatchBootstrapTurn = Effect.fn("orchestration.dispatchBootstrapTurn")(function* (
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  dependencies: BootstrapTurnDependencies,
) {
  const {
    dispatchFromClient,
    threadDeletionReactor,
    gitWorkflow,
    projectSetupScriptRunner,
    refreshGitStatus,
    crypto,
  } = dependencies;
  const isOrchestrationDispatchCommandError = isDispatchCommandError;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationDispatchCommandError({
          message: "Failed to generate orchestration command identifier.",
          cause,
        }),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.all({
      commandId: serverCommandId("setup-script-activity"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        dispatchFromClient({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return isOrchestrationDispatchCommandError(error)
      ? error
      : new OrchestrationDispatchCommandError({
          message:
            error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
          cause,
        });
  };

  const bootstrap = command.bootstrap;
  const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
  let createdThread = false;
  let targetProjectId =
    bootstrap?.createThread?.projectId ?? dependencies.existingWorkspace?.projectId;
  let targetProjectCwd =
    bootstrap?.prepareWorktree?.projectCwd ?? dependencies.existingWorkspace?.projectCwd;
  let targetWorktreePath =
    bootstrap?.createThread?.worktreePath ?? dependencies.existingWorkspace?.worktreePath ?? null;

  const cleanupCreatedThread = () =>
    createdThread
      ? serverCommandId("bootstrap-thread-delete").pipe(
          Effect.flatMap((commandId) =>
            dispatchFromClient({
              type: "thread.delete",
              commandId,
              threadId: command.threadId,
            }),
          ),
          Effect.as(true),
        )
      : Effect.succeed(false);

  const recordSetupScriptLaunchFailure = (input: {
    readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
    readonly requestedAt: string;
    readonly worktreePath: string;
  }) => {
    const detail = projectSetupScriptCompatibilityDetail(input.error);
    return appendSetupScriptActivity({
      threadId: command.threadId,
      kind: "setup-script.failed",
      summary: "Setup script failed to start",
      createdAt: input.requestedAt,
      payload: {
        detail,
        worktreePath: input.worktreePath,
      },
      tone: "error",
    }).pipe(
      Effect.ignoreCause({ log: false }),
      Effect.flatMap(() =>
        Effect.logWarning("bootstrap turn start failed to launch setup script", {
          threadId: command.threadId,
          worktreePath: input.worktreePath,
          detail,
        }),
      ),
    );
  };

  const recordSetupScriptStarted = (input: {
    readonly requestedAt: string;
    readonly worktreePath: string;
    readonly scriptId: string;
    readonly scriptName: string;
    readonly terminalId: string;
  }) =>
    Effect.gen(function* () {
      const startedAt = yield* nowIso;
      const payload = {
        scriptId: input.scriptId,
        scriptName: input.scriptName,
        terminalId: input.terminalId,
        worktreePath: input.worktreePath,
      };
      yield* Effect.all([
        appendSetupScriptActivity({
          threadId: command.threadId,
          kind: "setup-script.requested",
          summary: "Starting setup script",
          createdAt: input.requestedAt,
          payload,
          tone: "info",
        }),
        appendSetupScriptActivity({
          threadId: command.threadId,
          kind: "setup-script.started",
          summary: "Setup script started",
          createdAt: startedAt,
          payload,
          tone: "info",
        }),
      ]).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logWarning(
            "bootstrap turn start launched setup script but failed to record setup activity",
            {
              threadId: command.threadId,
              worktreePath: input.worktreePath,
              scriptId: input.scriptId,
              terminalId: input.terminalId,
              detail: error.message,
            },
          ),
        ),
      );
    });

  const runSetupProgram = () =>
    Effect.gen(function* () {
      if (!bootstrap?.runSetupScript || !targetWorktreePath) {
        return;
      }
      const worktreePath = targetWorktreePath;
      const requestedAt = yield* nowIso;
      yield* projectSetupScriptRunner
        .runForThread({
          threadId: command.threadId,
          ...(targetProjectId ? { projectId: targetProjectId } : {}),
          ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
          worktreePath,
        })
        .pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              recordSetupScriptLaunchFailure({
                error,
                requestedAt,
                worktreePath,
              }),
            onSuccess: (setupResult) => {
              if (setupResult.status !== "started") {
                return Effect.void;
              }
              return recordSetupScriptStarted({
                requestedAt,
                worktreePath,
                scriptId: setupResult.scriptId,
                scriptName: setupResult.scriptName,
                terminalId: setupResult.terminalId,
              });
            },
          }),
        );
    });

  const bootstrapProgram = Effect.gen(function* () {
    if (bootstrap?.createThread) {
      const created = yield* dispatchFromClient({
        type: "thread.create",
        commandId: yield* serverCommandId("bootstrap-thread-create"),
        threadId: command.threadId,
        projectId: bootstrap.createThread.projectId,
        title: bootstrap.createThread.title,
        modelSelection: bootstrap.createThread.modelSelection,
        runtimeMode: bootstrap.createThread.runtimeMode,
        interactionMode: bootstrap.createThread.interactionMode,
        branch: bootstrap.createThread.branch,
        worktreePath: bootstrap.createThread.worktreePath,
        createdAt: bootstrap.createThread.createdAt,
      });
      // The successful create is a fence in the engine command queue:
      // every delete for the prior incarnation committed before it.
      // Drain through that event before setup or turn start can own
      // terminals and provider sessions under the reused thread id.
      yield* threadDeletionReactor.drainThrough(created.sequence);
      createdThread = true;
    }

    if (bootstrap?.prepareWorktree) {
      let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
      // "Start from origin" is a stored default; repos without the
      // requested remote branch fall back to the local base branch.
      const startFromOrigin =
        bootstrap.prepareWorktree.startFromOrigin === true &&
        (yield* gitWorkflow.remoteExists({
          cwd: bootstrap.prepareWorktree.projectCwd,
          remoteName: "origin",
        }));
      if (startFromOrigin) {
        yield* gitWorkflow.fetchRemote({
          cwd: bootstrap.prepareWorktree.projectCwd,
          remoteName: "origin",
        });
        const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
          cwd: bootstrap.prepareWorktree.projectCwd,
          refName: bootstrap.prepareWorktree.baseBranch,
          remoteName: "origin",
        });
        if (remoteBaseExists) {
          const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd: bootstrap.prepareWorktree.projectCwd,
            refName: bootstrap.prepareWorktree.baseBranch,
            fallbackRemoteName: "origin",
          });
          worktreeBaseRef = resolvedRemoteBase.commitSha;
        }
      }
      const worktree = yield* gitWorkflow.createWorktree({
        cwd: bootstrap.prepareWorktree.projectCwd,
        refName: worktreeBaseRef,
        newRefName: bootstrap.prepareWorktree.branch,
        baseRefName: bootstrap.prepareWorktree.baseBranch,
        path: null,
      });
      targetWorktreePath = worktree.worktree.path;
      yield* dispatchFromClient({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
        threadId: command.threadId,
        branch: worktree.worktree.refName,
        worktreePath: targetWorktreePath,
      });
      yield* refreshGitStatus(targetWorktreePath);
    }

    yield* runSetupProgram();

    return yield* dispatchFromClient(finalTurnStartCommand);
  });

  return yield* bootstrapProgram.pipe(
    Effect.catchCause((cause) => {
      const dispatchError = toBootstrapDispatchCommandCauseError(cause);
      if (Cause.hasInterruptsOnly(cause) || dependencies.retainThreadOnFailure) {
        return Effect.fail(dispatchError);
      }
      return Effect.uninterruptible(cleanupCreatedThread()).pipe(
        Effect.matchCauseEffect({
          onFailure: (cleanupCause) =>
            Effect.logWarning("bootstrap thread cleanup failed", {
              threadId: command.threadId,
              detail: Cause.pretty(cleanupCause),
            }).pipe(Effect.flatMap(() => Effect.fail(dispatchError))),
          onSuccess: (threadDeleted) =>
            Effect.fail(
              threadDeleted
                ? new OrchestrationDispatchCommandError({
                    message: dispatchError.message,
                    ...(dispatchError.cause !== undefined ? { cause: dispatchError.cause } : {}),
                    bootstrapThreadDisposition: "deleted",
                  })
                : dispatchError,
            ),
        }),
      );
    }),
  );
});

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      throw new Error(`Unhandled compatibility error: ${String(error)}`);
  }
}
