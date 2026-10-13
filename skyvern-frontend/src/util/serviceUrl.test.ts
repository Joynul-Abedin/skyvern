import { describe, expect, it } from "vitest";
import { resolveServiceUrl } from "./serviceUrl";

describe("same-origin service URLs", () => {
  it("uses the public HTTPS domain for API and artifacts", () => {
    expect(resolveServiceUrl("/api/v1", "https://automation.example.com")).toBe(
      "https://automation.example.com/api/v1",
    );
    expect(
      resolveServiceUrl("/artifacts", "https://automation.example.com"),
    ).toBe("https://automation.example.com/artifacts");
  });
  it("uses secure WebSockets on HTTPS and the same custom port locally", () => {
    expect(
      resolveServiceUrl("/api/v1", "https://automation.example.com", true),
    ).toBe("wss://automation.example.com/api/v1");
    expect(resolveServiceUrl("/api/v1", "http://localhost:8181", true)).toBe(
      "ws://localhost:8181/api/v1",
    );
  });
  it("preserves explicitly configured services and empty configuration", () => {
    expect(
      resolveServiceUrl(
        "https://api.example.com/api/v1",
        "https://ui.example.com",
      ),
    ).toBe("https://api.example.com/api/v1");
    expect(
      resolveServiceUrl(
        "wss://api.example.com/api/v1",
        "https://ui.example.com",
        true,
      ),
    ).toBe("wss://api.example.com/api/v1");
    expect(resolveServiceUrl("", "https://ui.example.com")).toBe("");
  });
});
