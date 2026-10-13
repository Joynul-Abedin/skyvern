"""Bootstrap and supervise the services in the single-port Skyvern container."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from urllib.parse import quote

SERVICES: list[tuple[str, subprocess.Popen]] = []
STOPPING = False


def start(name: str, command: list[str], *, cwd: str = "/app") -> subprocess.Popen:
    """Start a service in a separate process group for deterministic shutdown."""
    process = subprocess.Popen(command, cwd=cwd, start_new_session=True)
    SERVICES.append((name, process))
    print(f"Started {name}", flush=True)
    return process


def check_services() -> None:
    """Fail the container if any essential process exits unexpectedly."""
    for name, process in SERVICES:
        if process.poll() is not None:
            raise RuntimeError(f"Required service exited: {name}")


def wait_ready(probe: Callable[[], bool], name: str, timeout: int = 180) -> None:
    """Wait for readiness while also detecting an early process failure."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        check_services()
        try:
            if probe():
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f"Timed out waiting for {name}")


def http_ready(url: str) -> bool:
    """Return whether an internal HTTP service is ready."""
    with urllib.request.urlopen(url, timeout=3) as response:
        return response.status == 200


def stop_services(*_args: object) -> None:
    """Stop processes in reverse dependency order, including PostgreSQL."""
    global STOPPING
    if STOPPING:
        return
    STOPPING = True
    for name, process in reversed(SERVICES):
        if process.poll() is not None:
            continue
        try:
            os.killpg(process.pid, signal.SIGINT if name == "postgres" else signal.SIGTERM)
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        except ProcessLookupError:
            pass
    raise SystemExit(0)


