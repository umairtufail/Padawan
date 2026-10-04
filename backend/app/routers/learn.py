"""Learn mode: a Padawan works through a Holocron while Yoda tutors and a guardrail checker watches the screen."""

import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile

from ..auth import AuthUser, current_user
from ..repo import RepoError, SessionRecord, SessionRepo, get_repo
from ..schemas import FrameResponse, SkillJson
from ..schemas_learn import (
    GuardrailVerdict, LearnFrameResponse, LearnSessionCreate, LearnSessionOut, MasteryReport, PredictionIn,
    PredictionOut, PredictionResult,
)
from ..services import guardrail_checker, learn
from ..services.learn import LearnState
from .sessions import VisionFn, analyse_frame, get_vision

log = logging.getLogger("padawan.learn")
router = APIRouter()

CheckFn = Callable[..., Awaitable[guardrail_checker.CheckResult]]
JudgeFn = Callable[..., Awaitable[tuple[bool, str]]]
SummaryFn = Callable[..., Awaitable[None]]


def get_checker() -> CheckFn:
    """Dependency so tests can swap the real guardrail checker for a fake."""
    return guardrail_checker.check_move


def get_judge() -> JudgeFn:
    return learn.judge_prediction


def get_summarizer() -> SummaryFn:
    return learn.add_summary


async def _no_candidates(*a, **k):
    return []


def _storage_error() -> HTTPException:
    log.exception("storage failed")
    return HTTPException(502, "storage unavailable")


async def load_learn_session(repo: SessionRepo, user: AuthUser, session_id: str) -> tuple[SessionRecord, SkillJson]:
    """The caller's learn session and its skill. 404 for anything else (also a teach session)."""
    try:
        rec = await repo.get_session(user, session_id)
        if rec is None or rec.kind != "learn" or not rec.skill_id:
            raise HTTPException(404, "learn session not found")
        skill_rec = await repo.get_skill(user, rec.skill_id)
    except RepoError:
        raise _storage_error()
    if skill_rec is None or not skill_rec.skill_json:
        raise HTTPException(409, "the skill of this session is no longer available")
    try:
        skill = SkillJson(**skill_rec.skill_json)
    except Exception:
        raise HTTPException(409, "the skill of this session is not a valid Holocron")
    if not skill.steps:
        raise HTTPException(409, "the skill has no steps")
    return rec, skill


async def get_state(repo: SessionRepo, user: AuthUser, rec: SessionRecord, skill: SkillJson) -> LearnState:
    st = learn._states.get(rec.id)
    if st is not None:
        return st
    st = LearnState(skill_id=rec.skill_id or "", current_idx=skill.steps[0].idx)
    try:
        rows = await repo.list_attempts(user, rec.id)
    except RepoError:
        log.exception("could not load learn progress")
        rows = []
    for r in rows:
        st.attempts[int(r["step_idx"])] = dict(r)
    started = [r for r in rows if r.get("started_ms") is not None]
    if started:  # after a restart: the step entered last
        st.current_idx = int(max(started, key=lambda r: r["started_ms"])["step_idx"])
    learn._states[rec.id] = st
    return st


async def _save(repo: SessionRepo, user: AuthUser, rec: SessionRecord, st: LearnState, idx: int, **fields) -> None:
    """Write-through of one step's progress. A storage failure is logged, never raised into the stream."""
    row = st.attempts.setdefault(idx, {"step_idx": idx})
    row.update(fields)
    try:
        await repo.upsert_attempt(user, rec.id, st.skill_id, idx, fields)
    except RepoError:
        log.exception("could not store learn progress")


@router.post("/learn/sessions", response_model=LearnSessionOut, status_code=201)
async def create_learn_session(
    body: LearnSessionCreate, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo)
) -> LearnSessionOut:
    """Start learning a published skill (or one of your own drafts). The Holocron comes back as the tutor context."""
    try:
        skill_rec = await repo.get_skill(user, body.skill_id)
    except RepoError:
        raise _storage_error()
    if skill_rec is None:
        raise HTTPException(404, "skill not found")
    if not skill_rec.skill_json:
        raise HTTPException(409, "this skill has no steps yet")
    try:
        skill = SkillJson(**skill_rec.skill_json)
    except Exception:
        raise HTTPException(409, "this skill is not a valid Holocron")
    if not skill.steps:
        raise HTTPException(409, "this skill has no steps yet")
    try:
        rec = await repo.create_session(user, skill_rec.title, "", skill_rec.language, kind="learn", skill_id=skill_rec.id)
    except RepoError:
        raise _storage_error()
    return LearnSessionOut(
        session_id=rec.id, skill_id=skill_rec.id, title=skill_rec.title, created_at=rec.created_at,
        current_step_idx=skill.steps[0].idx, skill=skill,
    )


