import asyncio
import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile

from ..auth import AuthUser, current_user
from ..config import settings
from ..repo import RepoError, SessionRepo, get_repo
from ..schemas import (
    Event, FrameResponse, OffTheRecord, QuestionCandidate, SessionCreate, SessionDetail, SessionOut, SessionSummary,
    StepUpdate, StoredEvent,
)
from ..services import gaps, question_planner, segmenter, vision
from ..services.pii import redact_frame_result

log = logging.getLogger("padawan.sessions")
router = APIRouter()

MAX_FRAME_BYTES = 4 * 1024 * 1024

VisionFn = Callable[..., Awaitable[vision.VisionResult]]

# One vision call in flight per session, and the latest summary, kept in this process.
# (With several instances the summary falls back to the database copy, the lock is per instance.)
_locks: dict[str, asyncio.Lock] = {}
_summaries: dict[str, str] = {}
# Sessions the expert took off the record. In-process like the lock (lost on restart, per instance).
_off_record: set[str] = set()


def get_vision() -> VisionFn:
    """Dependency so tests can swap the real model call for a fake."""
    return vision.extract_events


PlannerFn = Callable[..., Awaitable[list[QuestionCandidate]]]


def get_planner() -> PlannerFn:
    """Dependency so tests can swap the real question planner for a fake."""
    return question_planner.plan_questions


async def _candidates_for(user: AuthUser, repo: SessionRepo, session_id: str, plan: PlannerFn) -> list[QuestionCandidate]:
    """Question candidates after a salient frame. Any failure means no candidates, never an error."""
    try:
        events = await repo.list_recent_events(user, session_id, 12)
        transcript = await repo.list_utterances(user, session_id, limit=10, recent=True)
        asked = await repo.list_questions(user, session_id)
        found = await plan(events, transcript, asked)
    except Exception:
        log.exception("question planning failed")
        return []
    gaps.record_candidates(session_id, [c.model_dump() for c in found])
    return found


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


@router.get("/sessions", response_model=list[SessionSummary])
async def list_sessions(user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo)) -> list[SessionSummary]:
    try:
        rows = await repo.list_sessions(user)
    except RepoError:
        log.exception("could not list sessions")
        raise HTTPException(502, "storage unavailable")
    return [
        SessionSummary(
            session_id=r.id, title=r.title, created_at=r.created_at,
            last_screen_summary=_summaries.get(r.id, r.last_summary), events_count=r.events_count,
        )
        for r in rows
    ]


@router.get("/sessions/{session_id}", response_model=SessionDetail)
async def get_session(
    session_id: str, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo)
) -> SessionDetail:
    try:
        rec = await repo.get_session(user, session_id)
        if rec is None:
            raise HTTPException(404, "session not found")
        raw_events = await repo.list_events(user, session_id)
    except RepoError:
        log.exception("could not load session")
        raise HTTPException(502, "storage unavailable")
    events: list[StoredEvent] = []
    for raw in raw_events:
        try:
            events.append(StoredEvent(**raw))
        except Exception:
            continue
    return SessionDetail(
        session_id=rec.id, title=rec.title, created_at=rec.created_at,
        last_screen_summary=_summaries.get(rec.id, rec.last_summary), events_count=len(events), events=events,
    )


@router.post("/sessions/{session_id}/off-the-record", response_model=OffTheRecord)
async def set_off_the_record(
    session_id: str, body: OffTheRecord, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo)
) -> OffTheRecord:
    try:
        session = await repo.get_session(user, session_id)
    except RepoError:
        log.exception("could not load session")
        raise HTTPException(502, "storage unavailable")
    if session is None:
        raise HTTPException(404, "session not found")
    (_off_record.add if body.on else _off_record.discard)(session_id)
    return body


@router.post("/sessions/{session_id}/frames", response_model=FrameResponse)
async def post_frame(
    session_id: str,
    background: BackgroundTasks,
    t_ms: int = Form(...),
    frame: UploadFile = File(...),
    user: AuthUser = Depends(current_user),
    repo: SessionRepo = Depends(get_repo),
    extract: VisionFn = Depends(get_vision),
    plan: PlannerFn = Depends(get_planner),
) -> FrameResponse:
    if session_id in _off_record:
        # Checked first: the frame is not read, analysed or stored, and goes nowhere.
        return FrameResponse(t_ms=t_ms, skipped="off_the_record")
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

        # Redact personal data before anything is stored, returned or fed back as the next PREVIOUS_SCREEN.
        summary, clean_events, _ = redact_frame_result(
            result.screen_summary, [r for r in result.events if isinstance(r, dict)]
        )
        events: list[Event] = []
        for raw in clean_events:
            try:
                events.append(Event(id=0, **{k: v for k, v in raw.items() if k != "id"}))
            except Exception:
                continue  # ignore a malformed event, keep the rest

        try:
            ids = await repo.save_frame_result(
                user, session_id, t_ms, summary, [e.model_dump(exclude={"id"}) for e in events]
            )
        except RepoError:
            # Not stored, so the saved summary stays as it was and the next frame compares against that.
            log.exception("could not store the frame result")
            return FrameResponse(t_ms=t_ms, skipped="storage_error", latency_ms=result.latency_ms)

        _summaries[session_id] = summary
        for e, event_id in zip(events, ids):
            e.id = event_id

        # The model is only asked for questions when something salient happened on this frame.
        candidates = await _candidates_for(user, repo, session_id, plan) if any(e.salient for e in events) else []

        # Steps are grouped in the background every few events (single flight per session).
        segmenter.note_events(session_id, len(events))
        if segmenter.due(session_id):
            background.add_task(segmenter.run_segmenter, user, repo, session_id)
        cur = segmenter.current_step(session_id)

        return FrameResponse(
            t_ms=t_ms, screen_summary=summary, events=events, latency_ms=result.latency_ms,
            question_candidates=candidates,
            step_update=StepUpdate(idx=cur["idx"], title=cur["title"], status=cur["status"]) if cur else None,
        )
