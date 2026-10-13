<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Skyvern Frontend](#skyvern-frontend)
  - [Quickstart](#quickstart)
    - [Populate env file](#populate-env-file)
  - [Development](#development)
  - [Single admin login](#single-admin-login)
  - [Build for production](#build-for-production)
  - [Preview the production build locally](#preview-the-production-build-locally)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# Skyvern Frontend

## Quickstart

### Populate env file

Copy example env file:

```sh
cp .env.example .env
```

Populate `VITE_SKYVERN_API_KEY` with your API key.

Then run:

```sh
npm install
```

```sh
npm start
```

This will build the app and serve from port 8080.

## Development

```sh
npm run dev
```

This will start the development server with hot module replacement.

## Single admin login

For a self-hosted workspace, generate an admin account from this directory:

```sh
npm run configure-admin -- admin@example.com
```

This writes the email and a salted scrypt password hash to `skyvern-frontend/.env`.
The generated password is saved in `.skyvern/admin-login.txt` at the repository root
with owner-only permissions. Both files are ignored by Git. The password is never
printed or included in the frontend bundle. Run the command again to rotate the
password, then recreate the UI container.

The UI server reads `SKYVERN_ADMIN_EMAIL` and `SKYVERN_ADMIN_PASSWORD_HASH`; leave
both empty to retain the existing automatic local-session behavior. Setting only
one, or providing an invalid hash, prevents startup. Never use a `VITE_` prefix for
these settings, since Vite exposes those variables to browser code.

Admin sessions have no application timeout and survive browser and UI server
restarts until you sign out. Session records contain only token hashes and are
saved privately (mode `0600`) in `.skyvern/admin-sessions.json`; set
`SKYVERN_ADMIN_SESSIONS_FILE` to override this path. Persist its directory across
container recreation. The local Compose stack already mounts it. Changing the
admin email or password deliberately invalidates previous sessions. The old
`SKYVERN_ADMIN_SESSION_HOURS` setting is no longer used.

Sessions use HttpOnly, SameSite cookies. Browsers cap cookie persistence at 400
days, so each authenticated request renews that retention window; clearing browser
cookies or exceeding the browser's own retention limit requires signing in again.
Logout removes the saved session, so a copied cookie stays invalid after restart.
Login forms share a browser CSRF nonce so opening a second sign-in tab does not
invalidate the first. A missing or stale nonce rejects the submission and renders
a fresh form with an inline message. Revisiting `/auth/login` redirects to the
sign-in page or the existing signed-in workspace.
Enable
`SKYVERN_ADMIN_COOKIE_SECURE=true` when serving over HTTPS. Wrong-password attempts
are limited to five per socket address in a fifteen-minute window.

Use `npm start` or `npm run dev` to enforce login. Static preview servers such as
`vite preview` and `npx serve` do not run the login gate. For Docker, build the UI
from source so the new server code is included:

```sh
docker compose build skyvern-ui
docker compose up -d skyvern-ui
```

The repository's local `docker-compose.override.yml` configures this build and
serves the UI at `http://localhost:8081`. It routes artifact requests through the
authenticated UI server at `/artifacts` and does not publish the artifact server's
port. For a different deployment, set `VITE_ARTIFACT_API_BASE_URL` to your UI origin
plus `/artifacts` and remove the artifact server's published port. When using
Vite development, start the artifact server separately with `npm run artifact-server`.

After signing in, open **Settings → API key** and click **Show API key**, then
**Copy API key**. This reveals the workspace's long-lived API key for curl, SDKs,
and integrations. The separate **Browser session token** expires automatically.
The long-lived key is fetched only after this explicit admin action, is not saved
in browser storage, and is cleared from the field when you click **Hide API key**.
Key disclosure requires a valid admin cookie and a same-origin POST; it is
unavailable when admin login is not configured.

Use **Rotate API key** in the same card when you need a replacement. Confirming
invalidates all existing workspace API keys; update your scripts and integrations
with the new key. Browser session tokens and the admin login remain valid.
Rotation requires the local API and a signed-in admin. The server saves the new
key privately in `.skyvern/ui-api-key.json` (mode `0600`), which takes precedence
over the original environment/TOML key on subsequent requests and restarts.
`SKYVERN_UI_API_KEY_FILE` can override this path; persist its directory across
container recreation. A pending replacement is saved before database revocation
so a lost response can be recovered with **Show API key** or after restart.
The local Compose stack already mounts this directory. Run the rotation and
authorization checks with `npm run test:api-key-rotation`.

The sidebar's **Sign out** button ends the admin session, clears the browser's API
token and query cache, and notifies other tabs. The direct API continues to require
its existing API keys. Already issued UI bearer tokens retain their API expiry
(controlled by the backend's `UI_SESSION_TOKEN_TTL_MINUTES`); admin logout does not
revoke those tokens at the API. No new tokens can be obtained through the UI until
the admin signs in again.

Docker can forward local browser requests from a bridge address instead of
loopback. In local mode, the API's auth and LLM diagnostics accept a validated API
key or UI session on those connections. Non-loopback requests without a valid
credential remain blocked, and diagnostics remain unavailable outside local mode.

Run the HTTP-level login checks with `npm run test:admin-auth`. Session and CSRF
controls follow the [OWASP session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Build for production

```sh
npm run build
```

This will make a production build in the `dist` directory, ready to be served.

## Preview the production build locally

```sh
npm run preview
```

or alternatively, use the `serve` package:

```sh
npx serve@latest dist
```
