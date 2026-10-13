import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Persist only token hashes; successful logout removes authorization across restarts. */
export function createAdminSessionStore({ env, email, passwordHash }) {
  const path =
    env.SKYVERN_ADMIN_SESSIONS_FILE ||
    fileURLToPath(
      new URL(
        existsSync("/.dockerenv")
          ? ".skyvern/admin-sessions.json"
          : "../.skyvern/admin-sessions.json",
        import.meta.url,
      ),
    );
  const fingerprint = digest(`${email}\n${passwordHash}`);

  // Requests are frequent; re-parse the file only when it changed on disk. Failures are never cached.
  let cache = null;

  function signature() {
    try {
      const { mtimeMs, size, ino } = statSync(path);
      return `${mtimeMs}:${size}:${ino}`;
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw new Error("Unable to read administrator sessions");
    }
  }

  function load() {
    const current = signature();
    if (cache?.signature === current) return new Set(cache.sessions);
    const sessions = read();
    cache = { signature: current, sessions };
    return new Set(sessions);
  }

  function read() {
    let value;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return new Set();
      throw new Error("Unable to read administrator sessions");
    }
    if (
      value?.version !== 1 ||
      typeof value.admin !== "string" ||
      !Array.isArray(value.sessions) ||
      !value.sessions.every(
        (token) => typeof token === "string" && /^[a-f0-9]{64}$/.test(token),
      )
    ) {
      throw new Error("Invalid administrator session store");
    }
    // Deliberate credential changes invalidate sessions; ordinary restarts do not.
    return value.admin === fingerprint ? new Set(value.sessions) : new Set();
  }

  function save(sessions) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            admin: fingerprint,
            sessions: [...sessions],
          }),
        );
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, path);
      cache = null;
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  return {
    has(token) {
      if (!/^[a-f0-9]{64}$/.test(token)) return false;
      const current = signature();
      if (cache?.signature !== current)
        cache = { signature: current, sessions: read() };
      return cache.sessions.has(digest(token));
    },
    add(token, previous) {
      const sessions = load();
      if (previous) sessions.delete(digest(previous));
      sessions.add(digest(token));
      save(sessions);
    },
    delete(token) {
      if (!/^[a-f0-9]{64}$/.test(token)) return;
      const sessions = load();
      if (sessions.delete(digest(token))) save(sessions);
    },
  };
}
