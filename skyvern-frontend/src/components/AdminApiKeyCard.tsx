import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyText } from "@/util/copyText";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

function AdminApiKeyCard() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRotation, setConfirmRotation] = useState(false);
  const [rotated, setRotated] = useState(false);

  async function reveal() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/auth/api-key", {
        method: "POST",
        cache: "no-store",
        headers: { "x-skyvern-admin-action": "reveal-api-key" },
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? "Sign in again to view your API key."
            : "Could not retrieve the API key. Administrator sign-in is required.",
        );
        return;
      }
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== "object" ||
        !("api_key" in data) ||
        typeof data.api_key !== "string" ||
        !data.api_key
      ) {
        throw new Error("API key unavailable");
      }
      setApiKey(data.api_key);
    } catch {
      setError("Could not retrieve the API key. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (!apiKey) return;
    try {
      if (!(await copyText(apiKey))) throw new Error("Copy failed");
      setCopied(true);
      setError(null);
    } catch {
      setError("Could not copy the key. Select it and copy manually.");
    }
  }

  async function rotate() {
    setPending(true);
    setError(null);
    setRotated(false);
    setApiKey(null);
    setCopied(false);
    try {
      const response = await fetch("/auth/api-key/rotate", {
        method: "POST",
        cache: "no-store",
        headers: { "x-skyvern-admin-action": "rotate-api-key" },
      });
      if (!response.ok) throw new Error("Rotation failed");
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== "object" ||
        !("api_key" in data) ||
        typeof data.api_key !== "string" ||
        !data.api_key
      )
        throw new Error("Key unavailable");
      setApiKey(data.api_key);
      setRotated(true);
    } catch {
      setError(
        "Could not confirm rotation. Use Show API key to retrieve the active key before retrying.",
      );
    } finally {
      setPending(false);
      setConfirmRotation(false);
    }
  }

  return (
    <Card id="api-key" className="ph-no-capture">
      <CardHeader className="border-b-2">
        <CardTitle className="text-lg">API key</CardTitle>
        <CardDescription>
          Use this long-lived key for curl, SDKs, and integrations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-8">
        <Input
          aria-label="API key"
          type={apiKey ? "text" : "password"}
          value={apiKey ?? ""}
          placeholder="••••••••••••••••"
          readOnly
          autoComplete="off"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => {
              if (apiKey) {
                setApiKey(null);
                setCopied(false);
              } else void reveal();
            }}
          >
            {pending ? "Loading…" : apiKey ? "Hide API key" : "Show API key"}
          </Button>
          <Button disabled={!apiKey || pending} onClick={() => void copy()}>
            {copied ? "Copied!" : "Copy API key"}
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => setConfirmRotation(true)}
          >
            Rotate API key
          </Button>
        </div>
        {rotated && (
          <p role="status" className="text-sm text-muted-foreground">
            API key rotated. Copy the new key and update your scripts and
            integrations.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Available to the signed-in workspace administrator.
        </p>
      </CardContent>
      <ConfirmDialog
        open={confirmRotation}
        onOpenChange={setConfirmRotation}
        title="Rotate API key?"
        description="This invalidates all existing API keys for this workspace. Scripts and integrations using them will stop working until you update them. Your dashboard session will continue working."
        confirmLabel="Rotate and invalidate old keys"
        isPending={pending}
        onConfirm={() => void rotate()}
      />
    </Card>
  );
}

export { AdminApiKeyCard };
