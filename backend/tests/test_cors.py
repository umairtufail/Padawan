import httpx
import pytest

from app.main import app


@pytest.mark.parametrize("origin", ["https://padawan-bay.vercel.app", "http://localhost:3000"])
async def test_preflight_allows_known_frontends(origin):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.options(
            "/v1/sessions",
            headers={"Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"},
        )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == origin


async def test_preflight_rejects_unknown_origin():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.options(
            "/v1/sessions", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"}
        )
    assert "access-control-allow-origin" not in r.headers
