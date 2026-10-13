import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { createLocalServer } from "../localServer.js";

const password = "test-only-password-with-enough-entropy";
const salt = "0123456789abcdef0123456789abcdef";
const hash = scryptSync(password, salt, 64, {
  N: 32768,
  maxmem: 64 * 1024 * 1024,
}).toString("hex");
const env = {
  SKYVERN_ADMIN_EMAIL: "admin@example.test",
  SKYVERN_ADMIN_PASSWORD_HASH: `scrypt:${salt}:${hash}`,
};
const servers = [];
const directories = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "skyvern-admin-"));
  directories.push(directory);
  const sessionFile =
    overrides.env?.SKYVERN_ADMIN_SESSIONS_FILE ||
    join(directory, "sessions.json");
  const upstream = await listen(
    createServer((req, res) => {
      if (
        req.url !== "/ui-session" ||
        req.headers["x-api-key"] !== "organization-test-key"
      ) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          token: "browser-test-token",
          expires_at: Date.now() / 1000 + 3600,
        }),
      );
    }),
  );
  const base = await listen(
    createLocalServer({
      apiBaseUrl: upstream,
      organizationApiKey: "organization-test-key",
      ...overrides,
      env: {
        ...(overrides.env ?? env),
        SKYVERN_ADMIN_SESSIONS_FILE: sessionFile,
      },
    }),
  );
  const cookies = new Map();
  async function request(path, options = {}) {
    const response = await fetch(base + path, {
      redirect: "manual",
      ...options,
      headers: {
        accept: "text/html",
        cookie: [...cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
        origin: base,
        ...options.headers,
      },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async function login(credentials = {}, headers = {}) {
    const page = await request("/login");
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    return request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({
        email: env.SKYVERN_ADMIN_EMAIL,
        password,
        csrf,
        ...credentials,
      }),
    });
  }
  return { request, login, cookies, base, sessionFile };
}

test("blocks anonymous app, API session, and artifact access", async () => {
  const { request } = await setup();
  const page = await request("/workflows");
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login");
  for (const path of [
    "/ui-session",
    "/artifacts/artifact/image?path=/data/test.png",
  ]) {
    const response = await request(path, {
      headers: { accept: "application/json" },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).reason, "admin_login_required");
  }
});

test("valid email and password create an HttpOnly session and allow API session minting", async () => {
  const { request, login } = await setup();
  const response = await login({ email: "ADMIN@EXAMPLE.TEST" });
  assert.equal(response.status, 303);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("skyvern_admin_session="));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, new RegExp(password));
  const status = await request("/auth/status");
  assert.deepEqual(await status.json(), {
    enabled: true,
    authenticated: true,
    email: "admin@example.test",
  });
  await request("/");
  const session = await request("/ui-session");
  assert.equal(session.status, 200);
  assert.equal((await session.json()).token, "browser-test-token");
});

test("wrong email or password never create an authenticated session", async () => {
  const { request, login } = await setup();
  for (const credentials of [
    { password: "wrong" },
    { email: "other@example.test" },
  ]) {
    const response = await login(credentials);
    assert.equal(response.status, 401);
    assert.match(await response.text(), /Email or password is incorrect/);
  }
  assert.equal(
    (await (await request("/auth/status")).json()).authenticated,
    false,
  );
});

test("logout invalidates a copied cookie on the server", async () => {
  const { request, login, cookies } = await setup();
  await login();
  const copiedCookie = cookies.get("skyvern_admin_session");
  const response = await request("/auth/logout", {
    method: "POST",
    headers: { "x-skyvern-admin-action": "logout" },
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  cookies.set("skyvern_admin_session", copiedCookie);
  assert.equal((await request("/ui-session")).status, 401);
});

test("rejects cross-origin login and logout, missing CSRF, and oversized login bodies", async () => {
  const { request, login } = await setup();
  assert.equal((await login({ csrf: "forged" })).status, 403);
  const crossOrigin = await request("/auth/login", {
    method: "POST",
    headers: { origin: "http://attacker.test" },
    body: "",
  });
  assert.equal(crossOrigin.status, 403);
  await login();
  const logout = await request("/auth/logout", {
    method: "POST",
    headers: {
      origin: "http://attacker.test",
      "x-skyvern-admin-action": "logout",
    },
  });
  assert.equal(logout.status, 403);
  const huge = await request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "x".repeat(9000),
  });
  assert.equal(huge.status, 413);
});

