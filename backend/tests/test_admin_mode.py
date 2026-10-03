import time

import httpx
import jwt
import pytest

from app import auth
from app.config import settings
from app.main import app
from app.repo import _memory
from app.routers import sessions as sessions_router

FRAME = b"\xff\xd8\xff\xe0fake-jpeg"


@pytest.fixture(autouse=True)
def admin_mode(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "admin")
    monkeypatch.setattr(settings, "admin_user", "admin")
    monkeypatch.setattr(settings, "admin_password", "admin")
    monkeypatch.setattr(settings, "admin_jwt_secret", "x" * 40)
    _memory.clear()
    sessions_router._locks.clear()
    sessions_router._summaries.clear()
    yield
    app.dependency_overrides.clear()
    _memory.clear()


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def login(c, username="admin", password="admin"):
    return await c.post("/v1/auth/login", json={"username": username, "password": password})


async def token(c) -> dict:
    r = await login(c)
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_login_success_shape():
    async with client() as c:
        r = await login(c)
    body = r.json()
    assert r.status_code == 200
    assert body["token_type"] == "bearer" and body["expires_in"] == settings.admin_token_ttl_s
    assert body["user"] == {"id": "admin", "name": "Admin"}
    claims = jwt.decode(body["access_token"], "x" * 40, algorithms=["HS256"], audience="padawan-admin")
    assert claims["sub"] == "admin"


@pytest.mark.parametrize("user,pw", [("admin", "wrong"), ("root", "admin"), ("", ""), ("ADMIN", "admin")])
async def test_login_wrong_credentials_401(user, pw):
    async with client() as c:
        r = await login(c, user, pw)
    assert r.status_code == 401 and r.json()["detail"] == "invalid credentials"


async def test_login_uses_configured_credentials(monkeypatch):
    monkeypatch.setattr(settings, "admin_user", "yoda")
    monkeypatch.setattr(settings, "admin_password", "s3cret")
    async with client() as c:
        assert (await login(c, "admin", "admin")).status_code == 401
        assert (await login(c, "yoda", "s3cret")).status_code == 200


async def test_login_disabled_in_supabase_mode(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "supabase")
    async with client() as c:
        assert (await login(c)).status_code == 404


async def test_login_also_works_in_dev_mode(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    async with client() as c:
        assert (await login(c)).status_code == 200


async def test_protected_endpoints_need_a_token():
    async with client() as c:
        for method, path in [("get", "/v1/sessions"), ("get", "/v1/sessions/x"), ("post", "/v1/teach/sessions")]:
            r = await getattr(c, method)(path, **({"json": {"title": "t"}} if method == "post" else {}))
            assert r.status_code == 401, path
        r = await c.post("/v1/sessions/x/frames", data={"t_ms": "1"}, files={"frame": ("f.jpg", FRAME, "image/jpeg")})
        assert r.status_code == 401


async def test_health_is_public():
    async with client() as c:
        assert (await c.get("/health")).status_code == 200


async def test_valid_token_works_end_to_end():
    async with client() as c:
        h = await token(c)
        r = await c.post("/v1/teach/sessions", json={"title": "Invoices"}, headers=h)
        assert r.status_code == 201
        sid = r.json()["session_id"]
        assert (await c.get(f"/v1/sessions/{sid}", headers=h)).status_code == 200


@pytest.mark.parametrize(
    "mutate",
    [
        lambda c: jwt.encode({**c, "exp": int(time.time()) - 5}, "x" * 40, algorithm="HS256"),   # expired
        lambda c: jwt.encode(c, "y" * 40, algorithm="HS256"),                                   # wrong secret
        lambda c: jwt.encode({**c, "aud": "authenticated"}, "x" * 40, algorithm="HS256"),       # wrong audience
        lambda c: jwt.encode({**c, "iss": "evil"}, "x" * 40, algorithm="HS256"),                # wrong issuer
        lambda c: "not-a-jwt",
    ],
)
async def test_bad_admin_tokens_401(mutate):
    claims = {"sub": "admin", "aud": "padawan-admin", "iss": "padawan", "exp": int(time.time()) + 600}
    async with client() as c:
        r = await c.get("/v1/sessions", headers={"Authorization": f"Bearer {mutate(claims)}"})
    assert r.status_code == 401


async def test_supabase_style_token_is_rejected_in_admin_mode():
    t = jwt.encode({"sub": "u", "aud": "authenticated", "exp": int(time.time()) + 600}, "z" * 40, algorithm="HS256")
    async with client() as c:
        r = await c.get("/v1/sessions", headers={"Authorization": f"Bearer {t}"})
    assert r.status_code == 401


async def test_secret_falls_back_to_random_when_unset(monkeypatch):
    monkeypatch.setattr(settings, "admin_jwt_secret", "")
    t, _ = auth.issue_admin_token()
    assert auth._verify_admin_token(t).id == "admin"
    assert len(auth._fallback_secret) >= 32
