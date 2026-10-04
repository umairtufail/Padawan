/**
 * Pure helpers that connect the live voice conversation to the backend pipeline: which question id to report, what
 * the answer's quote is, and the transcript queue. No React, no network, so they are unit tested.
 */
import type { Check } from "./pause-controller";
import type { QuestionAskedBody, Speaker, UtteranceIn } from "./pipeline-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s);

/** The backend only accepts UUID question ids. Model candidates have one; stub and manual questions get a fresh one. */
export function questionIdFor(candidateId: string, generate: () => string): string {
  return isUuid(candidateId) ? candidateId : generate();
}

export type AskedInfo = {
  question: string;
  type?: string;
  anchorEventId?: number | null;
};

/** Body for POST /sessions/{id}/questions/{qid}/asked, including the "why now" trace shown in the UI. */
export function askedBody(
  q: AskedInfo,
  opts: { askedAtMs: number; phase: "live" | "debrief"; manual: boolean; checks?: Check[] },
): QuestionAskedBody {
  return {
    type: q.type || "reason",
    text: q.question.slice(0, 500),
    anchor_event_id: q.anchorEventId ?? null,
    asked_at_ms: Math.max(0, Math.round(opts.askedAtMs)),
    phase: opts.phase,
    why_now: {
      manual: opts.manual,
      checks: (opts.checks ?? []).map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })),
    },
  };
}

export function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export type CaptionLike = { who: "yoda" | "expert"; text: string; at: number };

/** The expert's transcribed lines since `sinceAt` (ms epoch). */
export function expertLinesSince(captions: CaptionLike[], sinceAt: number): string[] {
  return captions.filter((c) => c.who === "expert" && c.at >= sinceAt).map((c) => c.text.trim()).filter(Boolean);
}

/**
 * What the expert said in answer to a question: their lines since the question was asked, joined. If nothing was
 * transcribed, the agent's one-line summary (so the answer is never lost), else a placeholder.
 */
export function pickAnswerQuote(captions: CaptionLike[], sinceAt: number, summary: string, max = 4000): string {
  const spoken = expertLinesSince(captions, sinceAt).join(" ");
  const quote = spoken || summary.trim() || "(answered aloud)";
  return quote.slice(0, max);
}

/** The id to report an answer against: the one the agent named if we asked it, else the question that is open now. */
export function resolveQuestionId(agentId: string | undefined, known: ReadonlySet<string>, openId: string | null): string | null {
  if (agentId && known.has(agentId)) return agentId;
  return openId;
}

export const speakerFor = (who: CaptionLike["who"]): Speaker => (who === "yoda" ? "agent" : "expert");

/**
 * Transcript lines waiting to be sent. Lines are drained in batches of at most 200 (the endpoint's limit). A failed
 * send puts the batch back at the front. `suppress` drops a line that was already stored another way (an answer's
 * quote is stored by POST .../answers, so it must not be sent twice).
 */
export class UtteranceQueue {
  private lines: UtteranceIn[] = [];
  private suppressed = new Map<string, number>();

  constructor(private batch = 200) {}

  get size(): number {
    return this.lines.length;
  }

  add(line: UtteranceIn): void {
    const text = line.text.trim();
    if (!text) return;
    if (line.speaker === "expert") {
      const n = this.suppressed.get(text) ?? 0;
      if (n > 0) {
        this.suppressed.set(text, n - 1);
        return;
      }
    }
    this.lines.push({ ...line, text: text.slice(0, 4000), t_ms: Math.max(0, Math.round(line.t_ms)) });
  }

  /** Marks an expert line as stored elsewhere: removes it if it is still waiting, else ignores its next arrival. */
  suppress(text: string): void {
    const t = text.trim();
    if (!t) return;
    const i = this.lines.findIndex((l) => l.speaker === "expert" && l.text === t);
    if (i >= 0) this.lines.splice(i, 1);
    else this.suppressed.set(t, (this.suppressed.get(t) ?? 0) + 1);
  }

  take(): UtteranceIn[] {
    return this.lines.splice(0, this.batch);
  }

  putBack(batch: UtteranceIn[]): void {
    this.lines.unshift(...batch);
  }
}
