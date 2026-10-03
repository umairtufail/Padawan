import asyncio
import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..auth import AuthUser, current_user
from ..config import settings
from ..repo import RepoError, SessionRepo, get_repo
from ..schemas import Event, FrameResponse, SessionCreate, SessionOut
from ..services import vision

log = logging.getLogger("padawan.sessions")
router = APIRouter()

MAX_FRAME_BYTES = 4 * 1024 * 1024

VisionFn = Callable[..., Awaitable[vision.VisionResult]]

# One vision call in flight per session, and the latest summary, kept in this process.
# (With several instances the summary falls back to the database copy, the lock is per instance.)
_locks: dict[str, asyncio.Lock] = {}
_summaries: dict[str, str] = {}


def get_vision() -> VisionFn:
    """Dependency so tests can swap the real model call for a fake."""
    return vision.extract_events


@router.post("/teach/sessions", response_model=SessionOut, status_code=201)
async def create_teach_session(
    body: SessionCreate, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo)
) -> SessionOut:
    try:
        s = await repo.create_session(user, body.title, body.description, body.language)
    except RepoError:
        log.exception("could not create session")
        raise HTTPException(502, "storage unavailable")
    return SessionOut(
        session_id=s.id, title=s.title, description=s.description, language=s.language, created_at=s.created_at
    )


@router.post("/sessions/{session_id}/frames", response_model=FrameResponse)
async def post_frame(
    session_id: str,
    t_ms: int = Form(...),
    frame: UploadFile = File(...),
    user: AuthUser = Depends(current_user),
    repo: SessionRepo = Depends(get_repo),
    extract: VisionFn = Depends(get_vision),
) -> FrameResponse:
    data = await frame.read()
    if not data:
        raise HTTPException(400, "empty frame")
    if len(data) > MAX_FRAME_BYTES:
        raise HTTPException(413, "frame too large")

    # Skip a frame that arrives while one is still being analysed. Never queue.
    busy = _locks.get(session_id)
    if busy is not None and busy.locked():
        return FrameResponse(t_ms=t_ms, skipped="busy")

    try:
        session = await repo.get_session(user, session_id)
    except RepoError:
        log.exception("could not load session")
        raise HTTPException(502, "storage unavailable")
    if session is None:
        raise HTTPException(404, "session not found")

    lock = _locks.setdefault(session_id, asyncio.Lock())
    if lock.locked():
        return FrameResponse(t_ms=t_ms, skipped="busy")

    async with lock:
        prev = _summaries.get(session_id, session.last_summary)
        try:
            result = await asyncio.wait_for(
                extract(data, prev, mime=frame.content_type or "image/jpeg"),
                timeout=settings.vision_timeout_s,
            )
        except asyncio.TimeoutError:
            return FrameResponse(t_ms=t_ms, skipped="timeout")
        except Exception:
            log.exception("vision call failed")
            return FrameResponse(t_ms=t_ms, skipped="vision_error")

        if not result.parse_ok or not result.screen_summary:
            # Keep the previous summary so the next frame still has a state to compare against.
            return FrameResponse(t_ms=t_ms, skipped="parse_error", latency_ms=result.latency_ms)

        events: list[Event] = []
        for raw in result.events:
            try:
                events.append(Event(id=0, **{k: v for k, v in raw.items() if k != "id"}))
            except Exception:
                continue  # ignore a malformed event, keep the rest

        try:
            ids = await repo.save_frame_result(
                user, session_id, t_ms, result.screen_summary, [e.model_dump(exclude={"id"}) for e in events]
            )
        except RepoError:
            # Not stored, so the saved summary stays as it was and the next frame compares against that.
            log.exception("could not store the frame result")
            return FrameResponse(t_ms=t_ms, skipped="storage_error", latency_ms=result.latency_ms)

        _summaries[session_id] = result.screen_summary
        for e, event_id in zip(events, ids):
            e.id = event_id

        return FrameResponse(
            t_ms=t_ms, screen_summary=result.screen_summary, events=events, latency_ms=result.latency_ms
        )
