import type { FrameResponse, PadawanEvent } from "./api";

/** A question as it arrives from a source, before it enters the pause controller's queue. */
export type RawQuestion = { id: string; question: string; priority: number; source: "model" | "stub" };

/**
 * Questions from the model's `question_candidates` in a frame response. The planner (#27) has not landed, so the
 * exact shape is not fixed: accept plain strings and objects with `question` or `text` (and optional `id`, `priority`).
 */
export function candidatesFromResponse(res: Pick<FrameResponse, "question_candidates" | "t_ms">): RawQuestion[] {
  const out: RawQuestion[] = [];
  (res.question_candidates ?? []).forEach((raw, i) => {
    let question = "";
    let id = "";
    let priority = 5;
    if (typeof raw === "string") question = raw;
    else if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      const q = o.question ?? o.text;
      if (typeof q === "string") question = q;
      if (typeof o.id === "string" || typeof o.id === "number") id = String(o.id);
      if (typeof o.priority === "number") priority = o.priority;
    }
    question = question.trim();
    if (question) out.push({ id: id || `model-${res.t_ms}-${i}`, question, priority, source: "model" });
  });
  return out;
}

/**
 * Stub source until the question planner lands (#27): a "why" question for a salient event.
 * Only used when the model sent no candidates for the frame.
 */
export function stubQuestionFromEvent(ev: PadawanEvent): RawQuestion | null {
  if (!ev.salient) return null;
  const e = ev.entities ?? {};
  let question: string;
  if (e.field && e.from && e.to) question = `Why did you change ${e.field} from ${e.from} to ${e.to}?`;
  else if (e.button) question = `Why did you click ${e.button} now?`;
  else if (ev.summary) question = `Why this: ${ev.summary.replace(/[.?!]+$/, "")}?`;
  else return null;
  return { id: `stub-${ev.id}`, question, priority: 3, source: "stub" };
}

/** Candidates for a frame response: the model's if present, else the stub for its salient events. */
export function questionsForResponse(res: FrameResponse): RawQuestion[] {
  const fromModel = candidatesFromResponse(res);
  if (fromModel.length) return fromModel;
  return res.events.map(stubQuestionFromEvent).filter((q): q is RawQuestion => q !== null);
}

/** Short screen update for the agent (under 200 characters, one line). */
export function screenUpdateText(summary: string, max = 190): string {
  const clean = summary.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const text = `Screen: ${clean}`;
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Allows at most one contextual update per `minGapMs`. Pure. */
export class UpdateThrottle {
  private last = -Infinity;
  constructor(private minGapMs = 2000) {}
  /** Returns true when an update may be sent now (and records it). */
  take(now: number): boolean {
    if (now - this.last < this.minGapMs) return false;
    this.last = now;
    return true;
  }
}
