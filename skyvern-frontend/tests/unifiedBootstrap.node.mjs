import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareUnifiedConfig } from "../../docker/unified/bootstrap.mjs";

test("single-image bootstrap creates private stable admin credentials and deployment secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skyvern-unified-"));
  try {
    const first = await prepareUnifiedConfig({ stateDir: dir, env: {} });
    const second = await prepareUnifiedConfig({ stateDir: dir, env: {} });
    assert.deepEqual(second, first);
    assert.equal(first.SKYVERN_ADMIN_EMAIL, "admin@localhost");
    assert.match(first.SKYVERN_ADMIN_PASSWORD_HASH, /^scrypt:/);
    assert.ok(first.SECRET_KEY.length >= 64);
    assert.ok(first.ENCRYPTOR_AES_SECRET_KEY.length >= 64);
    assert.equal(
      (await stat(join(dir, "unified-config.json"))).mode & 0o777,
      0o600,
    );
    const login = await readFile(join(dir, "admin-login.txt"), "utf8");
    assert.match(login, /Password: /);
    assert.equal(login.includes(first.SKYVERN_ADMIN_PASSWORD_HASH), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap respects explicit credentials and rejects partial or invalid admin settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skyvern-unified-"));
  try {
    await assert.rejects(
      prepareUnifiedConfig({
        stateDir: dir,
        env: { SKYVERN_ADMIN_EMAIL: "admin@example.test" },
      }),
    );
    await assert.rejects(
      prepareUnifiedConfig({
        stateDir: dir,
        env: {
          SKYVERN_ADMIN_EMAIL: "admin@example.test",
          SKYVERN_ADMIN_PASSWORD_HASH: "plaintext",
        },
      }),
    );
    const supplied = {
      SKYVERN_ADMIN_EMAIL: "admin@example.test",
      SKYVERN_ADMIN_PASSWORD_HASH: `scrypt:${"a".repeat(32)}:${"b".repeat(128)}`,
      SECRET_KEY: "secret-from-operator",
      ENCRYPTOR_AES_SECRET_KEY: "encryption-from-operator",
    };
    const config = await prepareUnifiedConfig({ stateDir: dir, env: supplied });
    for (const [key, value] of Object.entries(supplied))
      assert.equal(config[key], value);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
