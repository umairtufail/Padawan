/**
 * Learn mode: types of the /v1/learn endpoints (docs/frontend-integration.md section 10) and the pure logic of the
 * learn page. No network or browser code here so it stays easy to test.
 */
import type { FrameResponse } from "./api";
import type { SkillJson, SkillStep } from "./skills";

export type Verdict = "ok" | "warn" | "stop";
export type ReplayMoment = { step_idx: number; t_ms: number; description: string; keyframe_path: string | null };
export type GuardrailVerdict = {
  verdict: Verdict;
  checked: boolean;
  step_idx: number | null;
  step_title: string;
  guardrail_id: string | null;
  rule: string;
  expert_quote: string;
  reason: string;
  confidence: number;
  committed: boolean;
  repeated: boolean;
  degraded: boolean;
  replay: ReplayMoment | null;
};
export type LearnFrameResponse = FrameResponse & { verdict: GuardrailVerdict | null };
export type LearnSessionOut = {
  session_id: string;
  skill_id: string;
  title: string;
  created_at: string;
  current_step_idx: number;
  skill: SkillJson;
};
export type PredictionResult = {
  step_idx: number;
  predicted: string;
  correct: boolean;
  judged_by: "model" | "heuristic";
  expected: string;
  reason: string | null;
  reason_quote: string | null;
  replay: ReplayMoment;
};
export type PredictionOut = { step_idx: number; predicted: string; resolved: boolean; result: PredictionResult | null };
export type StepResult = "mastered" | "practise" | "not_reached";
export type StepReport = {
  step_idx: number;
  title: string;
  decision_type: "judgment" | "routine";
  reached: boolean;
  predicted: string | null;
  predicted_right: boolean | null;
  interventions: number;
  warnings: number;
  guardrail_id: string | null;
  time_ms: number | null;
  score: number;
  result: StepResult;
};
export type PracticeItem = { step_idx: number; title: string; why: string; guardrail_id: string | null; rule: string | null };
export type MasteryReport = {
  session_id: string;
  skill_id: string;
  skill_title: string;
  mastery_score: number;
  steps_total: number;
  steps_reached: number;
  steps_mastered: number;
  predictions_total: number;
  predictions_right: number;
  interventions_total: number;
  warnings_total: number;
  time_total_ms: number;
  steps: StepReport[];
  practise_next: PracticeItem[];
  summary: string;
  summary_source: "model" | "fallback" | "none";
};

// ---------- verdicts ----------

/** The banner already says "Wait."; the model's reason often starts with it too. */
export function stripWait(text: string): string {
  return text.replace(/^\s*(?:wait|stop)[.,!]?\s*/i, "").replace(/^./, (c) => c.toUpperCase());
}

export type Banner = { kind: "stop" | "warn"; verdict: GuardrailVerdict };

export type LearnState = {
  /** The skill step the learner is on now (from the verdicts). */
  stepIdx: number;
  banner: Banner | null;
  /** Per step: how many times Yoda stopped or warned (not counting repeated verdicts). */
  stops: Record<number, number>;
  warns: Record<number, number>;
};

/** What the page should do about a verdict: tell Yoda (he says it aloud) and, for a stop, nothing else is needed. */
export type VerdictEffect = { type: "stop" | "warn"; verdict: GuardrailVerdict } | null;

export function initialLearnState(stepIdx: number): LearnState {
  return { stepIdx, banner: null, stops: {}, warns: {} };
}

/**
 * Applies one frame verdict to the page state. Rules (docs section 10):
 * - null (frame skipped) and degraded verdicts are ignored silently;
 * - `checked: false` is no news: it never clears a banner;
 * - `repeated` keeps the banner but is not spoken or counted again;
 * - a `stop` stays on screen until a `checked` ok arrives (a warn does not replace it);
 * - the step marker follows `step_idx` whenever the backend sends one.
 */
export function applyVerdict(state: LearnState, v: GuardrailVerdict | null): { state: LearnState; effect: VerdictEffect } {
  if (!v || v.degraded) return { state, effect: null };
  const stepIdx = typeof v.step_idx === "number" && v.step_idx > 0 ? v.step_idx : state.stepIdx;
  let next: LearnState = stepIdx === state.stepIdx ? state : { ...state, stepIdx };
  if (!v.checked) return { state: next, effect: null };

  if (v.verdict === "ok") {
    return { state: next.banner ? { ...next, banner: null } : next, effect: null };
  }

  const kind = v.verdict;
  const keepStop = state.banner?.kind === "stop" && kind === "warn";
  const banner: Banner = keepStop ? (state.banner as Banner) : { kind, verdict: v };
  next = { ...next, banner };
  if (v.repeated) return { state: next, effect: null };

  const key = v.step_idx ?? stepIdx;
  const bucket = kind === "stop" ? "stops" : "warns";
  next = { ...next, [bucket]: { ...next[bucket], [key]: (next[bucket][key] ?? 0) + 1 } };
  return { state: next, effect: { type: kind, verdict: v } };
}

