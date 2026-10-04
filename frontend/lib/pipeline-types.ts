/** Shapes of the skills pipeline endpoints (backend/app/schemas.py, docs/frontend-integration.md section 3b). */

export type QuestionType = "reason" | "guardrail" | "limit" | "exception";

export type QuestionCandidate = {
  id: string;
  type: QuestionType;
  text: string;
  anchor_event_id: number;
  /** 0 to 1. */
  priority: number;
};

export type StepStatus = "open" | "closed";

export type StepUpdate = { idx: number; title: string; status: StepStatus };

export type StepDraft = {
  idx: number;
  title: string;
  t_start_ms: number | null;
  t_end_ms: number | null;
  event_ids: number[];
  question_ids: string[];
  status: StepStatus;
};

export type GapType = "missing_reason" | "missing_guardrail" | "unasked_question" | "unclear_term" | "unseen_case";

export type Gap = {
  id: string;
  type: GapType;
  /** A question the debrief agent can ask. */
  text: string;
  step_idx: number | null;
  anchor_event_id: number | null;
  priority: number;
};

export type Speaker = "expert" | "agent" | "learner" | "tutor";

export type UtteranceIn = { t_ms: number; speaker: Speaker; text: string };

export type QuestionAskedBody = {
  type?: string;
  text: string;
  anchor_event_id?: number | null;
  asked_at_ms?: number | null;
  phase?: "live" | "debrief";
  why_now?: Record<string, unknown> | null;
};

export type AnswerBody = { question_id: string; quote: string; summary?: string; t_ms?: number };

export type FinishResult = {
  session_id: string;
  status: string;
  steps: StepDraft[];
  gaps: Gap[];
};

export type TeachbackResult = {
  skill_id: string;
  status: "draft";
  steps_count: number;
  guardrails_count: number;
  attempts: number;
};
