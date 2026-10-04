import logging
from collections.abc import Awaitable, Callable
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import AuthUser, current_user
from ..config import settings
from ..repo import RepoError, SessionRepo, get_repo
from ..schemas import SkillJson
from ..services import elevenlabs, learn
from .capture import session_gaps
from .sessions import _summaries

log = logging.getLogger("padawan.voice")
router = APIRouter()

SignedUrlFn = Callable[[str], Awaitable[str]]


def get_signed_url_fn() -> SignedUrlFn:
    """Dependency so tests can swap the real ElevenLabs call for a fake."""
    return elevenlabs.get_signed_url


class VoiceSessionRequest(BaseModel):
    session_id: str
    mode: Literal["capture", "debrief", "tutor"]
    # The question the app is about to ask (optional context for the agent, not spoken by itself).
    pending_question: str = Field(default="", max_length=500)


class VoiceSessionResponse(BaseModel):
    signed_url: str
    agent_id: str
    dynamic_variables: dict[str, str]


@router.post("/voice/readiness", response_model=VoiceSessionResponse)
async def voice_readiness(
    _user: AuthUser = Depends(current_user),
    signed_url: SignedUrlFn = Depends(get_signed_url_fn),
) -> VoiceSessionResponse:
    """Signed URL for a short, non-persistent browser microphone and Yoda preflight."""
    agent_id = settings.elevenlabs_interviewer_agent_id
    variables = {
        "mode": "live",
        "task_title": "voice readiness check",
        "gaps": "",
        "last_screen_summary": "",
        "pending_question": "",
    }
    try:
        url = await signed_url(agent_id)
    except elevenlabs.ElevenLabsError as e:
        log.error("voice readiness failed: %s", e)
        raise HTTPException(502, "voice service unavailable")
    return VoiceSessionResponse(signed_url=url, agent_id=agent_id, dynamic_variables=variables)


@router.post("/voice/sessions", response_model=VoiceSessionResponse)
async def start_voice_session(
    body: VoiceSessionRequest,
    user: AuthUser = Depends(current_user),
    repo: SessionRepo = Depends(get_repo),
    signed_url: SignedUrlFn = Depends(get_signed_url_fn),
) -> VoiceSessionResponse:
    """Signed URL for a Yoda conversation. The user comes from the token, the session must be theirs."""
    try:
        session = await repo.get_session(user, body.session_id)
    except RepoError:
        log.exception("could not load session")
        raise HTTPException(502, "storage unavailable")
    if session is None:
        raise HTTPException(404, "session not found")

    summary = _summaries.get(session.id, session.last_summary)
    if body.mode == "tutor":
        agent_id = settings.elevenlabs_tutor_agent_id
        variables = {
            "task_title": session.title, "skill_md": "(no skill loaded)", "expert": "the Master",
            "skill_steps": "(none)", "skill_guardrails": "(none)", "current_step": "(none)", "current_step_idx": "0",
        }
        if session.kind == "learn":
            variables.update(await _tutor_variables(repo, user, session))
    else:
        agent_id = settings.elevenlabs_interviewer_agent_id
        variables = {
            "mode": "debrief" if body.mode == "debrief" else "live",
            "task_title": session.title,
            "gaps": "",
            "last_screen_summary": summary,
            "pending_question": body.pending_question,
        }
        if body.mode == "debrief":
            variables.update(await _debrief_variables(repo, user, session.id))

    try:
        url = await signed_url(agent_id)
    except elevenlabs.ElevenLabsError as e:
        log.error("voice session failed: %s", e)
        raise HTTPException(502, "voice service unavailable")
    return VoiceSessionResponse(signed_url=url, agent_id=agent_id, dynamic_variables=variables)


MAX_GAPS = 8
MAX_GAP_CHARS = 200
MAX_STEPS = 15


def format_gaps(gaps: list) -> str:
    """Open gap questions as a compact numbered list: '1. [gap-2] Why this: ...?'. Empty when there are none."""
    return "\n".join(f"{i}. [{g.id}] {g.text[:MAX_GAP_CHARS]}" for i, g in enumerate(gaps[:MAX_GAPS], 1))


def format_steps(steps: list[dict]) -> str:
    return "; ".join(f"{i}. {str(s.get('title', '')).strip()[:80]}" for i, s in enumerate(steps[:MAX_STEPS], 1))


async def _debrief_variables(repo: SessionRepo, user: AuthUser, session_id: str) -> dict[str, str]:
    """The debrief questions: the gap finder's open gaps (best first) and the ordered step titles."""
    try:
        steps, found = await session_gaps(repo, user, session_id)
    except RepoError:
        log.exception("could not load debrief data")
        raise HTTPException(502, "storage unavailable")
    return {"gaps": format_gaps(found), "steps_summary": format_steps(steps)}


async def _tutor_variables(repo: SessionRepo, user: AuthUser, session) -> dict[str, str]:
    """The Holocron for a learn session: skill_md, the expert's name, steps, guardrails and the current step."""
    try:
        rec = await repo.get_skill(user, session.skill_id) if session.skill_id else None
    except RepoError:
        log.exception("could not load skill")
        raise HTTPException(502, "storage unavailable")
    if rec is None or not rec.skill_json:
        return {}
    try:
        skill = SkillJson(**rec.skill_json)
    except Exception:
        return {}
    st = learn._states.get(session.id)
    out = learn.tutor_context(skill, st.current_idx if st else (skill.steps[0].idx if skill.steps else 0))
    out["skill_md"] = rec.skill_md or "(no skill loaded)"
    out["expert"] = rec.author_name or "the Master"
    return out