test("throttles repeated invalid passwords", async () => {
  const { login } = await setup();
  for (let i = 0; i < 5; i += 1)
    assert.equal((await login({ password: "wrong" })).status, 401);
  const response = await login({ password: "wrong" });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
});

test("behind the unified gateway, login throttling is tracked per forwarded client", async () => {
  const { login } = await setup({
    env: { ...env, SKYVERN_UNIFIED_MODE: "true" },
  });
  const attacker = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < 5; i += 1)
    assert.equal((await login({ password: "wrong" }, attacker)).status, 401);
  assert.equal((await login({ password: "wrong" }, attacker)).status, 429);
  const admin = { "x-forwarded-for": "198.51.100.20" };
  assert.equal((await login({}, admin)).status, 303);
});

test("forwarded client addresses are ignored outside the unified gateway", async () => {
  const { login } = await setup();
  for (let i = 0; i < 5; i += 1)
    await login({ password: "wrong" }, { "x-forwarded-for": `203.0.113.${i}` });
  const response = await login(
    { password: "wrong" },
    { "x-forwarded-for": "198.51.100.99" },
  );
  assert.equal(response.status, 429);
});

test("HTML navigations keep both the renewed session cookie and the UI-session nonce", async () => {
  const { request, login } = await setup();
  await login();
  const response = await request("/workflows");
  const names = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split("=")[0]);
  assert.ok(names.includes("skyvern_admin_session"));
  assert.ok(names.includes("skyvern_ui_session_nonce"));
});

test("admin sessions remain authenticated after years without an application timeout", async () => {
  let time = Date.now();
  const { request, login } = await setup({ adminNow: () => time });
  await login();
  await request("/");
  time += 5 * 365 * 24 * 60 * 60 * 1000;
  assert.equal((await request("/ui-session")).status, 200);
  assert.equal(
    (await (await request("/auth/status")).json()).authenticated,
    true,
  );
});

test("partial or malformed admin configuration fails closed at startup", () => {
  for (const configuration of [
    { SKYVERN_ADMIN_EMAIL: "admin@example.test" },
    { ...env, SKYVERN_ADMIN_PASSWORD_HASH: "plaintext-password" },
  ]) {
    assert.throws(
      () => createLocalServer({ env: configuration }),
      /admin|SKYVERN_ADMIN/i,
    );
  }
});

test("unconfigured deployments retain the existing session behavior", async () => {
  const { request } = await setup({ env: {} });
  const status = await request("/auth/status");
  assert.deepEqual(await status.json(), {
    enabled: false,
    authenticated: false,
  });
  await request("/");
  assert.equal((await request("/ui-session")).status, 200);
});

test("only a signed-in admin can explicitly reveal the organization API key", async () => {
  const { request, login } = await setup();
  const options = {
    method: "POST",
    headers: { "x-skyvern-admin-action": "reveal-api-key" },
  };
  assert.equal((await request("/auth/api-key", options)).status, 401);
  await login();
  const response = await request("/auth/api-key", options);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { api_key: "organization-test-key" });
  await request("/auth/logout", {
    method: "POST",
    headers: { "x-skyvern-admin-action": "logout" },
  });
  assert.equal((await request("/auth/api-key", options)).status, 401);
});

test("API key reveal rejects cross-origin requests and requires an explicit action", async () => {
  const { request, login } = await setup();
  await login();
  assert.equal((await request("/auth/api-key")).status, 405);
  assert.equal(
    (await request("/auth/api-key", { method: "POST" })).status,
    403,
  );
  const response = await request("/auth/api-key", {
    method: "POST",
    headers: {
      origin: "https://attacker.test",
      "x-skyvern-admin-action": "reveal-api-key",
    },
  });
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /organization-test-key/);
});

