import { EnvironmentId, type ChatAttachment, type WebhookTrigger } from "@t3tools/contracts";
import { Schema } from "effect";
import { renderWebhookPrompt } from "@t3tools/shared/webhookTemplate";
import { webhookEnvironment } from "../state/webhooks";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import ChatView from "../components/ChatView";
import { resolveDraftPromotionNavigationTarget } from "../components/ChatView.logic";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { waitForDraftHeroTransition } from "../components/chat/draftHeroTransition";
import { buildThreadRouteParams } from "../threadRoutes";
import { useThread, useThreadRefs } from "../state/entities";

const decodeSamplePayload = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const search = Route.useSearch();
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const storedTriggerId = draftSession?.logicalProjectKey.startsWith("webhook:")
    ? draftSession.logicalProjectKey.slice("webhook:".length)
    : undefined;
  const triggerId = storedTriggerId ?? search.webhookTrigger;
  const ownerEnvironmentId = search.webhookEnvironment ?? draftSession?.environmentId;
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThread(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(serverThreadRef);
  const canonicalThreadRef = resolveDraftPromotionNavigationTarget({
    serverThreadRef,
    serverThread,
    backgroundSubmissionPending,
  });

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }

    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (!draftSession) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {triggerId && ownerEnvironmentId ? (
        <WebhookDraft
          draftId={draftId}
          triggerId={triggerId}
          ownerEnvironmentId={EnvironmentId.make(ownerEnvironmentId)}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
        />
      ) : (
        <ChatView
          draftId={draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          forceExpandedMobileComposer
        />
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
  validateSearch: (
    search: Record<string, unknown>,
  ): { webhookTrigger?: string; webhookEnvironment?: string } =>
    typeof search.webhookTrigger === "string" && typeof search.webhookEnvironment === "string"
      ? { webhookTrigger: search.webhookTrigger, webhookEnvironment: search.webhookEnvironment }
      : {},
});

function WebhookDraft({
  draftId,
  triggerId,
  ownerEnvironmentId,
  environmentId,
  threadId,
}: {
  draftId: DraftId;
  triggerId: string;
  ownerEnvironmentId: EnvironmentId;
  environmentId: EnvironmentId;
  threadId: import("@t3tools/contracts").ThreadId;
}) {
  const operate = useAtomCommand(webhookEnvironment.operate, { reportFailure: false });
  const [trigger, setTrigger] = useState<WebhookTrigger | null>(null);
  const [attachments, setAttachments] = useState<readonly ChatAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState('{"action":"opened","issue":{"title":"Example issue"}}');
  const prompt = useComposerDraftStore((store) => store.getComposerDraft(draftId)?.prompt ?? "");
  useEffect(() => {
    let cancelled = false;
    void operate({ environmentId: ownerEnvironmentId, input: { type: "list" } }).then((result) => {
      if (cancelled) return;
      const found =
        result._tag === "Success"
          ? result.value.state.triggers.find((item) => item.id === triggerId)
          : null;
      if (!found) {
        setError("Could not load this trigger. Return to Settings and reconnect to its machine.");
        return;
      }
      setTrigger(found);
      setAttachments(
        (found.prompt?.attachments ?? []).filter(
          (attachment): attachment is ChatAttachment => "id" in attachment,
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [operate, ownerEnvironmentId, triggerId]);
  let preview: string;
  try {
    preview = renderWebhookPrompt(prompt, decodeSamplePayload(sample));
  } catch (cause) {
    preview = cause instanceof Error ? cause.message : "Enter a valid JSON payload.";
  }
  return (
    <>
      <div className="space-y-2 border-b bg-muted/30 px-5 py-3 text-sm">
        <div className="flex items-center justify-between">
          <strong>{trigger ? `Trigger: ${trigger.name}` : "Loading trigger…"}</strong>
          <Link to="/settings/integrations" className="text-primary underline">
            Back to integrations
          </Link>
        </div>
        <p>
          Compose the prompt below, then save it with the save button or your usual send shortcut.
          Each matching event starts a new thread.
        </p>
        <p className="text-xs text-muted-foreground">
          Use {"{{payload}}"} for the full event or a JSON path such as {"{{payload.issue.title}}"}{" "}
          (GitHub) or {"{{payload.data.title}}"} (Linear). Missing fields fail the delivery.
        </p>
        {attachments.map((attachment) => (
          <span
            key={attachment.id}
            className="mr-2 inline-flex items-center gap-2 rounded border px-2 text-xs"
          >
            {attachment.name}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${attachment.name}`}
              onClick={() =>
                setAttachments((current) => current.filter((item) => item.id !== attachment.id))
              }
            >
              ×
            </Button>
          </span>
        ))}
        <details>
          <summary className="cursor-pointer text-xs">
            Preview template with an event payload
          </summary>
          <label className="mt-2 grid gap-1 text-xs">
            Sample event JSON
            <textarea
              className="h-24 rounded border bg-background p-2 font-mono"
              value={sample}
              onChange={(event) => setSample(event.target.value)}
            />
          </label>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{preview}</pre>
        </details>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
      {trigger && (
        <ChatView
          draftId={draftId}
          environmentId={environmentId}
          threadId={threadId}
          routeKind="draft"
          forceExpandedMobileComposer
          webhookTrigger={{ id: triggerId, environmentId: ownerEnvironmentId, attachments }}
        />
      )}
    </>
  );
}
