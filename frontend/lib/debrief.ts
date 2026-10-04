/** Pure logic of the debrief screen: gap answers, done criteria, the teach-back summary and corrections. */
import type { Gap, QuestionType, StepDraft } from "./pipeline-types";

const GAP_TO_QUESTION: Record<Gap["type"], QuestionType> = {
  missing_reason: "reason",
  missing_guardrail: "guardrail",
  unasked_question: "reason",
  unclear_term: "reason",
  unseen_case: "exception",
};
export const questionTypeForGap = (t: Gap["type"]): QuestionType => GAP_TO_QUESTION[t];

export const GAP_LABEL: Record<Gap["type"], string> = {
  missing_reason: "Missing reason",
  missing_guardrail: "Missing limit",
  unasked_question: "Not asked yet",
  unclear_term: "Unclear term",
  unseen_case: "Case not seen",
};

/** Gaps by priority, best first. The backend already sorts them; this keeps the UI stable if it does not. */
export function sortGaps(gaps: Gap[]): Gap[] {
  return [...gaps].sort((a, b) => b.priority - a.priority);
}

/** The ticket's done criteria: at least 3 gap questions answered (or all of them when there are fewer). */
export const MIN_GAP_ANSWERS = 3;

export function requiredAnswers(gaps: Gap[]): number {
  return Math.min(MIN_GAP_ANSWERS, gaps.length);
}

export function debriefReady(gaps: Gap[], answered: ReadonlySet<string>): boolean {
  const done = gaps.filter((g) => answered.has(g.id)).length;
  return done >= requiredAnswers(gaps);
}

/** Which gap a voice answer belongs to: the id the agent named if it is a real open gap, else the next open one. */
export function resolveGapId(agentId: string | undefined, gaps: Gap[], answered: ReadonlySet<string>, lastAskedId: string | null): string | null {
  const open = sortGaps(gaps).filter((g) => !answered.has(g.id));
  if (agentId && open.some((g) => g.id === agentId)) return agentId;
  if (lastAskedId && open.some((g) => g.id === lastAskedId)) return lastAskedId;
  return open[0]?.id ?? null;
}

/** One contextual update telling Yoda which gaps to close, in order (the backend's `gaps` variable is still empty). */
export function gapsContext(gaps: Gap[], max = 6): string {
  const lines = sortGaps(gaps).slice(0, max).map((g, i) => `${i + 1}. [${g.id}] ${g.text}`);
  return lines.length ? `Gaps to close with the expert, in order (use the id in brackets as question_id): ${lines.join(" ")}` : "";
}

/** What Yoda explains back, as text: every step, its reason when one was given, and how many questions it had. */
export function buildTeachbackSummary(steps: StepDraft[], answers: { gap: Gap; summary: string }[] = []): string {
  if (steps.length === 0) return "I saw nothing yet, so I have nothing to explain back.";
  const parts = [...steps].sort((a, b) => a.idx - b.idx).map((s) => {
    const why = answers.find((a) => a.gap.step_idx === s.idx && a.gap.type === "missing_reason");
    const stop = answers.find((a) => a.gap.step_idx === s.idx && a.gap.type === "missing_guardrail");
    let line = `Step ${s.idx}: ${s.title.replace(/[.?!]+$/, "")}.`;
    if (why?.summary) line += ` Why: ${why.summary.replace(/[.?!]+$/, "")}.`;
    if (stop?.summary) line += ` Limit: ${stop.summary.replace(/[.?!]+$/, "")}.`;
    return line;
  });
  return `This is what I understood, Master. ${parts.join(" ")} Is that how it works?`;
}

/** Corrections come as one text (a textarea, or the agent tool's string): one per non-empty line, max 50. */
export function parseCorrections(input: string | string[] | undefined): string[] {
  const raw = Array.isArray(input) ? input : (input ?? "").split(/\r?\n/);
  return raw.map((l) => l.replace(/^\s*[-*\d.)]+\s+/, "").trim()).filter(Boolean).slice(0, 50);
}

/** Debrief lines continue the session's clock: after the last step, plus the time since the debrief opened. */
export function debriefTimeMs(steps: StepDraft[], openedAt: number, now: number): number {
  const end = steps.reduce((m, s) => Math.max(m, s.t_end_ms ?? 0), 0);
  return end + Math.max(0, now - openedAt);
}