test("API key reveal is disabled without admin login or a server-side key", async () => {
  const unprotected = await setup({ env: {} });
  assert.equal(
    (await unprotected.request("/auth/api-key", { method: "POST" })).status,
    503,
  );
  const missingKey = await setup({ organizationApiKey: null });
  await missingKey.login();
  assert.equal(
    (
      await missingKey.request("/auth/api-key", {
        method: "POST",
        headers: { "x-skyvern-admin-action": "reveal-api-key" },
      })
    ).status,
    503,
  );
});

test("rotation requires a signed-in administrator, same origin, POST, and explicit action", async () => {
  let rotations = 0;
  const apiKeyStore = {
    get: async () => "old-key",
    rotate: async () => {
      rotations++;
      return "new-key";
    },
  };
  const options = {
    method: "POST",
    headers: { "x-skyvern-admin-action": "rotate-api-key" },
  };
  const { request, login } = await setup({ apiKeyStore });
  assert.equal((await request("/auth/api-key/rotate", options)).status, 401);
  await login();
  assert.equal((await request("/auth/api-key/rotate")).status, 405);
  assert.equal(
    (await request("/auth/api-key/rotate", { method: "POST" })).status,
    403,
  );
  assert.equal(
    (
      await request("/auth/api-key/rotate", {
        ...options,
        headers: { ...options.headers, origin: "http://attacker.test" },
      })
    ).status,
    403,
  );
  assert.equal(rotations, 0);
  const result = await request("/auth/api-key/rotate", options);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(rotations, 1);
  const unprotected = await setup({ env: {}, apiKeyStore });
  assert.equal(
    (await unprotected.request("/auth/api-key/rotate", options)).status,
    503,
  );
  assert.equal(rotations, 1);
});

test("revealing keys and minting fresh browser sessions use the rotated key", async () => {
  let key = "old-key";
  const used = [];
  const { request, login } = await setup({
    apiKeyStore: {
      get: async () => key,
      rotate: async () => {
        key = "new-key";
        return key;
      },
    },
    fetchImpl: async (_url, options) => {
      used.push(options.headers["x-api-key"]);
      return Response.json({
        token: "ui-session-token",
        expires_at: Date.now() / 1000 + 3600,
      });
    },
  });
  await login();
  await request("/");
  assert.equal((await request("/ui-session")).status, 200);
  await request("/auth/api-key/rotate", {
    method: "POST",
    headers: { "x-skyvern-admin-action": "rotate-api-key" },
  });
  const revealed = await request("/auth/api-key", {
    method: "POST",
    headers: { "x-skyvern-admin-action": "reveal-api-key" },
  });
  assert.equal((await revealed.json()).api_key, "new-key");
  assert.equal(
    (
      await request("/ui-session", {
        headers: { "x-skyvern-ui-session-refresh": "auth-failure" },
      })
    ).status,
    200,
  );
  assert.deepEqual(used, ["old-key", "new-key"]);
});

test("admin sessions survive server restarts, but logout remains revoked after another restart", async () => {
  const first = await setup();
  const login = await first.login();
  const token = first.cookies.get("skyvern_admin_session");
  const sessionCookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("skyvern_admin_session="));
  assert.ok(Number(sessionCookie.match(/Max-Age=(\d+)/)[1]) > 365 * 86400);
  const restarted = await setup({
    env: { ...env, SKYVERN_ADMIN_SESSIONS_FILE: first.sessionFile },
  });
  restarted.cookies.set("skyvern_admin_session", token);
  assert.equal(
    (await (await restarted.request("/auth/status")).json()).authenticated,
    true,
  );
  await restarted.request("/auth/logout", {
    method: "POST",
    headers: { "x-skyvern-admin-action": "logout" },
  });
  const again = await setup({
    env: { ...env, SKYVERN_ADMIN_SESSIONS_FILE: first.sessionFile },
  });
  again.cookies.set("skyvern_admin_session", token);
  assert.equal((await again.request("/ui-session")).status, 401);
});

