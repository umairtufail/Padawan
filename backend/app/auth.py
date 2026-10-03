"""Who is calling?

Three modes (`AUTH_MODE`):
- `dev`: nobody needs to log in, every request is one dev user (local UI work).
- `admin`: one hardcoded demo account (`ADMIN_USER` / `ADMIN_PASSWORD`). `POST /v1/auth/login` returns a token
  signed by this backend, which later requests send as `Authorization: Bearer <token>`.
- `supabase`: the Bearer token is a Supabase access token (a JWT). We verify its signature against the
  project's public keys (JWKS), its expiry, audience and issuer, and use its `sub` as the user id. The raw
  token is kept so the repository can call Supabase as that user, which lets the database row-level
  security enforce ownership.
"""

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass

import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient

from .config import settings

log = logging.getLogger("padawan.auth")

DEV_USER = "dev-user"
ADMIN_ID = "admin"
ADMIN_ISSUER = "padawan"
ADMIN_AUDIENCE = "padawan-admin"

_fallback_secret = secrets.token_urlsafe(48)


@dataclass(frozen=True)
class AuthUser:
    id: str
    token: str | None = None  # the user's access token (None in dev mode)


# ---------------------------------------------------------------- admin tokens


def _admin_secret() -> str:
    if settings.admin_jwt_secret:
        return settings.admin_jwt_secret
    log.warning("ADMIN_JWT_SECRET is not set: using a random secret, logins reset on restart")
    return _fallback_secret


def check_admin_credentials(username: str, password: str) -> bool:
    """Constant-time comparison of both fields (always evaluates both)."""
    user_ok = secrets.compare_digest(username.encode(), settings.admin_user.encode())
    pass_ok = secrets.compare_digest(password.encode(), settings.admin_password.encode())
    return user_ok and pass_ok


def issue_admin_token() -> tuple[str, int]:
    now = int(time.time())
    ttl = settings.admin_token_ttl_s
    claims = {
        "sub": ADMIN_ID, "name": "Admin", "role": "admin",
        "iss": ADMIN_ISSUER, "aud": ADMIN_AUDIENCE, "iat": now, "exp": now + ttl,
    }
    return jwt.encode(claims, _admin_secret(), algorithm="HS256"), ttl


def _verify_admin_token(token: str) -> AuthUser:
    try:
        claims = jwt.decode(
            token, _admin_secret(), algorithms=["HS256"],
            audience=ADMIN_AUDIENCE, issuer=ADMIN_ISSUER, options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid token")
    return AuthUser(claims["sub"], token)


# ---------------------------------------------------------------- supabase tokens

_jwks: PyJWKClient | None = None


def _signing_key(token: str):
    """Public key that signed this token. Blocking (network on a cache miss), so call in a thread."""
    global _jwks
    if _jwks is None:
        _jwks = PyJWKClient(settings.supabase_jwks_url, cache_keys=True, lifespan=3600)
    return _jwks.get_signing_key_from_jwt(token).key


async def _verify_supabase_token(token: str) -> AuthUser:
    try:
        key = await asyncio.to_thread(_signing_key, token)
        claims = jwt.decode(
            token, key, algorithms=["ES256", "RS256"], audience="authenticated",
            issuer=f"{settings.supabase_url}/auth/v1", options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWKClientConnectionError:
        log.exception("could not fetch the Supabase signing keys")
        raise HTTPException(503, "auth keys unavailable")
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid token")
    return AuthUser(claims["sub"], token)


# ---------------------------------------------------------------- dependency


async def current_user(authorization: str = Header(default="")) -> AuthUser:
    if settings.auth_mode == "dev":
        return AuthUser(DEV_USER)

    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing token")
    token = authorization[7:].strip()

    if settings.auth_mode == "admin":
        return _verify_admin_token(token)
    return await _verify_supabase_token(token)
