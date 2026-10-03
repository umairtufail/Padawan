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
    description: str
    language: str
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


SkipReason = Literal["busy", "timeout", "vision_error", "parse_error"]


class FrameResponse(BaseModel):
    t_ms: int
    screen_summary: str = ""
    events: list[Event] = Field(default_factory=list)
    question_candidates: list[QuestionCandidate] = Field(default_factory=list)
    step_update: StepUpdate | None = None
    latency_ms: int | None = None
    # Set when the frame was not analysed. The client should just carry on with the next frame.
    skipped: SkipReason | None = None
