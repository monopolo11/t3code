import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../orchestration/Services/ThreadDeletionReactor.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { makeWebhookTurnDispatcher } from "./dispatch.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const shell: OrchestrationThreadShell = {
  id: ThreadId.make("webhook-delivery"),
  projectId: ProjectId.make("project"),
  title: "Trigger",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const command: typeof ThreadTurnStartCommand.Type = {
  type: "thread.turn.start",
  commandId: CommandId.make("delivery"),
  threadId: shell.id,
  message: {
    messageId: MessageId.make("message"),
    role: "user",
    text: "Fix issue",
    attachments: [],
  },
  runtimeMode: shell.runtimeMode,
  interactionMode: shell.interactionMode,
  createdAt,
  bootstrap: {
    createThread: {
      projectId: shell.projectId,
      title: shell.title,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: "main",
      worktreePath: null,
      createdAt,
    },
    prepareWorktree: {
      projectCwd: "/project",
      baseBranch: "main",
      branch: "t3/webhook-delivery",
      startFromOrigin: true,
    },
    runSetupScript: true,
  },
};

const run = (existing: OrchestrationThreadShell, recoveredPath: string | null) =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const setups: string[] = [];
    const dispatch = yield* makeWebhookTurnDispatcher.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (input) =>
              Effect.sync(() => {
                commands.push(input);
                return { sequence: commands.length };
              }),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: () => Effect.succeed(Option.some(existing)),
          }),
          Layer.mock(ThreadDeletionReactor)({}),
          Layer.mock(GitWorkflowService)({
            listRefs: () =>
              Effect.succeed({
                refs: [
                  {
                    name: "t3/webhook-delivery",
                    current: false,
                    isDefault: false,
                    worktreePath: recoveredPath,
                  },
                ],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            invalidateStatus: () => Effect.void,
          }),
          Layer.mock(ProjectSetupScriptRunner)({
            runForThread: (input) =>
              Effect.sync(() => {
                setups.push(input.worktreePath);
                return { status: "no-script" as const };
              }),
          }),
        ),
      ),
    );
    yield* dispatch(command);
    return { commands, setups };
  });

it.effect("resumes an existing checkout without creating another thread or worktree", () =>
  Effect.gen(function* () {
    const result = yield* run({ ...shell, worktreePath: "/existing" }, null);
    assert.deepEqual(
      result.commands.map((c) => c.type),
      ["thread.turn.start"],
    );
    assert.deepEqual(result.setups, ["/existing"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("recovers a worktree created before the metadata update was persisted", () =>
  Effect.gen(function* () {
    const result = yield* run(shell, "/recovered");
    assert.deepEqual(
      result.commands.map((c) => c.type),
      ["thread.meta.update", "thread.turn.start"],
    );
    assert.deepEqual(result.setups, ["/recovered"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("replays only the receipt-protected final command after a turn was already started", () =>
  Effect.gen(function* () {
    const result = yield* run(
      {
        ...shell,
        latestTurn: {
          turnId: TurnId.make("turn"),
          state: "running",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: null,
          assistantMessageId: null,
        },
      },
      null,
    );
    assert.deepEqual(
      result.commands.map((c) => c.type),
      ["thread.turn.start"],
    );
    assert.deepEqual(result.setups, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("switches a local checkout to the saved branch before dispatching", () =>
  Effect.gen(function* () {
    const order: string[] = [];
    const dispatch = yield* makeWebhookTurnDispatcher.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            dispatch: () =>
              Effect.sync(() => {
                order.push("turn");
                return { sequence: 1 };
              }),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: () => Effect.succeed(Option.some(shell)),
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  id: shell.projectId,
                  title: "Project",
                  workspaceRoot: "/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt,
                  updatedAt: createdAt,
                }),
              ),
          }),
          Layer.mock(ThreadDeletionReactor)({}),
          Layer.mock(GitWorkflowService)({
            switchRef: (input) =>
              Effect.sync(() => {
                order.push(`${input.cwd}:${input.refName}`);
                return { refName: input.refName };
              }),
          }),
          Layer.mock(ProjectSetupScriptRunner)({}),
        ),
      ),
    );
    yield* dispatch({ ...command, bootstrap: { createThread: command.bootstrap!.createThread! } });
    assert.deepEqual(order, ["/project:main", "turn"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
