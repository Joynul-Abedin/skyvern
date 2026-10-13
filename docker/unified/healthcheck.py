"""Check both API readiness and the authenticated UI process without credentials."""

import urllib.request

for endpoint in ("http://127.0.0.1/healthz", "http://127.0.0.1:8080/auth/status"):
    with urllib.request.urlopen(endpoint, timeout=5) as response:
        if response.status != 200:
            raise SystemExit(1)
