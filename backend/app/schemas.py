"""Request and response models. These are the contract with the frontend (see Notion page 04)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class SessionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    language: str = "en"


class SessionOut(BaseModel):
    session_id: str
    title: str
    description: str = ""  # echoed from the request, not stored yet
    language: str = "en"
    created_at: datetime


class Event(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    kind: str = "read"
    summary: str
    entities: dict = Field(default_factory=dict)
    visible_text: list[str] = Field(default_factory=list)
    salient: bool = False
    confidence: float = 0.0


class QuestionCandidate(BaseModel):
    id: str
    type: Literal["reason", "guardrail", "limit", "exception"]
    text: str
    anchor_event_id: int
    priority: float


class StepUpdate(BaseModel):
    idx: int
    title: str
    status: Literal["open", "closed"] = "open"


SkipReason = Literal["busy", "timeout", "vision_error", "parse_error", "storage_error", "off_the_record"]


class OffTheRecord(BaseModel):
    on: bool


class FrameResponse(BaseModel):
    t_ms: int
    screen_summary: str = ""
    events: list[Event] = Field(default_factory=list)
    question_candidates: list[QuestionCandidate] = Field(default_factory=list)
    step_update: StepUpdate | None = None
    latency_ms: int | None = None
    # Set when the frame was not analysed. The client should just carry on with the next frame.
    skipped: SkipReason | None = None


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginUser(BaseModel):
    id: str
    name: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: LoginUser


class SessionSummary(BaseModel):
    session_id: str
    title: str
    created_at: datetime
    last_screen_summary: str = ""
    events_count: int = 0


class StoredEvent(Event):
    t_ms: int = 0
    keyframe_path: str | None = None


class SessionDetail(SessionSummary):
    events: list[StoredEvent] = Field(default_factory=list)


# ---------------------------------------------------------------- transcript, questions, steps, gaps

Speaker = Literal["expert", "agent", "learner", "tutor"]


class UtteranceIn(BaseModel):
    t_ms: int = Field(ge=0)
    speaker: Speaker = "expert"
    text: str = Field(min_length=1, max_length=4000)


class UtterancesIn(BaseModel):
    utterances: list[UtteranceIn] = Field(min_length=1, max_length=200)


class UtterancesOut(BaseModel):
    stored: int
    ids: list[int]


class QuestionAsked(BaseModel):
    """Body of POST /sessions/{id}/questions/{qid}/asked. `qid` is the candidate id from the frames response."""

    type: str = "reason"
    text: str = Field(min_length=1, max_length=500)
    anchor_event_id: int | None = None
    asked_at_ms: int | None = Field(default=None, ge=0)
    phase: Literal["live", "debrief"] = "live"
    why_now: dict | None = None  # the pause trace shown in the UI


class QuestionOut(BaseModel):
    id: str
    phase: str
    type: str
    text: str
    anchor_event_id: int | None = None
    asked_at_ms: int | None = None
    answered: bool = False
    why_now: dict | None = None


class AnswerIn(BaseModel):
    """Interviewer client tool `log_answer`."""

    question_id: str
    summary: str = ""
    quote: str = Field(min_length=1, max_length=4000)  # what the expert said, stored as an expert utterance
    t_ms: int = Field(default=0, ge=0)


class AnswerOut(BaseModel):
    question_id: str
    utterance_id: int


class StepDraft(BaseModel):
    idx: int
    title: str
    t_start_ms: int | None = None
    t_end_ms: int | None = None
    event_ids: list[int] = Field(default_factory=list)
    question_ids: list[str] = Field(default_factory=list)
    status: Literal["open", "closed"] = "open"
    keyframe_path: str | None = None
    keyframe_url: str | None = None  # short-lived signed URL, filled on read, owner only


class KeyframeOut(BaseModel):
    t_ms: int
    url: str
    expires_in: int


GapType = Literal["missing_reason", "missing_guardrail", "unasked_question", "unclear_term", "unseen_case"]


class Gap(BaseModel):
    id: str
    type: GapType
    text: str  # a question the debrief agent can ask
    step_idx: int | None = None
    anchor_event_id: int | None = None
    priority: float


class FinishOut(BaseModel):
    session_id: str
    status: str
    steps: list[StepDraft]
    gaps: list[Gap]


class SessionSteps(BaseModel):
    steps: list[StepDraft]


# ---------------------------------------------------------------- skills (Holocrons)
# Skill JSON contract: Notion page 03. Differences: `reason` can be null (the expert never gave one),
# guardrails have `source` ("expert" or "teachback").

GuardrailType = Literal["limit", "exception", "stop_and_ask"]


class SkillAuthor(BaseModel):
    id: str
    name: str


class ScreenMoment(BaseModel):
    t_ms: int
    keyframe_path: str | None = None
    keyframe_url: str | None = None  # signed on read for the owner, never stored in skill_json
    description: str = ""


class Decision(BaseModel):
    type: Literal["judgment", "routine"] = "routine"
    summary: str = ""


class Reason(BaseModel):
    text: str
    quote: str
    t_ms: int = 0


class Guardrail(BaseModel):
    id: str = ""
    type: GuardrailType
    rule: str
    quote: str = ""  # verbatim from the transcript; empty only when source is "teachback"
    t_ms: int | None = None
    source: Literal["expert", "teachback"] = "expert"


class SkillStep(BaseModel):
    idx: int
    title: str
    screen_moment: ScreenMoment
    decision: Decision = Field(default_factory=Decision)
    reason: Reason | None = None
    guardrails: list[Guardrail] = Field(default_factory=list)
    predict_prompt: str | None = None  # set for judgment steps


class Teachback(BaseModel):
    confirmed: bool = False
    corrections: list[str] = Field(default_factory=list)


class SkillJson(BaseModel):
    id: str
    title: str
    description: str = ""
    author: SkillAuthor
    created_at: datetime
    language: str = "en"
    steps: list[SkillStep] = Field(default_factory=list)
    global_guardrails: list[Guardrail] = Field(default_factory=list)
    teachback: Teachback = Field(default_factory=Teachback)


class SkillSummary(BaseModel):
    id: str
    title: str
    description: str = ""
    domain: str | None = None
    language: str = "en"
    status: Literal["draft", "published"]
    author: SkillAuthor
    steps_count: int = 0
    guardrails_count: int = 0
    created_at: datetime
    published_at: datetime | None = None
    learners_count: int = 0  # distinct people who started a learn session (never who)
    avg_mastery: float | None = None  # 0..100 over finished learn sessions, null if none


class SkillDetail(SkillSummary):
    skill: SkillJson | None = None  # null for a skill that was never synthesized
    skill_md: str | None = None


class TeachbackIn(BaseModel):
    confirmed: bool = True
    corrections: list[str] = Field(default_factory=list, max_length=50)


class SynthesizeOut(BaseModel):
    skill_id: str
    status: Literal["draft"] = "draft"
    steps_count: int
    guardrails_count: int
    attempts: int  # 1, or 2 when the quote check forced a retry
