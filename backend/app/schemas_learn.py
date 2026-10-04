"""Request and response models for learn mode (/v1/learn). Contract with the frontend, see docs/frontend-integration.md."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from .schemas import FrameResponse, SkillJson

Verdict = Literal["ok", "warn", "stop"]


class ReplayMoment(BaseModel):
    """Where the Master did this step (for the replay panel). keyframe_path is null until keyframes are stored."""

    step_idx: int
    t_ms: int
    description: str = ""
    keyframe_path: str | None = None


class GuardrailVerdict(BaseModel):
    verdict: Verdict = "ok"
    # False when no check ran for this frame (no new events). Then `verdict` is just "ok": keep showing the last real one.
    checked: bool = True
    step_idx: int | None = None  # the skill step the learner is on now
    step_title: str = ""
    guardrail_id: str | None = None  # set on warn and stop
    rule: str = ""
    expert_quote: str = ""  # verbatim from the Holocron; empty for a teach-back guardrail
    reason: str = ""  # one sentence in Yoda's voice, safe to speak
    confidence: float = 0.0
    committed: bool = False  # the move was already saved/posted: too late to stop, so the verdict is at most warn
    repeated: bool = False  # same verdict as the previous one within 30 s: keep the banner, do NOT speak again
    degraded: bool = False  # the checker failed or timed out, verdict forced to ok
    replay: ReplayMoment | None = None


class LearnFrameResponse(FrameResponse):
    verdict: GuardrailVerdict | None = None  # null when the frame was skipped


class LearnSessionCreate(BaseModel):
    skill_id: str


class LearnSessionOut(BaseModel):
    session_id: str
    skill_id: str
    title: str
    created_at: datetime
    current_step_idx: int  # the first step
    skill: SkillJson  # the Holocron to learn: steps, reasons, guardrails (tutor context)


class PredictionIn(BaseModel):
    step_idx: int
    predicted: str = Field(min_length=1, max_length=500)
    resolve: bool = False  # also compare right now (what the tutor tool record_prediction wants)


class PredictionResult(BaseModel):
    step_idx: int
    predicted: str
    correct: bool
    judged_by: Literal["model", "heuristic"]
    expected: str  # the Master's decision for this step
    reason: str | None = None
    reason_quote: str | None = None
    replay: ReplayMoment


class PredictionOut(BaseModel):
    step_idx: int
    predicted: str
    resolved: bool
    result: PredictionResult | None = None  # set when resolved


StepResult = Literal["mastered", "practise", "not_reached"]


class StepReport(BaseModel):
    step_idx: int
    title: str
    decision_type: Literal["judgment", "routine"]
    reached: bool
    predicted: str | None = None
    predicted_right: bool | None = None  # null: no prediction, or not compared yet
    interventions: int = 0  # stops
    warnings: int = 0
    guardrail_id: str | None = None  # the last guardrail raised on this step
    time_ms: int | None = None
    score: float = 0.0  # 0 to 1
    result: StepResult = "not_reached"


class PracticeItem(BaseModel):
    step_idx: int
    title: str
    why: str
    guardrail_id: str | None = None
    rule: str | None = None


class MasteryReport(BaseModel):
    session_id: str
    skill_id: str
    skill_title: str
    mastery_score: int  # 0 to 100
    steps_total: int
    steps_reached: int
    steps_mastered: int
    predictions_total: int
    predictions_right: int
    interventions_total: int
    warnings_total: int
    time_total_ms: int
    steps: list[StepReport]
    practise_next: list[PracticeItem]  # worst first
    summary: str  # 2 to 3 sentences
    summary_source: Literal["model", "fallback", "none"]
