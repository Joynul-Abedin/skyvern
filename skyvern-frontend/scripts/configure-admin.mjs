import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hashAdminPassword } from "../adminAuth.js";

const email = (process.argv[2] ?? "admin@localhost").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+$/.test(email))
  throw new Error("Provide a valid admin email address.");
const password = randomBytes(24).toString("base64url");
const hash = await hashAdminPassword(password);
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
let contents;
try {
  contents = await readFile(envPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  contents = await readFile(
    new URL("../.env.example", import.meta.url),
    "utf8",
  );
  contents = contents.replace(
    /^VITE_SKYVERN_API_KEY=YOUR_API_KEY$/m,
    "VITE_SKYVERN_API_KEY=",
  );
}
for (const [key, value] of Object.entries({
  SKYVERN_ADMIN_EMAIL: email,
  SKYVERN_ADMIN_PASSWORD_HASH: hash,
})) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  contents = pattern.test(contents)
    ? contents.replace(pattern, `${key}=${value}`)
    : `${contents.trimEnd()}\n${key}=${value}\n`;
}
const credentialsDir = new URL("../../.skyvern/", import.meta.url);
await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
const credentialsPath = new URL("admin-login.txt", credentialsDir);
await writeFile(
  credentialsPath,
  `Skyvern admin login\n\nEmail: ${email}\nPassword: ${password}\n\nThis file is private and ignored by Git.\n`,
  { mode: 0o600 },
);
await chmod(credentialsPath, 0o600);
await writeFile(envPath, contents, { mode: 0o600 });
await chmod(envPath, 0o600);
console.log(
  `Admin credentials saved to ${fileURLToPath(credentialsPath)}. Password was not printed.`,
);
console.log(
  "Recreate the UI container to apply: docker compose up -d --force-recreate skyvern-ui",
);
