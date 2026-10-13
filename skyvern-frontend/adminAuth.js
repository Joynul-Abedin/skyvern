import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { createAdminSessionStore } from "./adminSessionStore.js";
import { renderLoginPage } from "./loginPage.js";

const deriveKey = promisify(scrypt);
const SESSION_COOKIE = "skyvern_admin_session";
const CSRF_COOKIE = "skyvern_admin_csrf";
const SCRYPT_OPTIONS = { N: 32768, maxmem: 64 * 1024 * 1024 };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
// Browsers cap persistent cookies at 400 days; renew on authenticated requests.
const SESSION_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

function getCookie(request, name) {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (part.slice(0, index).trim() === name)
      return part.slice(index + 1).trim();
  }
  return "";
}

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameOrigin(request) {
  if (
    request.headers["sec-fetch-site"] &&
    request.headers["sec-fetch-site"] !== "same-origin"
  )
    return false;
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Identify the client for login throttling. In the unified image every request arrives from the
 * nginx gateway on loopback, which sets X-Forwarded-For to the real client; trust it only in that case.
 */
function clientAddress(request, env) {
  const socketAddress = request.socket.remoteAddress ?? "unknown";
  if (
    env.SKYVERN_UNIFIED_MODE === "true" &&
    LOOPBACK_ADDRESSES.has(socketAddress)
  ) {
    const forwarded = String(request.headers["x-forwarded-for"] ?? "")
      .split(",")[0]
      .trim();
    if (isIP(forwarded)) return forwarded;
  }
  return socketAddress;
}

function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(303, { location, "cache-control": "no-store" });
  response.end();
}

