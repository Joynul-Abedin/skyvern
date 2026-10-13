"""Create the local organization/API credential without printing reusable secrets."""

import asyncio
import json
import os
from pathlib import Path

from skyvern.config import settings
from skyvern.forge.sdk.core.security import create_access_token
from skyvern.forge.sdk.db.agent_db import AgentDB
from skyvern.forge.sdk.db.enums import OrganizationAuthTokenType
from skyvern.forge.sdk.services.org_auth_token_service import API_KEY_LIFETIME


async def bootstrap_database() -> None:
    """Reuse existing credentials or create a local organization and private credentials file."""
    path = Path(os.environ["SKYVERN_CREDENTIALS_FILE"])
    if path.exists():
        return
    database = AgentDB(settings.DATABASE_STRING)
    try:
        organization = await database.organizations.get_organization_by_domain("skyvern.local")
        if organization is None:
            organization = await database.organizations.create_organization("Skyvern", domain="skyvern.local")
        token = await database.organizations.get_valid_org_auth_token(
            organization.organization_id, OrganizationAuthTokenType.api
        )
        if token is None:
            key = create_access_token(organization.organization_id, expires_delta=API_KEY_LIFETIME)
            token = await database.organizations.create_org_auth_token(
                organization_id=organization.organization_id,
                token_type=OrganizationAuthTokenType.api,
                token=key,
            )
        contents = (
            '[skyvern]\nconfigs = [{env="local", host="http://127.0.0.1:8000/api/v1", orgs=[{name="Skyvern", cred='
            + json.dumps(token.token)
            + "}]}]\n"
        )
        temporary = path.with_suffix(".tmp")
        with open(temporary, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:  # noqa: ASYNC230
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
        print("Workspace API credential is ready; retrieve it from Settings after signing in.")
    finally:
        await database.engine.dispose()


if __name__ == "__main__":
    asyncio.run(bootstrap_database())
