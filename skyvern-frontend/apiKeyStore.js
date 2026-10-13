import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export function resolveApiKeyStorePath(env = process.env) {
  return (
    env.SKYVERN_UI_API_KEY_FILE ||
    fileURLToPath(
      new URL(
        existsSync("/.dockerenv")
          ? ".skyvern/ui-api-key.json"
          : "../.skyvern/ui-api-key.json",
        import.meta.url,
      ),
    )
  );
}

/** Persist a replacement before revocation, so an interrupted rotation remains recoverable. */
export function createApiKeyStore({
  path,
  organizationApiKey,
  apiBaseUrl,
  fetchImpl = fetch,
}) {
  let rotation = null;
  let recovery = null;

  async function save(value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function load() {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof value.api_key !== "string" ||
        !value.api_key ||
        (value.pending_api_key !== undefined &&
          (typeof value.pending_api_key !== "string" || !value.pending_api_key))
      ) {
        throw new Error("Invalid saved API key");
      }
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { api_key: organizationApiKey };
      throw new Error("Unable to read saved API key");
    }
  }

  async function upstream(endpoint, key, body) {
    return fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}${endpoint}`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async function recover() {
    const value = await load();
    if (!value.pending_api_key) return value.api_key;
    // Only a definite auth rejection permits falling back; network failures keep the journal.
    const replacement = await upstream("/ui-session", value.pending_api_key);
    if (replacement.ok) {
      await save({ api_key: value.pending_api_key });
      return value.pending_api_key;
    }
    if (![401, 403].includes(replacement.status))
      throw new Error("Unable to recover API key rotation");
    const previous = await upstream("/ui-session", value.api_key);
    if (!previous.ok) throw new Error("Unable to recover API key rotation");
    await save({ api_key: value.api_key });
    return value.api_key;
  }

  async function current() {
    if (!recovery)
      recovery = recover().finally(() => {
        recovery = null;
      });
    return recovery;
  }

  return {
    async get() {
      if (rotation) await rotation.catch(() => {});
      return current();
    },
    async rotate() {
      if (rotation) throw new Error("An API key rotation is already running");
      rotation = (async () => {
        const previous = await current();
        if (!previous) throw new Error("No API key configured");
        const prepared = await upstream("/api-key/prepare-rotation", previous);
        if (!prepared.ok) throw new Error("Unable to prepare API key rotation");
        const { api_key: next } = await prepared.json();
        if (typeof next !== "string" || !next || next === previous)
          throw new Error("Invalid replacement API key");
        await save({ api_key: previous, pending_api_key: next });
        const committed = await upstream("/api-key/rotate", previous, {
          api_key: next,
        });
        if (!committed.ok) throw new Error("Unable to rotate API key");
        await save({ api_key: next });
        return next;
      })();
      try {
        return await rotation;
      } finally {
        rotation = null;
      }
    },
  };
}
