# One-image, one-port Skyvern

The `skyvern:unified` image contains the API, UI, PostgreSQL, Chromium browser services, and an HTTP gateway. Publish only container port **80**. Use one persistent volume at `/data`.

| Path | Service |
| --- | --- |
| `/` | UI with persistent admin login |
| `/api/v1` | API for scripts and integrations using `x-api-key` |
| `/v1`, `/api/v2` | API compatibility routes used by the dashboard |
| `/artifacts` | Admin-authenticated local artifact access |
| `/docs` | API documentation |
| `/healthz` | API readiness |

Browser HTTP requests, uploads, WebSockets and streaming all use the domain you opened. Frontend API URLs do not need separate configuration or a rebuild when you change domains. The long-lived API key is available in **Settings → API key**, with copy and rotation controls.

## Start locally

```sh
cp .env.unified.example .env.unified
# Set your LLM provider/key in .env.unified.
docker compose --env-file .env.unified -f docker-compose.unified.yml up -d --build
```

Open `http://localhost:8081`. To change the host port, set `SKYVERN_PORT` in `.env.unified`. This Compose file is independent of the existing three-service deployment and does not load its override file. Stop the old UI first if it already occupies 8081.

When administrator credentials are omitted, first startup generates them privately:

```sh
docker compose -f docker-compose.unified.yml exec skyvern cat /data/state/admin-login.txt
```

Alternatively supply `SKYVERN_ADMIN_EMAIL` and the existing scrypt `SKYVERN_ADMIN_PASSWORD_HASH`. Login stays valid across browser/container restarts until explicit logout, subject to browser cookie retention. No plaintext admin password or API key is baked into the image.

Direct Docker usage after building (export `OPENAI_API_KEY` in your shell first):

```sh
docker build -f Dockerfile.unified -t skyvern:unified .
docker run -d --name skyvern --restart unless-stopped --shm-size=2g \
  -e ENABLE_OPENAI=true -e LLM_KEY=OPENAI_GPT5_5 -e OPENAI_API_KEY \
  -p 8081:80 -v skyvern-data:/data skyvern:unified
```

The local `.env.unified` generated for this workspace uses port **8082** so the
existing deployment on 8081 can keep running. It uses the same admin credentials
and LLM provider, with its own persistent database. Use your existing
`.skyvern/admin-login.txt` credentials for this configured local instance.

Use Compose for the supplied `.env.unified`: unlike Compose, Docker CLI env files
do not remove dotenv quotes or expand values. The direct Docker example passes the
provider key from your shell.

The Docker run port mapping is explicit; `SKYVERN_PORT` is a Compose host-port setting.

## Put it on your HTTPS subdomain

Run the image on your public server. Point your subdomain's DNS record at that server. In your existing reverse proxy, route the **whole domain**, including WebSockets, to the single Skyvern HTTP port. Set:

```dotenv
PUBLIC_URL=https://skyvern.example.com
SKYVERN_PORT=8081
SKYVERN_BIND_ADDRESS=127.0.0.1
```

Use `127.0.0.1` when the reverse proxy runs on the same host. A proxy in another container should use a shared Docker network and reach `skyvern:80`, or use an appropriate reachable host bind address. `PUBLIC_URL` enables Secure cookies and sets the API's public origin for generated links. TLS terminates at your edge proxy; Skyvern needs one HTTP upstream and one hostname.

Example Caddy configuration on the same host:

```caddyfile
skyvern.example.com {
    reverse_proxy 127.0.0.1:8081
}
```

Caddy's public TLS listener belongs to the edge proxy; the Skyvern container still publishes only one HTTP port. A proxy management UI such as Nginx Proxy Manager or a hosting platform's domain router can target the same upstream. Forward the original Host and X-Forwarded-Proto headers and allow WebSocket upgrades. DNS/TLS and a reachable public server are required for access outside your local network.

API example on the same domain:

```sh
curl 'https://skyvern.example.com/api/v1/organizations/me' \
  -H "x-api-key: $SKYVERN_API_KEY"
```

No separate API subdomain or CORS configuration is required. Internal diagnostics require administrator login at the gateway; regular API routes use their existing API-key authentication.

## Persistent data and upgrades

`/data` contains PostgreSQL data, artifacts, downloads, browser sessions, the credential vault and private state files. Preserve the entire volume when recreating or upgrading the container. Deployment signing/encryption secrets are generated once and retained in `/data/state/unified-config.json`. API-key rotation and administrator logout persist there too.

```sh
docker compose --env-file .env.unified -f docker-compose.unified.yml up -d --build
```

The image includes PostgreSQL 15. Do not directly mount a PostgreSQL 14 data directory into it. To preserve a legacy deployment's database, either restore a logical database backup into the new cluster or configure its existing PostgreSQL as an external database:

```dotenv
DATABASE_STRING=postgresql+psycopg://skyvern:password@postgres-host:5432/skyvern
```

This skips the embedded PostgreSQL process. The external database must already exist and be reachable. Preserve the original `SECRET_KEY` and `ENCRYPTOR_AES_SECRET_KEY`, and copy the previous `.skyvern` state files into `/data/state` to retain credentials and login sessions. Existing artifacts and browser state also need their corresponding `/data` directories preserved. Database migrations run before the API starts.

The backend runtime is pinned by digest in `Dockerfile.unified` and current repository source is included. When changing Python dependencies, build an updated backend runtime first and pass its tag with `--build-arg SKYVERN_BACKEND_IMAGE=your-backend-image`. This avoids silently combining newer dependency requirements with an older base runtime.

## Verification

```sh
cd skyvern-frontend
node --test tests/adminAuth.node.mjs tests/apiKeyRotation.node.mjs tests/unifiedBootstrap.node.mjs
npx vitest run src/util/serviceUrl.test.ts src/util/env.test.ts src/api/AxiosClient.test.ts src/hooks/useRuntimeConfig.test.ts
```

## Image size and server requirements

The image is built as one flattened layer: about **0.93 GB to download/store compressed** (about 2.9 GB unpacked), versus about 1.5 GB / 5 GB before slimming. Only Chromium is kept (Firefox and WebKit are removed), along with the services and tools the unified runtime uses. Chromium locale packs other than en-US, boto3 type stubs, the Playwright private Node runtime, PostgreSQL JIT, Mesa software GL, headers, docs and the copied repository sources are not shipped.

Plan for the container at runtime:

| Resource | Minimum | Notes |
| --- | --- | --- |
| Disk | 5 GB free, plus data growth | Image plus `/data` (PostgreSQL, artifacts, videos, HAR). Videos and HAR files grow fastest. |
| RAM | 4 GB | Chromium, PostgreSQL and the API share one container. Add about 1 GB per concurrent browser run. |
| CPU | 2 vCPU | Browser automation is CPU-bound. |
| Shared memory | `shm_size: 2gb` | Already set in Compose; required for Chromium stability. |

Docker logs are capped at 3 x 10 MB in Compose so they cannot fill the disk. Removing old artifacts, videos and HAR files from `/data` is the main way to reclaim space later.

## CPU architecture

The Dockerfile supports Linux AMD64 and ARM64 through its multi-platform base images.
The image built on an Apple Silicon Mac is ARM64. Build on the destination server
for its native architecture, or publish a multi-platform image to your own registry:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f Dockerfile.unified -t YOUR_REGISTRY/skyvern:unified --push .
```

No image has been pushed to a remote registry by this setup.
