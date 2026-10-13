"""Check credential persistence during unified-image database bootstrap."""

import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import toml

spec = importlib.util.spec_from_file_location(
    "unified_database_bootstrap", Path.cwd() / "docker/unified/bootstrap_database.py"
)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


@pytest.mark.asyncio
async def test_new_database_writes_private_api_credentials(tmp_path, monkeypatch):
    credentials = tmp_path / "credentials.toml"
    monkeypatch.setenv("SKYVERN_CREDENTIALS_FILE", str(credentials))
    organization = SimpleNamespace(organization_id="org_test")
    organizations = SimpleNamespace(
        get_organization_by_domain=AsyncMock(return_value=None),
        create_organization=AsyncMock(return_value=organization),
        get_valid_org_auth_token=AsyncMock(return_value=None),
        create_org_auth_token=AsyncMock(return_value=SimpleNamespace(token="new-api-key")),
    )
    database = SimpleNamespace(organizations=organizations, engine=SimpleNamespace(dispose=AsyncMock()))
    monkeypatch.setattr(bootstrap, "AgentDB", lambda *_args: database)
    monkeypatch.setattr(bootstrap, "create_access_token", lambda *_args, **_kwargs: "new-api-key")
    await bootstrap.bootstrap_database()
    saved = toml.loads(credentials.read_text())
    assert saved["skyvern"]["configs"][0]["orgs"][0]["cred"] == "new-api-key"
    assert os.stat(credentials).st_mode & 0o777 == 0o600
    database.engine.dispose.assert_awaited_once()


@pytest.mark.asyncio
async def test_restart_preserves_existing_credentials_without_reactivating_a_revoked_key(tmp_path, monkeypatch):
    credentials = tmp_path / "credentials.toml"
    credentials.write_text("existing-credentials")
    monkeypatch.setenv("SKYVERN_CREDENTIALS_FILE", str(credentials))

    def unexpected_database(*_args):
        raise AssertionError("Existing credentials must not be regenerated")

    monkeypatch.setattr(bootstrap, "AgentDB", unexpected_database)
    await bootstrap.bootstrap_database()
    assert credentials.read_text() == "existing-credentials"
