# Unified Skyvern image implementation plan

Goal: ship one runnable image and one published HTTP port, with UI at / and API at /api/v1 on any domain.

Architecture: nginx routes one public listener to an internal API and authenticated UI. PostgreSQL runs internally by default; DATABASE_STRING opts into an external database. One /data volume preserves PostgreSQL, API credentials, admin sessions, encryption secrets, artifacts and browser data. Browser endpoints resolve against the current origin, including wss for HTTPS.

Implementation proceeds inline under the user's instruction to build the unified image.

- [x] Add tests for relative browser API/artifact/WebSocket URLs; normalize URLs centrally and update direct WebSocket env consumers.
- [x] Add bootstrap tests: generated admin login and secrets survive restart; explicit credentials are respected; malformed configuration fails closed.
- [x] Add authenticated proxy check endpoint and tests; configure nginx API aliases, streaming, upload support, health and protected diagnostics.
- [x] Build a standalone Dockerfile from the pinned existing backend runtime plus current source, built UI, nginx, PostgreSQL and process supervision. Exclude all local secrets and deployment data from its build context.
- [x] Add startup/bootstrap orchestration, readiness, PostgreSQL initialization/migrations, local organization/API key setup and graceful shutdown.
- [x] Make the UI launcher support its unified runtime directory. Add one-service Compose and .env example plus HTTPS subdomain deployment instructions.
- [x] Build and run against a clean disposable volume. Verify login, same-origin API, uploads, artifacts, WebSockets, API-key rotation, container recreation and logout. Confirm only one exposed/published port and no build secrets.
- [x] Run appropriate automated checks and document results. Preserve the existing local data and provide a unified local instance.

Review focus: HTTPS behind an ingress; missing/invalid admin configuration; stale credentials after key rotation or restart; unauthenticated diagnostics/artifacts; shutdown with active database connections; startup failure must not leave a falsely healthy container.
