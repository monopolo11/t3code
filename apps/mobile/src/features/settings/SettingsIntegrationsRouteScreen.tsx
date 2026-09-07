import { useEffect, useState, type ReactNode } from "react";
import { useNavigation } from "@react-navigation/native";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
import {
  EnvironmentId,
  WEBHOOK_EVENTS,
  type WebhookOperation,
  type WebhookState,
  type WebhookTrigger,
  type WebhookIntegrationProvider,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { webhookEnvironment } from "../../state/webhooks";

function Action({
  children,
  onPress,
  disabled = false,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="rounded-lg border border-border px-3 py-2"
    >
      <Text className={disabled ? "text-sm text-foreground-muted" : "text-sm text-foreground"}>
        {children}
      </Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChange,
  secret = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
  placeholder?: string;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border px-3 py-2 text-foreground"
        value={value}
        onChangeText={onChange}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
      />
    </View>
  );
}

export function SettingsIntegrationsRouteScreen() {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const environmentId = selectedId ?? environments[0]?.environmentId;
  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" && (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Integrations" onBack={() => navigation.goBack()} />
        </>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pb-12 pt-4"
      >
        <Text className="text-sm text-foreground-muted">
          Start a new thread from GitHub or Linear events. Keep the selected machine and its
          Cloudflare tunnel running.
        </Text>
        <Text className="text-sm text-foreground">Default machine</Text>
        <View className="flex-row flex-wrap gap-2">
          {environments.map((env) => (
            <Action key={env.environmentId} onPress={() => setSelectedId(env.environmentId)}>
              {environmentId === env.environmentId ? "✓ " : ""}
              {env.label}
            </Action>
          ))}
        </View>
        {environmentId && <MachineIntegrations key={environmentId} environmentId={environmentId} />}
      </ScrollView>
    </View>
  );
}

