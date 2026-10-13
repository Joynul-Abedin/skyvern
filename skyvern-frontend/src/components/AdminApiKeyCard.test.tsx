import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiKeyCard } from "./AdminApiKeyCard";

afterEach(() => vi.unstubAllGlobals());

describe("Admin API key access", () => {
  it("reveals only on request, copies the key, and clears it when hidden", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ api_key: "long-lived-test-key" })),
      );
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    render(<AdminApiKeyCard />);
    expect(fetch).not.toHaveBeenCalled();
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Copy API key",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show API key" }));
    await waitFor(() =>
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
        "long-lived-test-key",
      ),
    );
    expect(fetch).toHaveBeenCalledWith("/auth/api-key", {
      method: "POST",
      cache: "no-store",
      headers: { "x-skyvern-admin-action": "reveal-api-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy API key" }));
    await screen.findByRole("button", { name: "Copied!" });
    expect(writeText).toHaveBeenCalledWith("long-lived-test-key");
    fireEvent.click(screen.getByRole("button", { name: "Hide API key" }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
    expect(window.sessionStorage.getItem("skyvern.apiKey")).not.toBe(
      "long-lived-test-key",
    );
  });

  it("handles an expired admin session without showing a key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 401 })),
    );
    render(<AdminApiKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Show API key" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Sign in again",
    );
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("does not display invalid or unavailable key responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ api_key: null }))),
    );
    render(<AdminApiKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Show API key" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
    screen.getByRole("button", { name: "Show API key" });
  });
});

describe("API key rotation", () => {
  it("requires confirmation, permits cancel, then shows the replacement key", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ api_key: "replacement-key" }));
    vi.stubGlobal("fetch", fetch);
    render(<AdminApiKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate API key" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain(
      "existing API keys",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rotate API key" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Rotate and invalidate old keys" }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
        "replacement-key",
      ),
    );
    expect(fetch).toHaveBeenCalledWith("/auth/api-key/rotate", {
      method: "POST",
      cache: "no-store",
      headers: { "x-skyvern-admin-action": "rotate-api-key" },
    });
    expect(screen.getByRole("status").textContent).toContain("rotated");
  });

  it("reports rotation failure without claiming success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 502 })),
    );
    render(<AdminApiKeyCard />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate API key" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Rotate and invalidate old keys" }),
    );
    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
