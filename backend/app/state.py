"""In-memory session store for the first version.

TODO: move to Supabase (sessions.last_screen_summary + events table) so the backend stays stateless
on FastAPI Cloud. The router only uses this module through `store`, so the swap is local.
"""

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class SessionState:
    id: str
    user_id: str
    title: str
    description: str
    language: str
    created_at: datetime
    last_summary: str = ""
    events: list[dict] = field(default_factory=list)
    next_event_id: int = 1
    # Only one vision call may be in flight per session.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}

    def create(self, user_id: str, title: str, description: str, language: str) -> SessionState:
        s = SessionState(
            id=str(uuid.uuid4()),
            user_id=user_id,
            title=title,
            description=description,
            language=language,
            created_at=datetime.now(timezone.utc),
        )
        self._sessions[s.id] = s
        return s

    def get(self, session_id: str) -> SessionState | None:
        return self._sessions.get(session_id)

    def clear(self) -> None:
        self._sessions.clear()


store = SessionStore()