def prepare_postgres(config: dict[str, str]) -> None:
    """Initialize a private PostgreSQL cluster unless an external database is configured."""
    if os.environ.get("DATABASE_STRING"):
        return
    directory = Path("/data/postgres")
    directory.mkdir(parents=True, exist_ok=True)
    shutil.chown(directory, user="postgres", group="postgres")
    directory.chmod(0o700)
    bindir = subprocess.check_output(["pg_config", "--bindir"], text=True).strip()
    password = config["SKYVERN_POSTGRES_PASSWORD"]
    if not (directory / "PG_VERSION").exists():
        descriptor, password_path = tempfile.mkstemp(prefix="skyvern-pg-")
        try:
            with os.fdopen(descriptor, "w") as output:
                output.write(password)
            shutil.chown(password_path, user="postgres", group="postgres")
            subprocess.run(
                [
                    "runuser",
                    "-u",
                    "postgres",
                    "--",
                    f"{bindir}/initdb",
                    "-D",
                    str(directory),
                    "--username=skyvern",
                    "--auth=scram-sha-256",
                    f"--pwfile={password_path}",
                ],
                check=True,
            )
        finally:
            Path(password_path).unlink(missing_ok=True)
    start(
        "postgres",
        [
            "runuser",
            "-u",
            "postgres",
            "--",
            f"{bindir}/postgres",
            "-D",
            str(directory),
            "-c",
            "listen_addresses=127.0.0.1",
            "-c",
            "jit=off",
            "-c",
            "unix_socket_directories=/tmp",
        ],
    )
    wait_ready(
        lambda: (
            subprocess.run(
                ["pg_isready", "-h", "127.0.0.1", "-U", "skyvern"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            ).returncode
            == 0
        ),
        "PostgreSQL",
    )
    connection_env = {**os.environ, "PGPASSWORD": password}
    exists = subprocess.check_output(
        [
            "psql",
            "-h",
            "127.0.0.1",
            "-U",
            "skyvern",
            "-d",
            "postgres",
            "-tAc",
            "SELECT 1 FROM pg_database WHERE datname='skyvern'",
        ],
        env=connection_env,
        text=True,
    ).strip()
    if not exists:
        subprocess.run(
            ["createdb", "-h", "127.0.0.1", "-U", "skyvern", "skyvern"],
            env=connection_env,
            check=True,
        )
    os.environ["DATABASE_STRING"] = f"postgresql+psycopg://skyvern:{quote(password, safe='')}@127.0.0.1:5432/skyvern"


def main() -> None:
    """Start the database, browser services, API, UI and one public gateway."""
    os.umask(0o077)
    signal.signal(signal.SIGTERM, stop_services)
    signal.signal(signal.SIGINT, stop_services)
    state = Path(os.environ.get("SKYVERN_STATE_DIR", "/data/state"))
    os.environ["SKYVERN_STATE_DIR"] = str(state)
    subprocess.run(["node", "/app/docker/unified/bootstrap.mjs"], check=True)
    config = json.loads((state / "unified-config.json").read_text())
    os.environ.update(config)
    os.environ.update(
        {
            "PORT": "8000",
            "ENV": "local",
            "SKYVERN_DEV_NO_RELOAD": "true",
            "SKYVERN_UNIFIED_MODE": "true",
            "SKYVERN_CREDENTIALS_FILE": str(state / "credentials.toml"),
            "SKYVERN_ADMIN_SESSIONS_FILE": str(state / "admin-sessions.json"),
            "SKYVERN_UI_API_KEY_FILE": str(state / "ui-api-key.json"),
            "SKYVERN_API_BASE_URL": "http://127.0.0.1:8000/api/v1",
            "VITE_API_BASE_URL": "/api/v1",
            "VITE_WSS_BASE_URL": "/api/v1",
            "VITE_ARTIFACT_API_BASE_URL": "/artifacts",
            "VITE_ENVIRONMENT": "local",
            "SKYVERN_UI_ROOT": "/app/skyvern-frontend",
            "SKYVERN_UI_BIND_HOST": "127.0.0.1",
            "SKYVERN_ARTIFACT_BIND_HOST": "127.0.0.1",
            "DISPLAY": ":99",
        }
    )
    if public_url := os.environ.get("PUBLIC_URL"):
        os.environ["SKYVERN_BASE_URL"] = public_url.rstrip("/")
        os.environ["SKYVERN_APP_URL"] = public_url.rstrip("/")
        os.environ.setdefault("SKYVERN_ADMIN_COOKIE_SECURE", str(public_url.startswith("https://")).lower())
    for name in (
        "artifacts",
        "videos",
        "har",
        "log",
        "downloads",
        "browser_sessions",
        "credential_vault",
    ):
        Path("/data", name).mkdir(parents=True, exist_ok=True)
    for variable, directory in {
        "VIDEO_PATH": "videos",
        "HAR_PATH": "har",
        "LOG_PATH": "log",
        "DOWNLOAD_PATH": "downloads",
        "ARTIFACT_STORAGE_PATH": "artifacts",
        "BROWSER_SESSION_BASE_PATH": "browser_sessions",
        "LOCAL_CREDENTIAL_VAULT_PATH": "credential_vault",
        "TEMP_PATH": "temp",
    }.items():
        os.environ[variable] = f"/data/{directory}"
        Path("/data", directory).mkdir(parents=True, exist_ok=True)
    prepare_postgres(config)
    # PostgreSQL migrations apply once before any API/UI process can accept traffic.
    subprocess.run(["alembic", "upgrade", "head"], cwd="/app", check=True)
    subprocess.run([sys.executable, "/app/docker/unified/bootstrap_database.py"], cwd="/app", check=True)
    Path("/tmp/.X99-lock").unlink(missing_ok=True)
    start("display", ["Xvfb", ":99", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"])
    wait_ready(
        lambda: (
            subprocess.run(
                ["xdpyinfo", "-display", ":99"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
            ).returncode
            == 0
        ),
        "browser display",
        30,
    )
    start(
        "vnc",
        [
            "x11vnc",
            "-display",
            ":99",
            "-forever",
            "-nopw",
            "-shared",
            "-localhost",
            "-rfbport",
            "5900",
            "-quiet",
        ],
    )
    start("vnc-websocket", ["websockify", "127.0.0.1:6080", "127.0.0.1:5900"])
    start("streaming", [sys.executable, "/app/run_streaming.py"])
    start(
        "api",
        [
            sys.executable,
            "-m",
            "uvicorn",
            "skyvern.forge.api_app:create_api_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
            "--ws",
            "websockets-sansio",
            "--ws-ping-timeout",
            "120",
            "--no-access-log",
        ],
    )
    wait_ready(lambda: http_ready("http://127.0.0.1:8000/api/v1/heartbeat"), "API")
    start("ui", ["bash", "/app/entrypoint-skyvernui.sh"], cwd="/app/skyvern-frontend")
    wait_ready(lambda: http_ready("http://127.0.0.1:8080/auth/status"), "UI")
    subprocess.run(["nginx", "-t", "-c", "/app/docker/unified/nginx.conf"], check=True)
    start("gateway", ["nginx", "-c", "/app/docker/unified/nginx.conf", "-g", "daemon off;"])
    print("Skyvern is ready on port 80. Initial admin login: /data/state/admin-login.txt", flush=True)
    while True:
        check_services()
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        # Never print subprocess arguments or environment: they can contain credentials.
        print(
            f"Unified startup failed ({type(error).__name__}); stopping services.",
            file=sys.stderr,
            flush=True,
        )
        try:
            stop_services()
        except SystemExit:
            raise SystemExit(1) from None