test("persistent session records are private and contain no reusable cookie or password", async () => {
  const { login, cookies, sessionFile } = await setup();
  await login();
  const contents = await readFile(sessionFile, "utf8");
  assert.equal(contents.includes(cookies.get("skyvern_admin_session")), false);
  assert.equal(contents.includes(password), false);
  assert.equal(contents.includes(hash), false);
  assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
});

test("a forged cookie or changed admin password cannot reuse a persistent session", async () => {
  const first = await setup();
  await first.login();
  const token = first.cookies.get("skyvern_admin_session");
  first.cookies.set("skyvern_admin_session", "a".repeat(64));
  assert.equal((await first.request("/ui-session")).status, 401);
  const changed = await setup({
    env: {
      ...env,
      SKYVERN_ADMIN_PASSWORD_HASH: `scrypt:${salt}:${"f".repeat(128)}`,
      SKYVERN_ADMIN_SESSIONS_FILE: first.sessionFile,
    },
  });
  changed.cookies.set("skyvern_admin_session", token);
  assert.equal((await changed.request("/ui-session")).status, 401);
});

test("corrupt session records fail closed without discarding them", async () => {
  const first = await setup();
  await first.login();
  await writeFile(first.sessionFile, "invalid-session-record");
  assert.equal((await first.request("/ui-session")).status, 500);
  assert.equal(
    await readFile(first.sessionFile, "utf8"),
    "invalid-session-record",
  );
});

test("opening another login tab does not invalidate an earlier sign-in form", async () => {
  const { request } = await setup();
  const first = await request("/login");
  const token = (await first.text()).match(/name="csrf" value="([^"]+)"/)[1];
  await request("/login");
  const submitted = await request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: env.SKYVERN_ADMIN_EMAIL,
      password,
      csrf: token,
    }),
  });
  assert.equal(submitted.status, 303);
  assert.equal(submitted.headers.get("location"), "/");
});

test("a missing or stale CSRF cookie renders a fresh form that can be submitted successfully", async () => {
  for (const missing of [false, true]) {
    const { request, cookies } = await setup();
    const page = await request("/login");
    const previous = (await page.text()).match(
      /name="csrf" value="([^"]+)"/,
    )[1];
    if (missing) cookies.delete("skyvern_admin_csrf");
    else cookies.set("skyvern_admin_csrf", "a".repeat(64));
    const response = await request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: env.SKYVERN_ADMIN_EMAIL,
        password,
        csrf: previous,
      }),
    });
    assert.equal(response.status, 403);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(
      (await (await request("/auth/status")).json()).authenticated,
      false,
    );
    const html = await response.text();
    assert.match(html, /role="alert"/);
    assert.equal(html.includes(password), false);
    const refreshed = html.match(/name="csrf" value="([^"]+)"/)[1];
    const retry = await request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: env.SKYVERN_ADMIN_EMAIL,
        password,
        csrf: refreshed,
      }),
    });
    assert.equal(retry.status, 303);
  }
});

test("a stale login tab submitted after another tab signed in keeps the existing session", async () => {
  const { request, login, cookies } = await setup();
  await login();
  const original = cookies.get("skyvern_admin_session");
  const response = await request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: env.SKYVERN_ADMIN_EMAIL,
      password,
      csrf: "old-form",
    }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(cookies.get("skyvern_admin_session"), original);
});

test("refreshing the old auth/login URL recovers to the login page or signed-in app", async () => {
  const { request, login } = await setup();
  const anonymous = await request("/auth/login");
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/login");
  await login();
  const signedIn = await request("/auth/login");
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get("location"), "/");
});

test("gateway authorization checks require admin login and respect logout", async () => {
  const { request, login } = await setup();
  assert.equal((await request("/auth/check")).status, 401);
  await login();
  assert.equal((await request("/auth/check")).status, 204);
  await request("/auth/logout", {
    method: "POST",
    headers: { "x-skyvern-admin-action": "logout" },
  });
  assert.equal((await request("/auth/check")).status, 401);
  const unprotected = await setup({ env: {} });
  assert.equal((await unprotected.request("/auth/check")).status, 503);
});
