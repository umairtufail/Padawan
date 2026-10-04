"""Everything around a teach session besides frames: transcript, questions, answers, steps, finish, synthesis."""

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..auth import AuthUser, current_user
from ..config import settings
from ..repo import RepoError, SessionRecord, SessionRepo, SkillRecord, get_repo
from ..schemas import (
    AnswerIn, AnswerOut, FinishOut, QuestionAsked, QuestionOut, SessionSteps, SkillAuthor, StepDraft,
    SynthesizeOut, TeachbackIn, UtterancesIn, UtterancesOut,
)
from ..services import gaps, segmenter, synthesizer
from ..services.keyframes import KeyframeStore, get_keyframes, sign_many

log = logging.getLogger("padawan.capture")
router = APIRouter()

SynthFn = Callable[..., Awaitable[tuple]]


def get_synthesizer() -> SynthFn:
    """Dependency so tests can swap the real model call for a fake."""
    return synthesizer.synthesize


async def _owned_session(repo: SessionRepo, user: AuthUser, session_id: str) -> SessionRecord:
    try:
        rec = await repo.get_session(user, session_id)
    except RepoError:
        log.exception("could not load session")
        raise HTTPException(502, "storage unavailable")
    if rec is None or rec.kind != "teach":  # learn sessions have their own endpoints (/v1/learn)
        raise HTTPException(404, "session not found")
    return rec


def _storage_error() -> HTTPException:
    log.exception("storage failed")
    return HTTPException(502, "storage unavailable")


@router.post("/sessions/{session_id}/utterances", response_model=UtterancesOut)
async def add_utterances(
    session_id: str, body: UtterancesIn, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo)
) -> UtterancesOut:
    await _owned_session(repo, user, session_id)
    # TODO(PII ticket): redact personal data here before storing.
    try:
        ids = await repo.add_utterances(user, session_id, [u.model_dump() for u in body.utterances])
    except RepoError:
        raise _storage_error()
    return UtterancesOut(stored=len(ids), ids=ids)


@router.post("/sessions/{session_id}/questions/{question_id}/asked", response_model=QuestionOut)
async def question_asked(
    session_id: str, question_id: str, body: QuestionAsked,
    user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo),
) -> QuestionOut:
    """Yoda asked this question. `question_id` is the candidate id from the frames response (a UUID).
    Calling it again with the same id updates the row (idempotent)."""
    try:
        uuid.UUID(question_id)
    except ValueError:
        raise HTTPException(422, "question_id must be a UUID (use the candidate id)")
    await _owned_session(repo, user, session_id)
    fields = body.model_dump()
    try:
        await repo.upsert_question(user, session_id, question_id, fields)
    except RepoError:
        raise _storage_error()
    return QuestionOut(id=question_id, **{k: fields[k] for k in ("phase", "type", "text", "anchor_event_id", "asked_at_ms", "why_now")})


@router.post("/sessions/{session_id}/answers", response_model=AnswerOut)
async def log_answer(
    session_id: str, body: AnswerIn, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo)
) -> AnswerOut:
    """Interviewer tool `log_answer`: stores the quote as an expert line and links it to the question."""
    await _owned_session(repo, user, session_id)
    try:
        uid = await repo.save_answer(user, session_id, body.question_id, body.t_ms, body.quote)
    except RepoError:
        raise _storage_error()
    if uid is None:
        raise HTTPException(404, "question not found in this session (record it with .../asked first)")
    return AnswerOut(question_id=body.question_id, utterance_id=uid)


async def _step_models(store: KeyframeStore, user: AuthUser, rows: list[dict]) -> list[StepDraft]:
    """StepDraft models with a fresh signed `keyframe_url` where the step has a keyframe."""
    urls = await sign_many(store, user, [r.get("keyframe_path") for r in rows])
    return [
        StepDraft(**{k: r.get(k) for k in StepDraft.model_fields if r.get(k) is not None},
                  keyframe_url=urls.get(r.get("keyframe_path")))
        for r in rows
    ]


@router.get("/sessions/{session_id}/steps", response_model=SessionSteps)
async def get_steps(
    session_id: str, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo),
    store: KeyframeStore = Depends(get_keyframes),
) -> SessionSteps:
    await _owned_session(repo, user, session_id)
    try:
        rows = await repo.list_steps(user, session_id)
    except RepoError:
        raise _storage_error()
    return SessionSteps(steps=await _step_models(store, user, rows))


