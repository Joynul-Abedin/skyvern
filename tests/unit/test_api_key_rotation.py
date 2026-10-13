"""Exercise local API key rotation without altering deployment credentials."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import jwt
import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient

from skyvern.config import settings
from skyvern.forge.sdk.db.enums import OrganizationAuthTokenType
from skyvern.forge.sdk.routes import ui_session
from skyvern.forge.sdk.routes.routers import base_router, legacy_base_router


@pytest.mark.parametrize("prefix", ["/v1", "/api/v1"])
def test_rotation_routes_require_api_credentials(prefix):
    application = FastAPI()
    application.include_router(base_router, prefix="/v1")
    application.include_router(legacy_base_router, prefix="/api/v1")
    with TestClient(application) as client:
        for endpoint in ("prepare-rotation", "rotate"):
            response = client.post(f"{prefix}/api-key/{endpoint}", json={"api_key": "replacement"})
            assert response.status_code == 422


@pytest.fixture
def rotation(monkeypatch):
    monkeypatch.setattr(settings, "ENV", "local")
    organization = SimpleNamespace(organization_id="org_test")
    validate = AsyncMock(return_value=SimpleNamespace(organization=organization))
    replace = AsyncMock()
    invalidate = Mock()
    monkeypatch.setattr(ui_session, "resolve_org_from_api_key", validate)
    monkeypatch.setattr(ui_session, "invalidate_cached_org", invalidate)
    monkeypatch.setattr(
        ui_session,
        "app",
        SimpleNamespace(DATABASE=SimpleNamespace(organizations=SimpleNamespace(replace_org_auth_token=replace))),
    )
    return validate, replace, invalidate


@pytest.mark.asyncio
async def test_prepared_keys_are_unique_and_inactive_until_committed(rotation):
    validate, replace, invalidate = rotation
    first = await ui_session.prepare_api_key_rotation(Response(), "old-key")
    second = await ui_session.prepare_api_key_rotation(Response(), "old-key")
    assert first.api_key != second.api_key
    replace.assert_not_awaited()
    response = Response()
    await ui_session.rotate_api_key(ui_session.RotateApiKeyRequest(api_key=first.api_key), response, "old-key")
    replace.assert_awaited_once_with(
        organization_id="org_test", token_type=OrganizationAuthTokenType.api, token=first.api_key
    )
    invalidate.assert_called_once_with("org_test")
    assert response.headers["Cache-Control"] == "no-store"
    assert validate.call_args.kwargs["token_types"] == (OrganizationAuthTokenType.api,)


@pytest.mark.asyncio
async def test_rotation_rejects_another_organizations_key(rotation):
    _, replace, _ = rotation
    key = jwt.encode(
        {
            "sub": "org_other",
            "exp": 9999999999,
            "token_type": "api",
            "jti": "random",
            "rotation": True,
        },
        settings.SECRET_KEY,
        algorithm=settings.SIGNATURE_ALGORITHM,
    )
    with pytest.raises(HTTPException) as exc:
        await ui_session.rotate_api_key(ui_session.RotateApiKeyRequest(api_key=key), Response(), "old-key")
    assert exc.value.status_code == 400
    replace.assert_not_awaited()


@pytest.mark.asyncio
async def test_rotation_rejects_invalid_or_unprepared_keys(rotation):
    _, replace, _ = rotation
    for key in (
        "malformed",
        jwt.encode(
            {"sub": "org_test", "exp": 9999999999},
            settings.SECRET_KEY,
            algorithm=settings.SIGNATURE_ALGORITHM,
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await ui_session.rotate_api_key(ui_session.RotateApiKeyRequest(api_key=key), Response(), "old-key")
        assert exc.value.status_code == 400
    replace.assert_not_awaited()


@pytest.mark.asyncio
async def test_rotation_is_local_only(rotation, monkeypatch):
    validate, replace, _ = rotation
    monkeypatch.setattr(settings, "ENV", "production")
    with pytest.raises(HTTPException) as exc:
        await ui_session.prepare_api_key_rotation(Response(), "old-key")
    assert exc.value.status_code == 403
    validate.assert_not_awaited()
    replace.assert_not_awaited()
