import { CommandId, type ThreadTurnStartCommand } from "@t3tools/contracts";
import { Crypto, Effect, Option } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { dispatchBootstrapTurn } from "../orchestration/bootstrapTurn.ts";

export const makeWebhookTurnDispatcher = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const git = yield* GitWorkflowService;
  const setup = yield* ProjectSetupScriptRunner;
  const deletion = yield* ThreadDeletionReactor;
  const crypto = yield* Crypto.Crypto;
  return Effect.fn("webhooks.dispatchTurn")(function* (
    command: typeof ThreadTurnStartCommand.Type,
  ) {
    const existing = Option.getOrNull(yield* snapshots.getThreadShellById(command.threadId));
    const { bootstrap, ...turn } = command;
    // The final command has a durable receipt. If a crash happened after dispatch,
    // retry it without recreating resources or launching the setup script again.
    if (existing?.latestTurn) return yield* engine.dispatch(turn);
    if (!bootstrap?.prepareWorktree && bootstrap?.createThread?.branch) {
      const project = Option.getOrNull(
        yield* snapshots.getProjectShellById(bootstrap.createThread.projectId),
      );
      if (project)
        yield* git.switchRef({
          cwd: bootstrap.createThread.worktreePath ?? project.workspaceRoot,
          refName: bootstrap.createThread.branch,
        });
    }
    let worktreePath = existing?.worktreePath ?? bootstrap?.createThread?.worktreePath ?? null;
    if (existing && !worktreePath && bootstrap?.prepareWorktree?.branch) {
      // Worktree creation can finish just before a process exits, leaving no
      // metadata update. Recover that checkout by its per-delivery branch name.
      const refs = yield* git.listRefs({
        cwd: bootstrap.prepareWorktree.projectCwd,
        query: bootstrap.prepareWorktree.branch,
        refKind: "local",
        refresh: true,
      });
      const recovered = refs.refs.find(
        (ref) => ref.name === bootstrap.prepareWorktree?.branch && ref.worktreePath,
      );
      if (recovered?.worktreePath) {
        worktreePath = recovered.worktreePath;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`${command.commandId}:recover-worktree`),
          threadId: command.threadId,
          branch: recovered.name,
          worktreePath,
        });
      }
    }
    return yield* dispatchBootstrapTurn(
      {
        ...command,
        bootstrap: {
          ...(existing
            ? {}
            : bootstrap?.createThread
              ? { createThread: bootstrap.createThread }
              : {}),
          ...(!worktreePath && bootstrap?.prepareWorktree
            ? { prepareWorktree: bootstrap.prepareWorktree }
            : {}),
          runSetupScript: bootstrap?.runSetupScript ?? false,
        },
      },
      {
        dispatchFromClient: engine.dispatch,
        threadDeletionReactor: deletion,
        gitWorkflow: git,
        projectSetupScriptRunner: setup,
        refreshGitStatus: git.invalidateStatus,
        crypto,
        retainThreadOnFailure: true,
        // Restore the context needed to run setup after a partially completed job.
        ...(worktreePath
          ? {
              existingWorkspace: {
                projectId: bootstrap?.createThread?.projectId,
                projectCwd: bootstrap?.prepareWorktree?.projectCwd,
                worktreePath,
              },
            }
          : {}),
      },
    );
  });
});
