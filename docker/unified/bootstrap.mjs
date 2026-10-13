import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAdminAuth,
  hashAdminPassword,
} from "../../skyvern-frontend/adminAuth.js";

async function writePrivate(path, contents) {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Create deployment secrets once; subsequent starts reuse them without printing credentials. */
export async function prepareUnifiedConfig({ stateDir, env = process.env }) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "unified-config.json");
  let config = {};
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Unable to load unified deployment configuration");
  }
  for (const key of [
    "SECRET_KEY",
    "ENCRYPTOR_AES_SECRET_KEY",
    "SKYVERN_POSTGRES_PASSWORD",
  ]) {
    const supplied = env[key]?.trim();
    config[key] =
      supplied && !["PLACEHOLDER", "fillmein"].includes(supplied)
        ? supplied
        : config[key] || randomBytes(32).toString("hex");
  }
  const suppliedEmail = env.SKYVERN_ADMIN_EMAIL?.trim();
  const suppliedHash = env.SKYVERN_ADMIN_PASSWORD_HASH?.trim();
  if (suppliedEmail || suppliedHash) {
    if (!suppliedEmail || !suppliedHash)
      throw new Error("Set both administrator email and password hash");
    config.SKYVERN_ADMIN_EMAIL = suppliedEmail;
    config.SKYVERN_ADMIN_PASSWORD_HASH = suppliedHash;
  }
  let generatedPassword;
  if (!config.SKYVERN_ADMIN_EMAIL && !config.SKYVERN_ADMIN_PASSWORD_HASH) {
    generatedPassword = randomBytes(24).toString("base64url");
    config.SKYVERN_ADMIN_EMAIL = "admin@localhost";
    config.SKYVERN_ADMIN_PASSWORD_HASH =
      await hashAdminPassword(generatedPassword);
  }
  createAdminAuth({ env: config }); // Validate saved and explicit configurations before starting public services.
  if (generatedPassword)
    await writePrivate(
      join(stateDir, "admin-login.txt"),
      `Skyvern admin login\n\nEmail: ${config.SKYVERN_ADMIN_EMAIL}\nPassword: ${generatedPassword}\n\nPrivate file. Sessions persist until logout.\n`,
    );
  await writePrivate(path, JSON.stringify(config));
  return config;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await prepareUnifiedConfig({
      stateDir: process.env.SKYVERN_STATE_DIR || "/data/state",
    });
  } catch {
    console.error(
      "Unified configuration failed. Check admin settings and persistent volume permissions.",
    );
    process.exitCode = 1;
  }
}
