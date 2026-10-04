import time

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from app import auth
from app.auth import AuthUser
from app.config import settings
from app.main import app
from app.repo import MemoryRepo, get_repo

URL = "https://proj.supabase.co"
KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())


def token(sub="user-1", key=KEY, **over):
    claims = {"sub": sub, "aud": "authenticated", "iss": f"{URL}/auth/v1", "exp": int(time.time()) + 600, **over}
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, key, algorithm="ES256", headers={"kid": "k1"})


class Recording(MemoryRepo):
    def __init__(self):
        super().__init__()
        self.users: list[AuthUser] = []

    async def create_session(self, user, title, description, language):
        self.users.append(user)
        return await super().create_session(user, title, description, language)


@pytest.fixture
def repo(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "supabase")
    monkeypatch.setattr(settings, "supabase_url", URL)
    monkeypatch.setattr(auth, "_signing_key", lambda t: KEY.public_key())  # stands in for the JWKS lookup
    r = Recording()
    app.dependency_overrides[get_repo] = lambda: r
    yield r
    app.dependency_overrides.clear()


async def create(headers=None):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        return await c.post("/v1/teach/sessions", json={"title": "t"}, headers=headers or {})


async def test_valid_token_identifies_user_and_keeps_token(repo):
    t = token(sub="abc-123")
    r = await create({"Authorization": f"Bearer {t}"})
    assert r.status_code == 201
    assert repo.users == [AuthUser("abc-123", t)]


async def test_supabase_url_trailing_slash_does_not_change_issuer(repo, monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", f"{URL}/")
    r = await create({"Authorization": f"Bearer {token()}"})
    assert r.status_code == 201


async def test_missing_token_401(repo):
    assert (await create()).status_code == 401


@pytest.mark.parametrize(
    "bad",
    [
        lambda: token(exp=int(time.time()) - 10),        # expired
        lambda: token(aud="someone-else"),                # wrong audience
        lambda: token(iss="https://evil.example/auth/v1"),  # wrong issuer
        lambda: token(sub=None),                          # no subject
        lambda: token(key=OTHER_KEY),                     # signed by a different key
        lambda: "not-a-jwt",
    ],
)
async def test_bad_tokens_401(repo, bad):
    r = await create({"Authorization": f"Bearer {bad()}"})
    assert r.status_code == 401


async def test_keys_unavailable_is_503(repo, monkeypatch):
    def boom(_):
        raise jwt.PyJWKClientConnectionError("offline")

    monkeypatch.setattr(auth, "_signing_key", boom)
    r = await create({"Authorization": f"Bearer {token()}"})
    assert r.status_code == 503


async def test_dev_mode_needs_no_token(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    r = await create()
    assert r.status_code == 201
    app.dependency_overrides.clear()