async def _load(repo: SessionRepo, user: AuthUser, session_id: str):
    events = await repo.list_events(user, session_id, limit=5000)
    utterances = await repo.list_utterances(user, session_id)
    questions = await repo.list_questions(user, session_id)
    return events, utterances, questions


@router.post("/sessions/{session_id}/finish", response_model=FinishOut)
async def finish_session(
    session_id: str, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo),
    store: KeyframeStore = Depends(get_keyframes),
) -> FinishOut:
    """Stop capture: close the steps, compute the gap list for the debrief, move the session to `debrief`."""
    await _owned_session(repo, user, session_id)
    try:
        events, utterances, questions = await _load(repo, user, session_id)
        steps = segmenter.segment(events, utterances, questions, closed=True)
        if steps:
            await repo.upsert_steps(user, session_id, steps)
        await repo.set_session_state(user, session_id, status="debrief")
    except RepoError:
        raise _storage_error()
    found = gaps.find_gaps(steps, events, utterances, questions, gaps.get_candidates(session_id))
    return FinishOut(session_id=session_id, status="debrief", steps=await _step_models(store, user, steps), gaps=found)


@router.post("/sessions/{session_id}/teachback", response_model=SynthesizeOut)
async def teachback(
    session_id: str, body: TeachbackIn,
    user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo),
    synth: SynthFn = Depends(get_synthesizer),
) -> SynthesizeOut:
    """The expert confirmed the read-back (with optional corrections): synthesize the skill as a draft.

    Runs synchronously (one model call, a second one only if the quote check fails): expect several seconds.
    """
    if not body.confirmed:
        raise HTTPException(400, "teach-back not confirmed")
    session = await _owned_session(repo, user, session_id)
    try:
        events, utterances, questions = await _load(repo, user, session_id)
        if not events:
            raise HTTPException(409, "nothing was captured in this session")
        steps = await repo.list_steps(user, session_id)
        if not steps:
            steps = segmenter.segment(events, utterances, questions, closed=True)
            await repo.upsert_steps(user, session_id, steps)
        existing = await repo.get_skill(user, session.skill_id) if session.skill_id else None
        name = await repo.author_name(user)
        await repo.set_session_state(user, session_id, status="processing")
    except RepoError:
        raise _storage_error()

    skill_id = existing.id if existing else str(uuid.uuid4())
    try:
        skill, domain, attempts, _ = await synth(
            skill_id=skill_id, author=SkillAuthor(id=user.id, name=name), session_title=session.title,
            language=session.language, steps=steps, events=events, utterances=utterances, questions=questions,
            corrections=body.corrections, timeout_s=settings.synthesis_timeout_s,
        )
    except synthesizer.SynthesisError as e:
        log.warning("synthesis rejected: %s", e)
        await _try_status(repo, user, session_id, "failed")
        raise HTTPException(502, {"error": "synthesis_failed", "problems": e.problems[:10]})
    except Exception:
        log.exception("synthesis crashed")
        await _try_status(repo, user, session_id, "failed")
        raise HTTPException(502, {"error": "synthesis_failed", "problems": ["unexpected error"]})

    rec = SkillRecord(
        id=skill_id, author_id=user.id, author_name=name, title=skill.title, description=skill.description,
        domain=domain or (existing.domain if existing else None), language=skill.language,
        status=existing.status if existing else "draft", skill_json=skill.model_dump(mode="json"),
        skill_md=synthesizer.render_skill_md(skill), steps_count=len(skill.steps),
        guardrails_count=synthesizer.count_guardrails(skill),
        created_at=existing.created_at if existing else datetime.now(timezone.utc),
        published_at=existing.published_at if existing else None,
    )
    try:
        await repo.save_skill(user, rec)
        await repo.set_session_state(user, session_id, status="done", skill_id=skill_id)
    except RepoError:
        raise _storage_error()
    return SynthesizeOut(skill_id=skill_id, steps_count=rec.steps_count, guardrails_count=rec.guardrails_count, attempts=attempts)


async def _try_status(repo, user, session_id, status) -> None:
    try:
        await repo.set_session_state(user, session_id, status=status)
    except Exception:
        log.exception("could not set session status")
