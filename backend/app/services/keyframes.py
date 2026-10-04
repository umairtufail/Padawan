"""Step keyframes: one small JPEG per salient frame or step boundary, in the private `keyframes` bucket.

Path: `{user_id}/{session_id}/{t_ms}.jpg`. The backend uploads and signs URLs AS THE USER (their JWT), so
storage row-level security (see supabase/migrations) keeps files owner-only. Nothing here may break the
frame response: callers treat any failure as "no keyframe".
"""

import io
import logging
from typing import Protocol

import httpx
from PIL import Image, ImageOps

from ..auth import AuthUser
from ..config import settings

log = logging.getLogger("padawan.keyframes")

BUCKET = "keyframes"
MAX_WIDTH = 640
JPEG_QUALITY = 60
SIGNED_URL_TTL_S = 300


class KeyframeError(Exception):
    """Storage failed (network, permissions, bad response)."""


class KeyframeNotFound(KeyframeError):
    pass


def keyframe_path(user_id: str, session_id: str, t_ms: int) -> str:
    return f"{user_id}/{session_id}/{int(t_ms)}.jpg"


def shrink(data: bytes) -> bytes:
    """Downscale to at most MAX_WIDTH px wide and recompress as JPEG (drops EXIF). Raises on bad images."""
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if im.width > MAX_WIDTH:
            im = im.resize((MAX_WIDTH, max(1, round(im.height * MAX_WIDTH / im.width))), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True)
        return out.getvalue()


class KeyframeStore(Protocol):
    async def upload(self, user: AuthUser, path: str, jpeg: bytes) -> None: ...

    async def signed_url(self, user: AuthUser, path: str, expires_in: int = SIGNED_URL_TTL_S) -> str:
        """Raises KeyframeNotFound when there is no such file (or it is not the user's)."""
        ...


class MemoryKeyframes:
    """For `dev`/`admin` modes and tests: bytes in a dict, a fake URL."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}

    def clear(self) -> None:
        self.files.clear()

    async def upload(self, user, path, jpeg) -> None:
        if not path.startswith(f"{user.id}/"):
            raise KeyframeError("not your folder")
        self.files[path] = jpeg

    async def signed_url(self, user, path, expires_in=SIGNED_URL_TTL_S) -> str:
        if not path.startswith(f"{user.id}/") or path not in self.files:
            raise KeyframeNotFound(path)
        return f"memory://{BUCKET}/{path}?expires_in={expires_in}"


class SupabaseKeyframes:
    def __init__(self, url: str, publishable_key: str, client: httpx.AsyncClient | None = None) -> None:
        self._base = url.rstrip("/") + "/storage/v1"
        self._key = publishable_key
        self._http = client or httpx.AsyncClient(timeout=10.0)

    def _headers(self, user: AuthUser, content_type: str) -> dict[str, str]:
        if not user.token:
            raise KeyframeError("no user token: Supabase storage needs AUTH_MODE=supabase")
        return {"apikey": self._key, "Authorization": f"Bearer {user.token}", "Content-Type": content_type}

    async def upload(self, user, path, jpeg) -> None:
        try:
            r = await self._http.post(
                f"{self._base}/object/{BUCKET}/{path}",
                headers={**self._headers(user, "image/jpeg"), "x-upsert": "true"}, content=jpeg,
            )
        except httpx.HTTPError as e:
            raise KeyframeError(f"upload failed: {e}") from e
        if r.status_code >= 400:
            raise KeyframeError(f"upload -> {r.status_code}: {r.text[:200]}")

    async def signed_url(self, user, path, expires_in=SIGNED_URL_TTL_S) -> str:
        try:
            r = await self._http.post(
                f"{self._base}/object/sign/{BUCKET}/{path}",
                headers=self._headers(user, "application/json"), json={"expiresIn": int(expires_in)},
            )
        except httpx.HTTPError as e:
            raise KeyframeError(f"sign failed: {e}") from e
        if r.status_code in (400, 404):  # Storage answers 400 "Object not found" for missing or hidden files
            raise KeyframeNotFound(path)
        if r.status_code >= 400:
            raise KeyframeError(f"sign -> {r.status_code}: {r.text[:200]}")
        signed = r.json().get("signedURL", "")
        if not signed:
            raise KeyframeError("no signedURL in response")
        return self._base + (signed if signed.startswith("/") else "/" + signed)


_memory = MemoryKeyframes()
_supabase: SupabaseKeyframes | None = None


def get_keyframes() -> KeyframeStore:
    """Same switch as the repo: memory in dev/admin mode, Supabase Storage otherwise."""
    global _supabase
    if settings.auth_mode in ("dev", "admin"):
        return _memory
    if _supabase is None:
        _supabase = SupabaseKeyframes(settings.supabase_url, settings.supabase_publishable_key)
    return _supabase


async def sign_many(store: KeyframeStore, user: AuthUser, paths: list[str]) -> dict[str, str]:
    """Signed URLs for the paths that work; failures are skipped (a missing preview is not an error)."""
    out: dict[str, str] = {}
    for p in dict.fromkeys(x for x in paths if x):
        try:
            out[p] = await store.signed_url(user, p)
        except Exception:
            log.warning("could not sign keyframe %s", p)
    return out