def _verdict(res: guardrail_checker.CheckResult, skill: SkillJson, **extra) -> GuardrailVerdict:
    step = learn.get_step(skill, res.step_idx) if res.step_idx is not None else None
    g = guardrail_checker.guardrail_index(skill).get(res.guardrail_id or "")
    return GuardrailVerdict(
        verdict=res.verdict, step_idx=res.step_idx, step_title=step.title if step else "",
        guardrail_id=res.guardrail_id, rule=g[0].rule if g else "", expert_quote=g[0].quote if g else "",
        reason=res.reason, confidence=res.confidence, committed=res.committed, degraded=res.degraded,
        replay=learn.replay_for(step) if step and res.verdict != "ok" else None, **extra,
    )


@router.post("/learn/sessions/{session_id}/frames", response_model=LearnFrameResponse)
async def post_learn_frame(
    session_id: str,
    background: BackgroundTasks,
    t_ms: int = Form(...),
    frame: UploadFile = File(...),
    user: AuthUser = Depends(current_user),
    repo: SessionRepo = Depends(get_repo),
    extract: VisionFn = Depends(get_vision),
    check: CheckFn = Depends(get_checker),
) -> LearnFrameResponse:
    """Same as the teach frames endpoint (vision, redaction, events) plus a `verdict` from the guardrail checker."""
    rec, skill = await load_learn_session(repo, user, session_id)
    base: FrameResponse = await analyse_frame(
        session_id, background, t_ms, frame, user, repo, extract, _no_candidates, capture=False
    )
    out = LearnFrameResponse(**base.model_dump())
    if base.skipped:
        return out

    st = await get_state(repo, user, rec, skill)
    st.last_t_ms = max(st.last_t_ms, t_ms)
    if st.seg_start_ms is None:
        st.seg_start_ms = t_ms
        if st.attempts.get(st.current_idx, {}).get("started_ms") is None:
            await _save(repo, user, rec, st, st.current_idx, started_ms=t_ms)
    if not base.events:
        out.verdict = GuardrailVerdict(checked=False, step_idx=st.current_idx)
        return out

    try:
        recent = await repo.list_recent_events(user, session_id, 8)
    except RepoError:
        log.exception("could not load recent events")
        recent = [e.model_dump() for e in base.events]
    res = await check(skill, st.current_idx, base.screen_summary, recent)
    verdict = _verdict(res, skill)

    # Follow the learner to the step the checker saw them on.
    if res.step_idx is not None and res.step_idx != st.current_idx:
        spent = max(0, t_ms - st.seg_start_ms) if st.seg_start_ms is not None else 0
        old = st.attempts.get(st.current_idx, {})
        await _save(repo, user, rec, st, st.current_idx, duration_ms=(old.get("duration_ms") or 0) + spent)
        st.current_idx, st.seg_start_ms = res.step_idx, t_ms
        if st.attempts.get(res.step_idx, {}).get("started_ms") is None:
            await _save(repo, user, rec, st, res.step_idx, started_ms=t_ms)

    if res.verdict == "ok":
        st.last_key = None
    else:
        key = (res.verdict, res.step_idx, res.guardrail_id)
        verdict.repeated = key == st.last_key and t_ms - st.last_fire_ms < learn.REPEAT_WINDOW_MS
        if not verdict.repeated:
            st.last_key, st.last_fire_ms = key, t_ms
            row = st.attempts.get(res.step_idx, {})
            if res.verdict == "stop":
                await _save(repo, user, rec, st, res.step_idx, interventions=(row.get("interventions") or 0) + 1,
                            intervened=True, guardrail_id=res.guardrail_id)
            else:
                await _save(repo, user, rec, st, res.step_idx, warnings=(row.get("warnings") or 0) + 1,
                            guardrail_id=res.guardrail_id or row.get("guardrail_id"))
    out.verdict = verdict
    return out


