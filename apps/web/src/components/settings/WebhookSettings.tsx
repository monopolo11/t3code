import { resolveDefaultThreadEnvMode } from "@t3tools/shared/threadEnvMode";
import { readT3ProjectFileDefaultThreadEnvMode } from "../../lib/t3ProjectFileDefaults";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";
import { useNavigate, Link } from "@tanstack/react-router";
import {
  EnvironmentId,
  ProjectId,
  WEBHOOK_EVENTS,
  type WebhookIntegrationProvider,
  type WebhookOperation,
  type WebhookState,
  type WebhookTrigger,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { webhookEnvironment } from "../../state/webhooks";
import { useComposerDraftStore } from "../../composerDraftStore";
import { newDraftId } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export function WebhookSettings() {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const environmentId = selectedId ?? primaryId;
  return (
    <SettingsSection id="webhook-triggers" title="Webhook triggers">
      <div className="space-y-4 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Start a new thread when GitHub or Linear sends an event. Keep this machine and its
          Cloudflare tunnel running.
        </p>
        <label className="grid gap-1 text-sm">
          Default machine
          <select
            className={selectClass}
            value={environmentId ?? ""}
            onChange={(e) => setSelectedId(EnvironmentId.make(e.target.value))}
          >
            <option value="" disabled>
              Choose a machine
            </option>
            {environments.map((env) => (
              <option key={env.environmentId} value={env.environmentId}>
                {env.label}
              </option>
            ))}
          </select>
        </label>
        {environmentId && <MachineWebhooks key={environmentId} environmentId={environmentId} />}
      </div>
    </SettingsSection>
  );
}

function MachineWebhooks({ environmentId }: { environmentId: EnvironmentId }) {
  const operate = useAtomCommand(webhookEnvironment.operate, { reportFailure: false });
  const navigate = useNavigate();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [state, setState] = useState<WebhookState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<WebhookIntegrationProvider>("github");
  const [publicUrl, setPublicUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [actions, setActions] = useState("");
  const [projectId, setProjectId] = useState("");
  const connection = state?.integrations.find((item) => item.provider === provider);
  const run = async (input: WebhookOperation) => {
    setBusy(true);
    setError(null);
    try {
      const result = await operate({ environmentId, input });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error ? cause.message : "Could not complete the webhook operation.",
        );
        return null;
      }
      setState(result.value.state);
      return result.value;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    void operate({ environmentId, input: { type: "list" } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setState(result.value.state);
      else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not load integrations.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, operate]);

  const compose = async (trigger: WebhookTrigger) => {
    const project =
      projects.find((p) => p.id === (trigger.prompt?.projectId ?? projectId)) ?? projects[0];
    if (!project) {
      setError("Add a project on this machine before composing a trigger.");
      return;
    }
    const settings = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.settings;
    const envMode = trigger.prompt
      ? trigger.prompt.baseBranch
        ? "worktree"
        : "local"
      : resolveDefaultThreadEnvMode({
          projectSetting: project.defaultThreadEnvMode,
          projectFile:
            project.defaultThreadEnvMode == null
              ? await readT3ProjectFileDefaultThreadEnvMode(environmentId, project.workspaceRoot)
              : null,
          globalDefault: settings?.defaultThreadEnvMode ?? "local",
        });
    const draftId = newDraftId();
    const store = useComposerDraftStore.getState();
    store.setLogicalProjectDraftThreadId(
      `webhook:${trigger.id}`,
      scopeProjectRef(environmentId, project.id),
      draftId,
      {
        envMode,
        branch: trigger.prompt?.baseBranch ?? trigger.prompt?.branch ?? null,
        worktreePath: trigger.prompt?.worktreePath ?? null,
        startFromOrigin:
          trigger.prompt?.startFromOrigin ?? settings?.newWorktreesStartFromOrigin ?? true,
        environmentSelection: "manual",
        ...(trigger.prompt
          ? {
              runtimeMode: trigger.prompt.runtimeMode,
              interactionMode: trigger.prompt.interactionMode,
            }
          : {}),
      },
    );
    store.applyStickyState(draftId);
    store.setPrompt(
      draftId,
      trigger.prompt?.text ??
        (trigger.provider === "github"
          ? "Handle this GitHub event:\n{{payload}}"
          : "Handle this Linear event:\n{{payload}}"),
    );
    if (trigger.prompt) {
      store.setModelSelection(draftId, trigger.prompt.modelSelection, { replaceOptions: true });
      store.setRuntimeMode(draftId, trigger.prompt.runtimeMode);
      store.setInteractionMode(draftId, trigger.prompt.interactionMode);
    }
    void navigate({
      to: "/draft/$draftId",
      params: { draftId },
      search: { webhookTrigger: trigger.id, webhookEnvironment: environmentId },
    });
  };

  return (
    <div className="space-y-5">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <label className="grid flex-1 gap-1 text-sm">
          Integration
          <select
            className={selectClass}
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value === "linear" ? "linear" : "github");
              setEvents([]);
              setTarget("");
              setActions("");
              setClientId("");
              setClientSecret("");
              setAuthorizationUrl(null);
            }}
          >
            <option value="github">GitHub</option>
            <option value="linear">Linear</option>
          </select>
        </label>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void run({ type: "list" });
          }}
        >
          Refresh
        </Button>
      </div>
      <details className="rounded-lg border p-4" open={!connection?.connected}>
        <summary className="cursor-pointer text-sm font-medium">
          {connection?.connected
            ? `Connected to ${connection.account}`
            : `Connect ${provider === "github" ? "GitHub" : "Linear"}`}
        </summary>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run({
              type: "connect",
              provider,
              publicUrl: publicUrl || connection?.publicUrl || "",
              clientId: clientId || connection?.clientId || "",
              clientSecret,
            }).then((result) => {
              if (result?.authorizationUrl) {
                setAuthorizationUrl(result.authorizationUrl);
                setClientSecret("");
              }
            });
          }}
        >
          <label className="grid gap-1 text-sm">
            Public Cloudflare tunnel URL
            <Input
              required
              type="url"
              placeholder="https://t3.example.com"
              value={publicUrl || connection?.publicUrl || ""}
              onChange={(e) => setPublicUrl(e.target.value)}
            />
          </label>
          <p className="break-all text-xs text-muted-foreground">
            Register this OAuth callback URL:{" "}
            {(publicUrl || connection?.publicUrl || "https://t3.example.com").replace(/\/$/, "")}
            /api/webhooks/oauth/{provider}
          </p>
          <label className="grid gap-1 text-sm">
            OAuth client ID
            <Input
              required
              value={clientId || connection?.clientId || ""}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-sm">
            OAuth client secret
            <Input
              required
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {provider === "github"
              ? "Requests access to manage repository webhooks and read your profile. You need admin access to the repository."
              : "Requests read and admin access, required by Linear to manage webhooks."}
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Sign in with {provider === "github" ? "GitHub" : "Linear"}
            </Button>
            {connection?.connected && (
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => {
                  void run({ type: "disconnect", provider });
                }}
              >
                Disconnect
              </Button>
            )}
          </div>
          {authorizationUrl && (
            <a
              className="text-sm text-primary underline"
              href={authorizationUrl}
              target="_blank"
              rel="noreferrer"
            >
              Continue OAuth sign-in, then return here and refresh
            </a>
          )}
        </form>
      </details>
      {connection?.connected && (
        <form
          className="grid gap-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run({
              type: "create",
              provider,
              name,
              target,
              events,
              actions: actions
                .split(",")
                .map((action) => action.trim())
                .filter(Boolean),
            }).then((result) => {
              const trigger = result?.state.triggers.find((t) => t.id === result.triggerId);
              if (trigger) void compose(trigger);
            });
          }}
        >
          <h3 className="text-sm font-medium">Create trigger</h3>
          <label className="grid gap-1 text-sm">
            Name
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Investigate new issues"
            />
          </label>
          <label className="grid gap-1 text-sm">
            {provider === "github"
              ? "Repository (owner/repository)"
              : "Linear team UUID (* for all public teams)"}
            <Input
              required
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={provider === "github" ? "acme/app" : "*"}
            />
          </label>
          <fieldset>
            <legend className="mb-2 text-sm">Events</legend>
            <div className="grid grid-cols-2 gap-2">
              {WEBHOOK_EVENTS[provider].map((event) => (
                <label key={event} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={events.includes(event)}
                    onChange={(e) =>
                      setEvents((current) =>
                        e.target.checked
                          ? [...current, event]
                          : current.filter((item) => item !== event),
                      )
                    }
                  />
                  {event}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="grid gap-1 text-sm">
            Actions (optional, comma-separated)
            <Input
              value={actions}
              onChange={(e) => setActions(e.target.value)}
              placeholder={provider === "github" ? "opened, reopened" : "create, update"}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Project
            <select
              className={selectClass}
              value={projectId || projects[0]?.id || ""}
              onChange={(e) => setProjectId(ProjectId.make(e.target.value))}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy || events.length === 0 || projects.length === 0}>
            Compose prompt
          </Button>
        </form>
      )}
      {state?.triggers
        .filter((trigger) => trigger.provider === provider)
        .map((trigger) => (
          <div key={trigger.id} className="space-y-2 rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">{trigger.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {trigger.target} · {trigger.events.join(", ")}
                  {trigger.actions.length > 0 ? ` · ${trigger.actions.join(", ")}` : ""}
                </p>
              </div>
              <span className="text-xs">
                {trigger.enabled ? "Active" : trigger.prompt ? "Paused" : "Needs prompt"}
              </span>
            </div>
            {trigger.prompt && (
              <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                {trigger.prompt.text}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void compose(trigger);
                }}
              >
                Edit prompt & workspace
              </Button>
              <Button
                size="sm"
                disabled={busy || !trigger.prompt}
                onClick={() => {
                  void run({ type: "setEnabled", id: trigger.id, enabled: !trigger.enabled });
                }}
              >
                {trigger.enabled ? "Pause" : "Enable"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void run({ type: "delete", id: trigger.id });
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
      {state && state.deliveries.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Recent deliveries</h3>
          {state.deliveries.map((delivery) => (
            <div
              key={delivery.id}
              className="flex items-center justify-between gap-3 border-t py-2 text-xs"
            >
              <div>
                {state.triggers.find((t) => t.id === delivery.triggerId)?.name ?? "Deleted trigger"}{" "}
                · {delivery.status}
                <p className="text-muted-foreground">{delivery.error ?? delivery.createdAt}</p>
              </div>
              {delivery.status === "started" ? (
                <Link
                  className="text-primary underline"
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: delivery.threadId }}
                >
                  Open thread
                </Link>
              ) : delivery.status === "failed" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void run({ type: "retry", id: delivery.id });
                  }}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