/** The user message that makes the tutor speak (see backend/app/prompts/tutor.system.md). */
export function interventionMessage(v: GuardrailVerdict): string {
  return `[INTERVENE] step ${v.step_idx ?? 0}, guardrail ${v.guardrail_id ?? "none"}: ${v.rule}. ${v.reason}`.trim();
}

export function warnMessage(v: GuardrailVerdict): string {
  return `[WARN] step ${v.step_idx ?? 0}, guardrail ${v.guardrail_id ?? "none"}: ${v.rule}. ${v.reason}`.trim();
}

/** Asks Yoda to teach a step aloud and ask the Padawan what they expect. */
export function stepMessage(step: Pick<SkillStep, "idx" | "title">, first: boolean): string {
  return first
    ? `[START] The Padawan is ready. Welcome them in one sentence, then teach step ${step.idx}: ${step.title}. Explain it in the Master's words and ask what they expect to happen.`
    : `[STEP] The Padawan is now on step ${step.idx}: ${step.title}. Explain it briefly in the Master's words and ask what they expect to happen.`;
}

export function reportMessage(r: Pick<MasteryReport, "mastery_score" | "summary">): string {
  return `[REPORT] The lesson is over. Mastery score ${r.mastery_score} of 100. Say aloud, in two short sentences, what the Padawan mastered and what to practise. ${r.summary}`.trim();
}

/** True when Yoda should be told about a step change: the step really moved forward or back. */
export function shouldAnnounceStep(announced: number | null, current: number): boolean {
  return current > 0 && announced !== current;
}

// ---------- predictions and replay ----------

/** What the record_prediction tool answers to Yoda: whether it was right and the Master's decision. */
export function predictionSentence(r: PredictionResult): string {
  const why = r.reason_quote ? `The Master said: "${r.reason_quote}"` : r.reason ? `The reason: ${r.reason}` : "";
  return `${r.correct ? "Right." : "Not quite."} The Master decided: ${r.expected}. ${why}`.trim();
}

export type PredictionNote = { predicted: string; correct: boolean; expected: string };

export function stepById(skill: Pick<SkillJson, "steps">, idx: number): SkillStep | undefined {
  return skill.steps.find((s) => s.idx === idx);
}

/** The expert's moment for a step, from the skill itself (used when Yoda calls show_replay). */
export function replayForStep(skill: Pick<SkillJson, "steps">, idx: number): { step: SkillStep; moment: ReplayMoment } | null {
  const step = stepById(skill, idx);
  if (!step) return null;
  return { step, moment: { step_idx: step.idx, t_ms: step.screen_moment.t_ms, description: step.screen_moment.description, keyframe_path: step.screen_moment.keyframe_path ?? null } };
}

export type StepStatus = "done" | "current" | "todo";

/** Done = before the current step; the learner may also go back, the marker simply follows the backend. */
export function stepStatus(step: Pick<SkillStep, "idx">, currentIdx: number): StepStatus {
  return step.idx < currentIdx ? "done" : step.idx === currentIdx ? "current" : "todo";
}

// ---------- report helpers ----------

/** "1:05" or "0:42" from milliseconds; "-" when there is no time. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "-";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export type ScoreTone = "jade" | "gold" | "danger";
/** Colour band of a mastery score (0 to 100): 75 matches the backend's "mastered" cut. */
export function scoreTone(score: number): ScoreTone {
  return score >= 75 ? "jade" : score >= 40 ? "gold" : "danger";
}

export function scoreTitle(score: number): string {
  return score >= 75 ? "Holocron mastered" : score >= 40 ? "The way is clear, practise remains" : "Much to practise, Padawan";
}

export const RESULT_LABEL: Record<StepResult, string> = {
  mastered: "Mastered",
  practise: "Practise",
  not_reached: "Not reached",
};

/** Describes how the prediction for a step went, for the report row. */
export function predictionLabel(s: Pick<StepReport, "predicted" | "predicted_right">): string {
  if (s.predicted === null) return "No prediction";
  return s.predicted_right === null ? "Prediction not compared" : s.predicted_right ? "Predicted right" : "Predicted wrong";
}
