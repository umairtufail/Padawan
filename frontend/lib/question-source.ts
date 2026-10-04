import type { FrameResponse, PadawanEvent } from "./api";

/** A question as it arrives from a source, before it enters the pause controller's queue. */
export type RawQuestion = {
  /** For model questions this is the backend's candidate id (a UUID), needed for POST .../questions/{id}/asked. */
  id: string;
  question: string;
  priority: number;
  source: "model" | "stub";
  type?: string;
  anchorEventId?: number | null;
};

/** Questions from the backend's `question_candidates` (at most 3 per frame, best first). */
export function candidatesFromResponse(res: Pick<FrameResponse, "question_candidates">): RawQuestion[] {
  const out: RawQuestion[] = [];
  for (const c of res.question_candidates ?? []) {
    const question = typeof c?.text === "string" ? c.text.trim() : "";
    if (!question || typeof c.id !== "string" || !c.id) continue;
    out.push({
      id: c.id, question, priority: typeof c.priority === "number" ? c.priority : 0.5, source: "model",
      type: c.type, anchorEventId: typeof c.anchor_event_id === "number" ? c.anchor_event_id : null,
    });
  }
  return out;
}

/**
 * Fallback when the planner sends nothing (it is slow, failed or off): a "why" question for a salient event.
 * Only used when the backend sent no candidates for the frame.
 */
export function stubQuestionFromEvent(ev: PadawanEvent): RawQuestion | null {
  if (!ev.salient) return null;
  const e = ev.entities ?? {};
  let question: string;
  if (e.field && e.from && e.to) question = `Why did you change ${e.field} from ${e.from} to ${e.to}?`;
  else if (e.button) question = `Why did you click ${e.button} now?`;
  else if (ev.summary) question = `Why this: ${ev.summary.replace(/[.?!]+$/, "")}?`;
  else return null;
  // Below every model priority (0 to 1), so a real candidate always goes first.
  return { id: `stub-${ev.id}`, question, priority: -1, source: "stub", type: "reason", anchorEventId: ev.id };
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
