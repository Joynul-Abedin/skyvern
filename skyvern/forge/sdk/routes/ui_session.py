import asyncio
from datetime import UTC, datetime
from typing import Annotated
from uuid import uuid4

import jwt
from fastapi import Header, HTTPException, Response
from jwt.exceptions import PyJWTError
from pydantic import BaseModel, Field

from skyvern.config import settings
from skyvern.forge import app
from skyvern.forge.sdk.db.enums import OrganizationAuthTokenType
from skyvern.forge.sdk.routes.routers import base_router, legacy_base_router
from skyvern.forge.sdk.services.org_auth_service import (
    invalidate_cached_org,
    resolve_org_from_api_key,
)
from skyvern.forge.sdk.services.org_auth_token_service import (
    API_KEY_LIFETIME,
    create_org_ui_session_token,
)

_rotation_lock = asyncio.Lock()


class ApiKeyResponse(BaseModel):
    """Private API credential returned only to authenticated callers."""

    api_key: str


class RotateApiKeyRequest(BaseModel):
    """Replacement credential signed by the preparation endpoint."""

    api_key: str = Field(min_length=1, max_length=4096)


def _require_local_rotation() -> None:
    if settings.ENV != "local":
        raise HTTPException(status_code=403, detail="API key rotation is available locally only")


@legacy_base_router.post("/api-key/prepare-rotation", response_model=ApiKeyResponse, include_in_schema=False)
@base_router.post("/api-key/prepare-rotation", response_model=ApiKeyResponse, include_in_schema=False)
async def prepare_api_key_rotation(response: Response, x_api_key: Annotated[str, Header()]) -> ApiKeyResponse:
    """Sign an inactive replacement so the UI can save it before revocation.

    Args:
        response: HTTP response receiving the no-store cache policy.
        x_api_key: Current workspace API credential.

    Returns:
        A signed replacement that cannot authenticate until committed.
    """
    _require_local_rotation()
    validation = await resolve_org_from_api_key(x_api_key, app.DATABASE, token_types=(OrganizationAuthTokenType.api,))
    key = jwt.encode(
        {
            "sub": validation.organization.organization_id,
            "exp": datetime.now(UTC) + API_KEY_LIFETIME,
            "token_type": OrganizationAuthTokenType.api.value,
            "jti": str(uuid4()),
            "rotation": True,
        },
        settings.SECRET_KEY,
        algorithm=settings.SIGNATURE_ALGORITHM,
    )
    response.headers["Cache-Control"] = "no-store"
    return ApiKeyResponse(api_key=key)


@legacy_base_router.post("/api-key/rotate", response_model=ApiKeyResponse, include_in_schema=False)
@base_router.post("/api-key/rotate", response_model=ApiKeyResponse, include_in_schema=False)
async def rotate_api_key(
    body: RotateApiKeyRequest, response: Response, x_api_key: Annotated[str, Header()]
) -> ApiKeyResponse:
    """Atomically replace API credentials while preserving browser sessions.

    Args:
        body: Previously prepared replacement for the same organization.
        response: HTTP response receiving the no-store cache policy.
        x_api_key: Current workspace API credential.

    Returns:
        The active replacement API credential.
    """
    _require_local_rotation()
    async with _rotation_lock:
        validation = await resolve_org_from_api_key(
            x_api_key, app.DATABASE, token_types=(OrganizationAuthTokenType.api,)
        )
        org_id = validation.organization.organization_id
        try:
            payload = jwt.decode(body.api_key, settings.SECRET_KEY, algorithms=[settings.SIGNATURE_ALGORITHM])
        except PyJWTError:
            raise HTTPException(status_code=400, detail="Invalid replacement API key") from None
        if (
            payload.get("sub") != org_id
            or payload.get("token_type") != OrganizationAuthTokenType.api.value
            or payload.get("rotation") is not True
            or not payload.get("jti")
        ):
            raise HTTPException(status_code=400, detail="Invalid replacement API key")
        await app.DATABASE.organizations.replace_org_auth_token(
            organization_id=org_id, token_type=OrganizationAuthTokenType.api, token=body.api_key
        )
        invalidate_cached_org(org_id)
    response.headers["Cache-Control"] = "no-store"
    return ApiKeyResponse(api_key=body.api_key)


class UISessionTokenResponse(BaseModel):
    token: str
    expires_at: int


@legacy_base_router.post(
    "/ui-session",
    response_model=UISessionTokenResponse,
    include_in_schema=False,
)
@base_router.post(
    "/ui-session",
    response_model=UISessionTokenResponse,
    include_in_schema=False,
)
async def create_ui_session_token(
    response: Response,
    x_api_key: Annotated[str, Header()],
) -> UISessionTokenResponse:
    validation = await resolve_org_from_api_key(
        x_api_key,
        app.DATABASE,
        token_types=(OrganizationAuthTokenType.api,),
    )
    auth_token, expires_at = await create_org_ui_session_token(validation.organization.organization_id)
    response.headers["Cache-Control"] = "no-store"
    return UISessionTokenResponse(token=auth_token.token, expires_at=expires_at)