/** Hash an admin password using a random salt; the returned value is safe to store server-side. */
export async function hashAdminPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 1024
  ) {
    throw new Error(
      "Admin passwords must contain between 12 and 1024 characters.",
    );
  }
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt:${salt}:${key.toString("hex")}`;
}

/** Create the single-admin login gate with persistent sessions and explicit logout. */
export function createAdminAuth({
  env = process.env,
  now = Date.now,
  organizationApiKey = null,
  getOrganizationApiKey = async () => organizationApiKey,
  rotateApiKey = null,
} = {}) {
  const email = env.SKYVERN_ADMIN_EMAIL?.trim().toLowerCase();
  const passwordHash = env.SKYVERN_ADMIN_PASSWORD_HASH?.trim();
  const enabled = Boolean(email || passwordHash);
  if (
    enabled &&
    (!email ||
      !/^[^\s@]+@[^\s@]+$/.test(email) ||
      !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash ?? ""))
  ) {
    throw new Error(
      "Set both SKYVERN_ADMIN_EMAIL and a valid SKYVERN_ADMIN_PASSWORD_HASH; run npm run configure-admin.",
    );
  }
  const cookieSecure = env.SKYVERN_ADMIN_COOKIE_SECURE === "true";
  const sessions = enabled
    ? createAdminSessionStore({ env, email, passwordHash })
    : null;
  const attempts = new Map();

  function cookie(name, value, maxAge) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieSecure ? "; Secure" : ""}`;
  }

  function authenticated(request) {
    const token = getCookie(request, SESSION_COOKIE);
    return sessions.has(token);
  }

  function loginPage(request, response, status = 200, error = "") {
    const existing = getCookie(request, CSRF_COOKIE);
    // Share the browser's nonce across tabs instead of invalidating older forms.
    const csrf = /^[a-f0-9]{64}$/.test(existing)
      ? existing
      : randomBytes(32).toString("hex");
    response.setHeader(
      "set-cookie",
      cookie(CSRF_COOKIE, csrf, SESSION_COOKIE_MAX_AGE),
    );
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    response.end(renderLoginPage({ csrf, error }));
  }

  async function login(request, response) {
    if (!sameOrigin(request)) {
      json(response, 403, { detail: "Cross-site requests are not allowed" });
      return;
    }
    if (
      !(request.headers["content-type"] ?? "").startsWith(
        "application/x-www-form-urlencoded",
      )
    ) {
      json(response, 415, { detail: "Expected a login form" });
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body) > 8192) {
        json(response, 413, { detail: "Login form is too large" });
        return;
      }
    }
    if (authenticated(request)) {
      redirect(response, "/");
      return;
    }
    const form = new URLSearchParams(body);
    const csrf = getCookie(request, CSRF_COOKIE);
    if (!csrf || !equal(csrf, form.get("csrf") ?? "")) {
      loginPage(
        request,
        response,
        403,
        "This sign-in form is out of date. Please sign in using the refreshed form below.",
      );
      return;
    }
    for (const [key, attempt] of attempts)
      if (attempt.expires <= now()) attempts.delete(key);
    const address = clientAddress(request, env);
    const attempt = attempts.get(address) ?? {
      count: 0,
      expires: now() + LOGIN_WINDOW_MS,
    };
    if (
      attempt.count >= 5 ||
      (!attempts.has(address) && attempts.size >= 1024)
    ) {
      response.setHeader(
        "retry-after",
        Math.max(1, Math.ceil((attempt.expires - now()) / 1000)),
      );
      loginPage(
        request,
        response,
        429,
        "Too many login attempts. Try again in 15 minutes.",
      );
      return;
    }
    attempt.count += 1;
    attempts.set(address, attempt);
    const password = form.get("password") ?? "";
    const [, salt, expected] = passwordHash.split(":");
    const candidate = await deriveKey(
      password.slice(0, 1025),
      salt,
      64,
      SCRYPT_OPTIONS,
    );
    const passwordMatches = equal(candidate.toString("hex"), expected);
    if (
      !passwordMatches ||
      password.length > 1024 ||
      form.get("email")?.trim().toLowerCase() !== email
    ) {
      loginPage(request, response, 401, "Email or password is incorrect.");
      return;
    }
    attempts.delete(address);
    const token = randomBytes(32).toString("hex");
    sessions.add(token, getCookie(request, SESSION_COOKIE));
    response.setHeader("set-cookie", [
      cookie(SESSION_COOKIE, token, SESSION_COOKIE_MAX_AGE),
      cookie(CSRF_COOKIE, "", 0),
    ]);
    redirect(response, "/");
  }

  return {
    enabled,
    async handle(request, response, pathname) {
      const signedIn = enabled && authenticated(request);
      if (signedIn)
        response.setHeader(
          "set-cookie",
          cookie(
            SESSION_COOKIE,
            getCookie(request, SESSION_COOKIE),
            SESSION_COOKIE_MAX_AGE,
          ),
        );
      if (pathname === "/auth/api-key" || pathname === "/auth/api-key/rotate") {
        const rotating = pathname.endsWith("/rotate");
        if (!enabled) {
          json(response, 503, {
            detail: "Administrator sign-in is required to view API keys.",
          });
        } else if (!signedIn) {
          json(response, 401, {
            detail: "Sign in again to view your API key.",
            reason: "admin_login_required",
          });
        } else if (request.method !== "POST") {
          json(response, 405, { detail: "Method not allowed" });
        } else if (
          !sameOrigin(request) ||
          request.headers["x-skyvern-admin-action"] !==
            (rotating ? "rotate-api-key" : "reveal-api-key")
        ) {
          json(response, 403, {
            detail: "Cross-site requests are not allowed",
          });
        } else if (rotating && !rotateApiKey) {
          json(response, 503, {
            detail: "API key rotation is unavailable.",
          });
        } else {
          try {
            const key = rotating
              ? await rotateApiKey()
              : await getOrganizationApiKey();
            if (!key)
              json(response, 503, {
                detail: "The workspace API key is unavailable.",
              });
            else json(response, 200, { api_key: key });
          } catch {
            json(response, 502, {
              detail:
                "Could not complete the API key request. Try Show API key to recover, then retry.",
            });
          }
        }
        return true;
      }
      if (pathname === "/auth/check") {
        json(response, !enabled ? 503 : signedIn ? 204 : 401, undefined);
        return true;
      }
      if (pathname === "/auth/status") {
        json(response, request.method === "GET" ? 200 : 405, {
          enabled,
          authenticated: signedIn,
          ...(signedIn ? { email } : {}),
        });
        return true;
      }
      if (!enabled) return false;
      if (pathname === "/login" && request.method === "GET") {
        if (signedIn) redirect(response, "/");
        else loginPage(request, response);
        return true;
      }
      if (pathname === "/auth/login" && request.method === "GET") {
        redirect(response, signedIn ? "/" : "/login");
        return true;
      }
      if (pathname === "/auth/login" || pathname === "/auth/logout") {
        if (request.method !== "POST")
          json(response, 405, { detail: "Method not allowed" });
        else if (pathname === "/auth/login") await login(request, response);
        else if (
          !sameOrigin(request) ||
          request.headers["x-skyvern-admin-action"] !== "logout"
        ) {
          json(response, 403, {
            detail: "Cross-site requests are not allowed",
          });
        } else {
          sessions.delete(getCookie(request, SESSION_COOKIE));
          response.setHeader("set-cookie", [
            cookie(SESSION_COOKIE, "", 0),
            cookie(CSRF_COOKIE, "", 0),
          ]);
          json(response, 204, undefined);
        }
        return true;
      }
      if (signedIn || (pathname === "/logo.png" && request.method === "GET"))
        return false;
      if (
        pathname !== "/ui-session" &&
        !pathname.startsWith("/artifacts/") &&
        request.method === "GET" &&
        request.headers.accept?.includes("text/html")
      ) {
        redirect(response, "/login");
      } else {
        json(response, 401, {
          detail: "Sign in to continue",
          reason: "admin_login_required",
        });
      }
      return true;
    },
  };
}
