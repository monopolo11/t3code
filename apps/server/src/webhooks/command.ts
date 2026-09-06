import {
  CommandId,
  MessageId,
  ThreadId,
  type ClientOrchestrationCommand,
  type WebhookTrigger,
} from "@t3tools/contracts";

/** A delivery always gets fresh thread/worktree identities; retries keep the same command identity. */
export function webhookTurnCommand(
  trigger: WebhookTrigger,
  id: string,
  text: string,
  projectCwd: string,
  createdAt: string,
): Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }> {
  const prompt = trigger.prompt;
  if (!prompt) throw new Error("Compose a prompt before enabling this trigger.");
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(`webhook-${id}`),
    threadId: ThreadId.make(`webhook-${id}`),
    message: {
      messageId: MessageId.make(`webhook-${id}`),
      role: "user",
      text,
      attachments: prompt.attachments,
    },
    modelSelection: prompt.modelSelection,
    runtimeMode: prompt.runtimeMode,
    interactionMode: prompt.interactionMode,
    createdAt,
    bootstrap: {
      createThread: {
        projectId: prompt.projectId,
        title: trigger.name,
        modelSelection: prompt.modelSelection,
        runtimeMode: prompt.runtimeMode,
        interactionMode: prompt.interactionMode,
        branch: prompt.branch,
        worktreePath: prompt.worktreePath,
        createdAt,
      },
      ...(prompt.baseBranch
        ? {
            prepareWorktree: {
              projectCwd,
              baseBranch: prompt.baseBranch,
              branch: `t3/webhook-${id}`,
              startFromOrigin: prompt.startFromOrigin,
            },
            runSetupScript: prompt.runSetupScript,
          }
        : {}),
    },
  };
}