async def _result(skill: SkillJson, step_idx: int, predicted: str, judge: JudgeFn) -> PredictionResult:
    step = learn.get_step(skill, step_idx)
    assert step is not None
    correct, by = await judge(step, predicted)
    return PredictionResult(
        step_idx=step_idx, predicted=predicted, correct=correct, judged_by=by,  # type: ignore[arg-type]
        expected=step.decision.summary or step.title, reason=step.reason.text if step.reason else None,
        reason_quote=step.reason.quote if step.reason else None, replay=learn.replay_for(step),
    )


@router.post("/learn/sessions/{session_id}/predictions", response_model=PredictionOut)
async def record_prediction(
    session_id: str, body: PredictionIn,
    user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo), judge: JudgeFn = Depends(get_judge),
) -> PredictionOut:
    """The learner's prediction for a step, recorded BEFORE the step (tutor tool `record_prediction`).
    With `resolve: true` it is also compared right away. Predicting again replaces the earlier prediction."""
    rec, skill = await load_learn_session(repo, user, session_id)
    if learn.get_step(skill, body.step_idx) is None:
        raise HTTPException(422, "unknown step_idx for this skill")
    st = await get_state(repo, user, rec, skill)
    await _save(repo, user, rec, st, body.step_idx, predicted=body.predicted, correct=None, actual=None)
    if not body.resolve:
        return PredictionOut(step_idx=body.step_idx, predicted=body.predicted, resolved=False)
    result = await _result(skill, body.step_idx, body.predicted, judge)
    await _save(repo, user, rec, st, body.step_idx, correct=result.correct, actual=result.expected)
    return PredictionOut(step_idx=body.step_idx, predicted=body.predicted, resolved=True, result=result)


@router.post("/learn/sessions/{session_id}/predictions/{step_idx}/resolve", response_model=PredictionResult)
async def resolve_prediction(
    session_id: str, step_idx: int,
    user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo), judge: JudgeFn = Depends(get_judge),
) -> PredictionResult:
    """Compare the recorded prediction with the Master's decision (call it after the learner did the step)."""
    rec, skill = await load_learn_session(repo, user, session_id)
    if learn.get_step(skill, step_idx) is None:
        raise HTTPException(422, "unknown step_idx for this skill")
    st = await get_state(repo, user, rec, skill)
    predicted = st.attempts.get(step_idx, {}).get("predicted")
    if not predicted:
        raise HTTPException(409, "no prediction was recorded for this step")
    result = await _result(skill, step_idx, predicted, judge)
    await _save(repo, user, rec, st, step_idx, correct=result.correct, actual=result.expected)
    return result


async def _report(
    rec: SessionRecord, skill: SkillJson, user: AuthUser, repo: SessionRepo, summarize: SummaryFn, with_summary: bool
) -> MasteryReport:
    st = await get_state(repo, user, rec, skill)
    open_seg = None
    if st.seg_start_ms is not None:
        open_seg = (st.current_idx, st.last_t_ms - st.seg_start_ms)
    report = learn.build_report(rec.id, rec.skill_id or "", skill, list(st.attempts.values()), open_segment=open_seg)
    if with_summary:
        await summarize(report, skill)
    return report


@router.get("/learn/sessions/{session_id}/report", response_model=MasteryReport)
async def get_report(
    session_id: str,
    summary: bool = Query(default=True, description="false skips the model-written summary (instant)"),
    user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo),
    summarize: SummaryFn = Depends(get_summarizer),
) -> MasteryReport:
    """The mastery report so far. Safe to call any time and repeatedly; it does not end the session."""
    rec, skill = await load_learn_session(repo, user, session_id)
    return await _report(rec, skill, user, repo, summarize, summary)


@router.post("/learn/sessions/{session_id}/finish", response_model=MasteryReport)
async def finish_learning(
    session_id: str, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo),
    summarize: SummaryFn = Depends(get_summarizer),
) -> MasteryReport:
    """End the session (tutor tool `finish_learning`): marks it done and returns the final report."""
    rec, skill = await load_learn_session(repo, user, session_id)
    report = await _report(rec, skill, user, repo, summarize, True)
    try:
        await repo.set_session_state(user, session_id, status="done")
    except RepoError:
        raise _storage_error()
    return report
