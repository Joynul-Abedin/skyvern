import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiKeyStore } from "../apiKeyStore.js";

test("rotation persists before revocation, switches session credentials, and survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skyvern-rotation-"));
  const path = join(dir, "api-key.json");
  let active = "old-key";
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers["x-api-key"], active);
    if (url.endsWith("/prepare-rotation"))
      return Response.json({ api_key: "new-key" });
    assert.equal(url.endsWith("/rotate"), true);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).pending_api_key,
      "new-key",
    );
    active = JSON.parse(options.body).api_key;
    return Response.json({ api_key: active });
  };
  try {
    const store = createApiKeyStore({
      path,
      organizationApiKey: active,
      apiBaseUrl: "http://api",
      fetchImpl,
    });
    assert.equal(await store.rotate(), "new-key");
    assert.equal(await store.get(), "new-key");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      api_key: "new-key",
    });
    const restarted = createApiKeyStore({
      path,
      organizationApiKey: "old-key",
      apiBaseUrl: "http://api",
      fetchImpl,
    });
    assert.equal(await restarted.get(), "new-key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lost commit response recovers the saved replacement after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skyvern-rotation-"));
  const path = join(dir, "api-key.json");
  let active = "old-key";
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/prepare-rotation"))
      return Response.json({ api_key: "new-key" });
    if (url.endsWith("/rotate")) {
      active = "new-key";
      throw new Error("connection lost");
    }
    return new Response("", {
      status: options.headers["x-api-key"] === active ? 200 : 403,
    });
  };
  try {
    const store = createApiKeyStore({
      path,
      organizationApiKey: active,
      apiBaseUrl: "http://api",
      fetchImpl,
    });
    await assert.rejects(store.rotate());
    const restarted = createApiKeyStore({
      path,
      organizationApiKey: "old-key",
      apiBaseUrl: "http://api",
      fetchImpl,
    });
    assert.equal(await restarted.get(), "new-key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed database rotation retains the working key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skyvern-rotation-"));
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/prepare-rotation"))
      return Response.json({ api_key: "new-key" });
    if (url.endsWith("/rotate")) return new Response("", { status: 500 });
    return new Response("", {
      status: options.headers["x-api-key"] === "old-key" ? 200 : 403,
    });
  };
  try {
    const store = createApiKeyStore({
      path: join(dir, "key.json"),
      organizationApiKey: "old-key",
      apiBaseUrl: "http://api",
      fetchImpl,
    });
    await assert.rejects(store.rotate());
    assert.equal(await store.get(), "old-key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unwritable persistence never revokes a working key", async () => {
  const calls = [];
  const store = createApiKeyStore({
    path: "/dev/null/key.json",
    organizationApiKey: "old-key",
    apiBaseUrl: "http://api",
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({ api_key: "new-key" });
    },
  });
  await assert.rejects(store.rotate());
  assert.equal(
    calls.some((url) => url.endsWith("/rotate")),
    false,
  );
});

test("recovery keeps both credentials when the API is temporarily unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skyvern-rotation-"));
  const path = join(dir, "key.json");
  let offline = false;
  const store = createApiKeyStore({
    path,
    organizationApiKey: "old-key",
    apiBaseUrl: "http://api",
    fetchImpl: async (url) => {
      if (offline) throw new Error("offline");
      if (url.endsWith("/prepare-rotation"))
        return Response.json({ api_key: "new-key" });
      offline = true;
      throw new Error("commit response lost");
    },
  });
  try {
    await assert.rejects(store.rotate());
    await assert.rejects(store.get());
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      api_key: "old-key",
      pending_api_key: "new-key",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent rotation attempts cannot revoke one another's replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skyvern-rotation-"));
  let resume;
  const hold = new Promise((resolve) => {
    resume = resolve;
  });
  let commits = 0;
  const store = createApiKeyStore({
    path: join(dir, "key.json"),
    organizationApiKey: "old-key",
    apiBaseUrl: "http://api",
    fetchImpl: async (url) => {
      if (url.endsWith("/prepare-rotation")) {
        await hold;
        return Response.json({ api_key: "new-key" });
      }
      commits++;
      return Response.json({ api_key: "new-key" });
    },
  });
  try {
    const first = store.rotate();
    await assert.rejects(store.rotate(), /already running/);
    resume();
    assert.equal(await first, "new-key");
    assert.equal(commits, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
