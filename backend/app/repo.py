"""Where sessions, events and the running screen summary live.

- MemoryRepo: in-process, for `dev` mode and tests.
- SupabaseRepo: Postgres through Supabase's REST API, called AS THE USER (their access token), so the
  database row-level security enforces ownership. No service-role key is needed or used.
"""

import asyncio
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

import httpx

from .auth import AuthUser
from .config import settings


class RepoError(Exception):
    """Storage failed (network, permissions, bad response)."""


@dataclass
class SessionRecord:
    id: str
    user_id: str
    title: str
    created_at: datetime
    last_summary: str = ""
    description: str = ""
    language: str = "en"


class SessionRepo(Protocol):
    async def create_session(self, user: AuthUser, title: str, description: str, language: str) -> SessionRecord: ...

    async def get_session(self, user: AuthUser, session_id: str) -> SessionRecord | None: ...

    async def save_frame_result(
        self, user: AuthUser, session_id: str, t_ms: int, summary: str, events: list[dict]
    ) -> list[int]:
        """Store the new screen summary and the events. Returns one id per event, in order."""
        ...


# ---------------------------------------------------------------- memory


class MemoryRepo:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionRecord] = {}
        self._events: list[dict] = []
        self._next_event_id = 1

    def clear(self) -> None:
        self._sessions.clear()
        self._events.clear()
        self._next_event_id = 1

    async def create_session(self, user, title, description, language) -> SessionRecord:
        rec = SessionRecord(
            id=str(uuid.uuid4()), user_id=user.id, title=title, description=description,
            language=language, created_at=datetime.now(timezone.utc),
        )
        self._sessions[rec.id] = rec
        return rec

    async def get_session(self, user, session_id) -> SessionRecord | None:
        rec = self._sessions.get(session_id)
        return rec if rec and rec.user_id == user.id else None

    async def save_frame_result(self, user, session_id, t_ms, summary, events) -> list[int]:
        rec = self._sessions[session_id]
        rec.last_summary = summary
        ids = []
        for ev in events:
            ids.append(self._next_event_id)
            self._events.append({"id": self._next_event_id, "session_id": session_id, "t_ms": t_ms, **ev})
            self._next_event_id += 1
        return ids


# ---------------------------------------------------------------- supabase


class SupabaseRepo:
    def __init__(self, url: str, publishable_key: str, client: httpx.AsyncClient | None = None) -> None:
        self._base = url.rstrip("/") + "/rest/v1"
        self._key = publishable_key
        self._http = client or httpx.AsyncClient(timeout=10.0)

    def _headers(self, user: AuthUser, *, returning: bool = False) -> dict[str, str]:
        if not user.token:
            raise RepoError("no user token: Supabase storage needs AUTH_MODE=supabase")
        h = {"apikey": self._key, "Authorization": f"Bearer {user.token}", "Content-Type": "application/json"}
        if returning:
            h["Prefer"] = "return=representation"
        return h

    async def _send(self, method: str, path: str, user: AuthUser, *, returning=False, **kw) -> list[dict]:
        try:
            r = await self._http.request(method, self._base + path, headers=self._headers(user, returning=returning), **kw)
        except httpx.HTTPError as e:
            raise RepoError(f"supabase request failed: {e}") from e
        if r.status_code >= 400:
            raise RepoError(f"supabase {method} {path} -> {r.status_code}: {r.text[:200]}")
        return r.json() if returning and r.content else []

    async def create_session(self, user, title, description, language) -> SessionRecord:
        rows = await self._send(
            "POST", "/sessions?select=id,user_id,title,started_at", user, returning=True,
            json={"user_id": user.id, "kind": "teach", "title": title},
        )
        if not rows:
            raise RepoError("session was not created")
        r = rows[0]
        return SessionRecord(
            id=r["id"], user_id=r["user_id"], title=r["title"] or title,
            created_at=datetime.fromisoformat(r["started_at"]), description=description, language=language,
        )

    async def get_session(self, user, session_id) -> SessionRecord | None:
        try:
            uuid.UUID(session_id)
        except ValueError:
            return None
        rows = await self._send(
            "GET", f"/sessions?id=eq.{session_id}&select=id,user_id,title,last_screen_summary,started_at&limit=1",
            user, returning=True,
        )
        if not rows:  # not found, or row-level security hides it because it is not the user's
            return None
        r = rows[0]
        return SessionRecord(
            id=r["id"], user_id=r["user_id"], title=r["title"] or "",
            created_at=datetime.fromisoformat(r["started_at"]), last_summary=r["last_screen_summary"] or "",
        )

    async def save_frame_result(self, user, session_id, t_ms, summary, events) -> list[int]:
        async def insert_events() -> list[int]:
            if not events:
                return []
            body = [
                {
                    "session_id": session_id, "t_ms": t_ms, "kind": e["kind"], "summary": e["summary"],
                    "payload": {k: e[k] for k in ("entities", "visible_text", "salient", "confidence") if k in e},
                }
                for e in events
            ]
            rows = await self._send("POST", "/events?select=id", user, returning=True, json=body)
            return [int(r["id"]) for r in rows]

        async def update_summary() -> None:
            await self._send("PATCH", f"/sessions?id=eq.{session_id}", user, json={"last_screen_summary": summary})

        ids, _ = await asyncio.gather(insert_events(), update_summary())
        return ids


# ---------------------------------------------------------------- selection

_memory = MemoryRepo()
_supabase: SupabaseRepo | None = None


def get_repo() -> SessionRepo:
    """Dev mode keeps everything in memory. Supabase mode stores it in Postgres."""
    global _supabase
    if settings.auth_mode == "dev":
        return _memory
    if _supabase is None:
        _supabase = SupabaseRepo(settings.supabase_url, settings.supabase_publishable_key)
    return _supabase
