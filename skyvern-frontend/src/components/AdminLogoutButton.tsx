import { useEffect, useState } from "react";
import { ExitIcon } from "@radix-ui/react-icons";
import { Button } from "@/components/ui/button";
import { removeApiKeyHeader } from "@/api/AxiosClient";
import { queryClient } from "@/api/QueryClient";

const LOGOUT_EVENT = "skyvern.adminLogout";

function AdminLogoutButton({ collapsed }: { collapsed: boolean }) {
  const [email, setEmail] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let enabled = false;
    function signedOut() {
      removeApiKeyHeader();
      queryClient.clear();
      window.location.assign("/login");
    }
    async function checkSession() {
      try {
        const response = await fetch("/auth/status", { cache: "no-store" });
        if (!response.ok) return;
        const status = await response.json();
        if (!active) return;
        enabled = status.enabled === true;
        if (enabled && !status.authenticated) signedOut();
        else if (enabled) setEmail(status.email);
      } catch {
        // A network interruption does not mean the admin session expired.
      }
    }
    function onStorage(event: StorageEvent) {
      if (enabled && event.key === LOGOUT_EVENT) signedOut();
    }
    void checkSession();
    const timer = window.setInterval(() => void checkSession(), 60_000);
    window.addEventListener("focus", checkSession);
    window.addEventListener("storage", onStorage);
    window.addEventListener("skyvern:admin-session-expired", signedOut);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", checkSession);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("skyvern:admin-session-expired", signedOut);
    };
  }, []);

  if (!email) return null;

  async function logout() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        headers: { "x-skyvern-admin-action": "logout" },
      });
      if (!response.ok) throw new Error("Logout failed");
      removeApiKeyHeader();
      queryClient.clear();
      // Other open tabs clear their cached API token and return to login too.
      try {
        window.localStorage.setItem(LOGOUT_EVENT, String(Date.now()));
      } catch {
        // Storage can be disabled; the server still invalidates the cookie.
      }
      window.location.assign("/login");
    } catch {
      setError("Could not sign out. Try again.");
      setPending(false);
    }
  }

  return (
    <div className={collapsed ? "px-2 pb-2" : "px-3 pb-2"}>
      <Button
        variant="ghost"
        size={collapsed ? "icon" : "default"}
        className={collapsed ? "w-full" : "w-full justify-start gap-2"}
        title={`Sign out ${email}`}
        aria-label="Sign out"
        disabled={pending}
        onClick={() => void logout()}
      >
        <ExitIcon className="size-4 shrink-0" />
        {!collapsed && (pending ? "Signing out…" : "Sign out")}
      </Button>
      {error && (
        <p role="alert" className="px-2 text-xs text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}

export { AdminLogoutButton };
