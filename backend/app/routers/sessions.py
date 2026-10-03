import asyncio
import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..auth import current_user
from ..config import settings
from ..schemas import Event, FrameResponse, SessionCreate, SessionOut
from ..services import vision
from ..state import store

log = logging.getLogger("padawan.sessions")
router = APIRouter()

MAX_FRAME_BYTES = 4 * 1024 * 1024

VisionFn = Callable[..., Awaitable[vision.VisionResult]]


def get_vision() -> VisionFn:
    """Dependency so tests can swap the real model call for a fake."""
    return vision.extract_events


@router.post("/teach/sessions", response_model=SessionOut, status_code=201)
async def create_teach_session(body: SessionCreate, user: str = Depends(current_user)) -> SessionOut:
    s = store.create(user, body.title, body.description, body.language)
    return SessionOut(
        session_id=s.id, title=s.title, description=s.description, language=s.language, created_at=s.created_at
    )


@router.post("/sessions/{session_id}/frames", response_model=FrameResponse)
async def post_frame(
    session_id: str,
    t_ms: int = Form(...),
    frame: UploadFile = File(...),
    user: str = Depends(current_user),
    extract: VisionFn = Depends(get_vision),
) -> FrameResponse:
    s = store.get(session_id)
    if s is None or s.user_id != user:
        raise HTTPException(404, "session not found")

    data = await frame.read()
    if not data:
        raise HTTPException(400, "empty frame")
    if len(data) > MAX_FRAME_BYTES:
        raise HTTPException(413, "frame too large")

    # One call in flight per session: a frame that arrives meanwhile is skipped, never queued.
    if s.lock.locked():
        return FrameResponse(t_ms=t_ms, skipped="busy")

    async with s.lock:
        try:
            result = await asyncio.wait_for(
                extract(data, s.last_summary, mime=frame.content_type or "image/jpeg"),
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

        s.last_summary = result.screen_summary
        events: list[Event] = []
        for raw in result.events:
            try:
                ev = Event(id=s.next_event_id, **raw)
            except Exception:
                continue  # ignore a malformed event, keep the rest
            s.next_event_id += 1
            events.append(ev)
            s.events.append({"t_ms": t_ms, **ev.model_dump()})

        return FrameResponse(
            t_ms=t_ms,
            screen_summary=result.screen_summary,
            events=events,
            latency_ms=result.latency_ms,
        )
