"""Keep interactive API docs on the same domain in the unified image."""

from fastapi import FastAPI

from skyvern.forge.api_app import custom_openapi


def test_unified_api_docs_target_the_current_origin(monkeypatch):
    monkeypatch.setenv("SKYVERN_UNIFIED_MODE", "true")
    schema = custom_openapi(FastAPI())
    assert schema["servers"] == [{"url": "/"}]


def test_legacy_api_docs_keep_explicit_deployment_servers(monkeypatch):
    monkeypatch.delenv("SKYVERN_UNIFIED_MODE", raising=False)
    schema = custom_openapi(FastAPI())
    assert schema["servers"][0]["url"] == "https://api.skyvern.com"
