import { useEffect, useState } from "react";
import {
  generateLocalApiKey,
  getLocalApiKeyStatus,
  revokeLocalApiKey,
} from "../../environments/primary/localApi";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LocalApiKeySettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void getLocalApiKeyStatus().then(
      (status) => {
        if (active) setEnabled(status.enabled);
      },
      () => {
        if (active) setError("Could not load localhost API key status.");
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function updateKey(action: "generate" | "revoke") {
    setPending(true);
    setError(null);
    setCopied(false);
    try {
      if (action === "generate") {
        const result = await generateLocalApiKey();
        setKey(result.key);
        setEnabled(true);
      } else {
        await revokeLocalApiKey();
        setKey(null);
        setEnabled(false);
      }
    } catch {
      setError(`Could not ${action} the localhost API key.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsSection {...searchableSetting("connections-local-api")}>
      <SettingsRow
        title="Localhost API key"
        description="Let other apps on this server’s machine configure and start new threads. Generating a replacement immediately revokes the previous key."
      >
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || enabled === null}
            onClick={() => void updateKey("generate")}
          >
            {enabled ? "Replace key" : "Generate key"}
          </Button>
          {enabled ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void updateKey("revoke")}
            >
              Revoke key
            </Button>
          ) : null}
        </div>
      </SettingsRow>
      {key ? (
        <SettingsRow
          title="Copy your key"
          description="This key is shown only once. Save it before leaving Settings."
        >
          <div className="flex min-w-0 gap-2">
            <Input aria-label="Localhost API key" value={key} readOnly className="font-mono" />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void writeTextToClipboard(key, "localhost API key").then(
                  () => setCopied(true),
                  () => setError("Could not copy the key. Select and copy it manually."),
                );
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </SettingsRow>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
