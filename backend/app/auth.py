"""Who is calling? In `supabase` mode the Bearer token is a Supabase access token (a JWT).

We verify its signature against the project's public keys (JWKS), its expiry, audience and issuer,
and use its `sub` as the user id. The raw token is kept so the repository can call Supabase as that
user, which lets the database row-level security enforce ownership.

In `dev` mode (local UI work) nobody needs to log in and every request is one dev user.
"""

import asyncio
import logging
from dataclasses import dataclass

import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient

from .config import settings

log = logging.getLogger("padawan.auth")

DEV_USER = "dev-user"


@dataclass(frozen=True)
class AuthUser:
    id: str
    token: str | None = None  # the user's Supabase access token (None in dev mode)


_jwks: PyJWKClient | None = None


def _signing_key(token: str):
    """Public key that signed this token. Blocking (network on a cache miss), so call in a thread."""
    global _jwks
    if _jwks is None:
        _jwks = PyJWKClient(settings.supabase_jwks_url, cache_keys=True, lifespan=3600)
    return _jwks.get_signing_key_from_jwt(token).key


async def current_user(authorization: str = Header(default="")) -> AuthUser:
    if settings.auth_mode == "dev":
        return AuthUser(DEV_USER)

    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing token")
    token = authorization[7:].strip()

    try:
        key = await asyncio.to_thread(_signing_key, token)
        claims = jwt.decode(
            token,
            key,
            algorithms=["ES256", "RS256"],
            audience="authenticated",
            issuer=f"{settings.supabase_url}/auth/v1",
            options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWKClientConnectionError:
        log.exception("could not fetch the Supabase signing keys")
        raise HTTPException(503, "auth keys unavailable")
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid token")
    return AuthUser(claims["sub"], token)
