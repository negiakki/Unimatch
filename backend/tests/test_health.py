"""Tests for the health endpoint and error-handling foundation."""

from fastapi.testclient import TestClient

from app.core.exceptions import AppError
from app.main import create_app


def test_health_endpoint():
    client = TestClient(create_app())
    resp = client.get("/api/v1/health")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "UniMatch API"
    assert body["version"]


def test_unknown_route_returns_404_with_envelope():
    client = TestClient(create_app(), raise_server_exceptions=False)
    resp = client.get("/api/v1/does-not-exist")

    assert resp.status_code == 404
    error = resp.json()["error"]
    assert error["code"] == "not_found"
    assert error["message"]


def test_app_error_is_serialized_to_envelope():
    app = create_app()

    @app.get("/boom")
    async def boom() -> dict:
        raise AppError("kaboom", status_code=418, code="teapot")

    client = TestClient(app)
    resp = client.get("/boom")

    assert resp.status_code == 418
    assert resp.json()["error"] == {"code": "teapot", "message": "kaboom"}