function MachineIntegrations({ environmentId }: { environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const operation = useAtomCommand(webhookEnvironment.operate, { reportFailure: false });
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [state, setState] = useState<WebhookState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<WebhookIntegrationProvider>("github");
  const [publicUrl, setPublicUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [actions, setActions] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const connection = state?.integrations.find((item) => item.provider === provider);
  const run = async (input: WebhookOperation) => {
    setBusy(true);
    setError(null);
    try {
      const result = await operation({ environmentId, input });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not complete the operation.");
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
    void operation({ environmentId, input: { type: "list" } }).then((result) => {
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
  }, [environmentId, operation]);
  const compose = (trigger: WebhookTrigger) => {
    const project =
      projects.find((p) => p.id === (trigger.prompt?.projectId ?? projectId)) ?? projects[0];
    if (!project) {
      setError("Add a project on this machine first.");
      return;
    }
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId,
        projectId: project.id,
        title: `Trigger: ${trigger.name}`,
        webhookTriggerId: trigger.id,
      },
    });
  };
  return (
    <View className="gap-4">
      {error && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      )}
      <View className="flex-row gap-2">
        {(["github", "linear"] as const).map((value) => (
          <Action
            key={value}
            onPress={() => {
              setProvider(value);
              setEvents([]);
              setTarget("");
              setClientId("");
              setClientSecret("");
            }}
          >
            {value === provider ? "✓ " : ""}
            {value === "github" ? "GitHub" : "Linear"}
          </Action>
        ))}
        <Action
          disabled={busy}
          onPress={() => {
            void run({ type: "list" });
          }}
        >
          Refresh
        </Action>
      </View>
      <Text className="text-sm text-foreground">
        {connection?.connected ? `Connected: ${connection.account}` : "Connect your OAuth app"}
      </Text>
      <Field
        label="Public HTTPS tunnel URL"
        value={publicUrl || connection?.publicUrl || ""}
        onChange={setPublicUrl}
        placeholder="https://t3.example.com"
      />
      <Text selectable className="text-xs text-foreground-muted">
        OAuth callback:{" "}
        {(publicUrl || connection?.publicUrl || "https://t3.example.com").replace(/\/$/, "")}
        /api/webhooks/oauth/{provider}
      </Text>
      <Field
        label="OAuth client ID"
        value={clientId || connection?.clientId || ""}
        onChange={setClientId}
      />
      <Field label="OAuth client secret" value={clientSecret} onChange={setClientSecret} secret />
      <Text className="text-xs text-foreground-muted">
        {provider === "github"
          ? "Requests repository webhook administration and profile access."
          : "Requests read and admin access to create Linear webhooks."}
      </Text>
      <View className="flex-row gap-2">
        <Action
          disabled={busy || !clientSecret}
          onPress={() => {
            void run({
              type: "connect",
              provider,
              publicUrl: publicUrl || connection?.publicUrl || "",
              clientId: clientId || connection?.clientId || "",
              clientSecret,
            }).then((result) => {
              if (result?.authorizationUrl) {
                setClientSecret("");
                void Linking.openURL(result.authorizationUrl);
              }
            });
          }}
        >
          Sign in
        </Action>
        {connection?.connected && (
          <Action
            disabled={busy}
            onPress={() => {
              void run({ type: "disconnect", provider });
            }}
          >
            Disconnect
          </Action>
        )}
      </View>
      {connection?.connected && (
        <View className="gap-3 rounded-lg border border-border p-3">
          <Text className="text-base text-foreground">Create trigger</Text>
          <Field label="Name" value={name} onChange={setName} />
          <Field
            label={
              provider === "github"
                ? "Repository (owner/repository)"
                : "Linear team UUID (* for all public teams)"
            }
            value={target}
            onChange={setTarget}
          />
          <Text className="text-sm text-foreground">Events</Text>
          <View className="flex-row flex-wrap gap-2">
            {WEBHOOK_EVENTS[provider].map((event) => (
              <Action
                key={event}
                onPress={() =>
                  setEvents((current) =>
                    current.includes(event)
                      ? current.filter((item) => item !== event)
                      : [...current, event],
                  )
                }
              >
                {events.includes(event) ? "✓ " : ""}
                {event}
              </Action>
            ))}
          </View>
          <Field
            label="Actions (optional, comma-separated)"
            value={actions}
            onChange={setActions}
            placeholder={provider === "github" ? "opened, reopened" : "create, update"}
          />
          <Text className="text-sm text-foreground">Project</Text>
          <View className="flex-row flex-wrap gap-2">
            {projects.map((project) => (
              <Action key={project.id} onPress={() => setProjectId(project.id)}>
                {(projectId ?? projects[0]?.id) === project.id ? "✓ " : ""}
                {project.title}
              </Action>
            ))}
          </View>
          <Action
            disabled={busy || !name.trim() || !target.trim() || !events.length || !projects.length}
            onPress={() => {
              void run({
                type: "create",
                provider,
                name,
                target,
                events,
                actions: actions
                  .split(",")
                  .map((a) => a.trim())
                  .filter(Boolean),
              }).then((result) => {
                const trigger = result?.state.triggers.find((item) => item.id === result.triggerId);
                if (trigger) compose(trigger);
              });
            }}
          >
            Compose prompt
          </Action>
        </View>
      )}
      {state?.triggers
        .filter((trigger) => trigger.provider === provider)
        .map((trigger) => (
          <View key={trigger.id} className="gap-2 rounded-lg border border-border p-3">
            <Text className="text-base text-foreground">
              {trigger.name} ·{" "}
              {trigger.enabled ? "Active" : trigger.prompt ? "Paused" : "Needs prompt"}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {trigger.target} · {trigger.events.join(", ")}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Action disabled={busy} onPress={() => compose(trigger)}>
                Edit prompt & workspace
              </Action>
              <Action
                disabled={busy || !trigger.prompt}
                onPress={() => {
                  void run({ type: "setEnabled", id: trigger.id, enabled: !trigger.enabled });
                }}
              >
                {trigger.enabled ? "Pause" : "Enable"}
              </Action>
              <Action
                disabled={busy}
                onPress={() => {
                  void run({ type: "delete", id: trigger.id });
                }}
              >
                Delete
              </Action>
            </View>
          </View>
        ))}
      {state?.deliveries.map((delivery) => (
        <View key={delivery.id} className="gap-2 border-t border-border py-2">
          <Text className="text-sm text-foreground">
            {state.triggers.find((t) => t.id === delivery.triggerId)?.name ?? "Deleted trigger"} ·{" "}
            {delivery.status}
          </Text>
          {delivery.error && <Text className="text-xs text-destructive">{delivery.error}</Text>}
          {delivery.status === "started" ? (
            <Action
              onPress={() =>
                navigation.navigate("Thread", { environmentId, threadId: delivery.threadId })
              }
            >
              Open thread
            </Action>
          ) : delivery.status === "failed" ? (
            <Action
              disabled={busy}
              onPress={() => {
                void run({ type: "retry", id: delivery.id });
              }}
            >
              Retry
            </Action>
          ) : null}
        </View>
      ))}
    </View>
  );
}
