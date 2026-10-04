/**
 * Pause controller: decides WHEN Yoda may speak. Pure logic (no React, no timers, no DOM), so it is unit tested.
 * Yoda asks only at a natural pause: the screen has been idle, the expert is silent, Yoda is not already
 * talking or waiting for an answer, the question budget allows it, and a question is waiting in the queue.
 */

export type QuestionSource = "model" | "stub" | "manual";

export type QuestionCandidate = {
  /** Stable id used to drop duplicates. */
  id: string;
  question: string;
  /** Higher goes first. */
  priority: number;
  source: QuestionSource;
  /** Question type and the event it is about (from the backend's candidate), reported when it is asked. */
  type?: string;
  anchorEventId?: number | null;
  /** When the candidate entered the queue (ms epoch). */
  queuedAt: number;
};

export type PauseConfig = {
  /** No frame change for this long counts as an idle screen. */
  idleMs: number;
  /** The expert must have been silent for this long. */
  expertSilentMs: number;
  /** At least this long between two asked questions. */
  minGapMs: number;
  /** At most `maxPerWindow` automatic questions in each `windowMs`. */
  maxPerWindow: number;
  windowMs: number;
  /** A waiting question older than this is stale (the screen moved on) and is dropped. */
  maxAgeMs: number;
  /** The queue never holds more than this many questions. */
  maxQueue: number;
};

export const DEFAULT_PAUSE_CONFIG: PauseConfig = {
  idleMs: 2000,
  expertSilentMs: 1500,
  minGapMs: 60_000,
  maxPerWindow: 5,
  windowMs: 600_000,
  maxAgeMs: 180_000,
  maxQueue: 8,
};

/** What the page knows right now. Times are ms epoch (Date.now()). */
export type PauseSignals = {
  /** Last time the timeline got a new frame (the screen changed); null before the first one. */
  lastFrameChangeAt: number | null;
  /** The expert is talking right now. */
  expertSpeaking: boolean;
  /** Last time the expert was heard talking; null if never. */
  lastExpertSpeechAt: number | null;
  agentSpeaking: boolean;
  /** Yoda asked and the expert has not answered yet. */
  awaitingAnswer: boolean;
  connected: boolean;
  /** The expert said "off the record". */
  offRecord: boolean;
};

export type Check = { id: string; ok: boolean; detail: string };

export type Decision =
  | { kind: "ask"; candidate: QuestionCandidate; checks: Check[] }
  | { kind: "wait"; blockers: string[]; checks: Check[] };

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Normalise for duplicate detection. */
export function questionKey(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export class PauseController {
  readonly config: PauseConfig;
  private queue: QuestionCandidate[] = [];
  private seen = new Set<string>();
  private askedAt: number[] = [];
  private lastAskAt: number | null = null;

  constructor(config: Partial<PauseConfig> = {}) {
    this.config = { ...DEFAULT_PAUSE_CONFIG, ...config };
  }

  /** Adds a question. Returns false when it is empty, a duplicate (also of an already asked one) or the queue is full. */
  enqueue(c: Omit<QuestionCandidate, "queuedAt"> & { queuedAt?: number }, now: number): boolean {
    const question = c.question.trim();
    const key = questionKey(question);
    if (!key || this.seen.has(key) || this.seen.has(c.id)) return false;
    this.dropStale(now);
    if (this.queue.length >= this.config.maxQueue) return false;
    this.seen.add(key);
    this.seen.add(c.id);
    this.queue.push({ ...c, question, queuedAt: c.queuedAt ?? now });
    return true;
  }

  /** Waiting questions in the order they would be asked (highest priority, then oldest). */
  pending(now?: number): QuestionCandidate[] {
    if (now !== undefined) this.dropStale(now);
    return [...this.queue].sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
  }

  private dropStale(now: number) {
    this.queue = this.queue.filter((c) => now - c.queuedAt <= this.config.maxAgeMs);
  }

  private askedInWindow(now: number): number {
    return this.askedAt.filter((t) => now - t < this.config.windowMs).length;
  }

  /** Evaluate every rule. Does not change the budget or the gap (stale questions are dropped). */
  evaluate(now: number, s: PauseSignals): Decision {
    const cfg = this.config;
    const candidates = this.pending(now);
    const checks: Check[] = [];
    const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

    add("connected", s.connected, s.connected ? "Yoda is connected" : "Yoda is not connected");
    add("on_record", !s.offRecord, s.offRecord ? "off the record" : "recording");

    if (s.lastFrameChangeAt === null) add("screen_idle", false, "no frame yet");
    else {
      const idle = now - s.lastFrameChangeAt;
      add("screen_idle", idle >= cfg.idleMs, `screen idle ${secs(Math.max(0, idle))} (needs ${secs(cfg.idleMs)})`);
    }

    if (s.expertSpeaking) add("expert_silent", false, "expert is talking");
    else if (s.lastExpertSpeechAt === null) add("expert_silent", true, "expert has not spoken");
    else {
      const quiet = now - s.lastExpertSpeechAt;
      add("expert_silent", quiet >= cfg.expertSilentMs, `expert silent ${secs(Math.max(0, quiet))} (needs ${secs(cfg.expertSilentMs)})`);
    }

    add(
      "agent_quiet",
      !s.agentSpeaking && !s.awaitingAnswer,
      s.agentSpeaking ? "Yoda is speaking" : s.awaitingAnswer ? "waiting for the expert's answer" : "Yoda is quiet",
    );

    if (this.lastAskAt === null) add("gap", true, "no question asked yet");
    else {
      const since = now - this.lastAskAt;
      add("gap", since >= cfg.minGapMs, `last question ${secs(since)} ago (needs ${secs(cfg.minGapMs)})`);
    }

    const used = this.askedInWindow(now);
    add("budget", used < cfg.maxPerWindow, `${used}/${cfg.maxPerWindow} questions in the last ${Math.round(cfg.windowMs / 60000)} min`);
    add("candidate", candidates.length > 0, candidates.length ? `${candidates.length} question(s) waiting` : "no question waiting");

    const blockers = checks.filter((c) => !c.ok).map((c) => c.id);
    if (blockers.length === 0) return { kind: "ask", candidate: candidates[0], checks };
    return { kind: "wait", blockers, checks };
  }

  /** Call when the question was sent to the agent. A manual ask skips the budget but still starts the gap. */
  recordAsk(candidate: QuestionCandidate, now: number, manual = false) {
    this.queue = this.queue.filter((c) => c.id !== candidate.id);
    this.seen.add(questionKey(candidate.question));
    this.seen.add(candidate.id);
    this.lastAskAt = now;
    if (!manual) this.askedAt.push(now);
    this.askedAt = this.askedAt.filter((t) => now - t < this.config.windowMs);
  }

  /** Removes everything (e.g. a new session). */
  clear() {
    this.queue = [];
    this.seen.clear();
    this.askedAt = [];
    this.lastAskAt = null;
  }
}
