import { describe, expect, it } from "vitest";
import { PauseController, type PauseSignals } from "./pause-controller";
import { candidatesFromResponse, questionsForResponse, screenUpdateText, stubQuestionFromEvent, UpdateThrottle } from "./question-source";
import type { FrameResponse, PadawanEvent } from "./api";

const T0 = 1_000_000;
const q = (id: string, question = `Why ${id}?`, priority = 1) => ({ id, question, priority, source: "model" as const });

/** Signals where every rule passes at T0 + 10 s. */
function calm(over: Partial<PauseSignals> = {}): PauseSignals {
  return {
    lastFrameChangeAt: T0,
    expertSpeaking: false,
    lastExpertSpeechAt: null,
    agentSpeaking: false,
    awaitingAnswer: false,
    connected: true,
    offRecord: false,
    ...over,
  };
}

function ready(): PauseController {
  const c = new PauseController();
  c.enqueue(q("a"), T0);
  return c;
}

const NOW = T0 + 10_000;

describe("PauseController.evaluate", () => {
  it("asks when every rule passes", () => {
    const d = ready().evaluate(NOW, calm());
    expect(d.kind).toBe("ask");
    if (d.kind === "ask") expect(d.candidate.id).toBe("a");
  });

  it("waits while the screen changed less than 2 s ago, and asks once it has been idle 2 s", () => {
    const c = ready();
    const early = c.evaluate(T0 + 1999, calm());
    expect(early.kind).toBe("wait");
    if (early.kind === "wait") expect(early.blockers).toEqual(["screen_idle"]);
    expect(c.evaluate(T0 + 2000, calm()).kind).toBe("ask");
  });

  it("waits when there has been no frame yet", () => {
    const d = ready().evaluate(NOW, calm({ lastFrameChangeAt: null }));
    expect(d.kind === "wait" && d.blockers).toContain("screen_idle");
  });

  it("waits while the expert talks and until 1.5 s after the last word", () => {
    const c = ready();
    const talking = c.evaluate(NOW, calm({ expertSpeaking: true, lastExpertSpeechAt: NOW }));
    expect(talking.kind === "wait" && talking.blockers).toEqual(["expert_silent"]);
    expect(c.evaluate(NOW + 1000, calm({ lastExpertSpeechAt: NOW })).kind).toBe("wait");
    expect(c.evaluate(NOW + 1500, calm({ lastExpertSpeechAt: NOW })).kind).toBe("ask");
  });

  it("waits while Yoda speaks or waits for an answer", () => {
    const c = ready();
    expect(c.evaluate(NOW, calm({ agentSpeaking: true })).kind).toBe("wait");
    expect(c.evaluate(NOW, calm({ awaitingAnswer: true })).kind).toBe("wait");
  });

  it("waits when disconnected or off the record", () => {
    const c = ready();
    expect(c.evaluate(NOW, calm({ connected: false })).kind).toBe("wait");
    expect(c.evaluate(NOW, calm({ offRecord: true })).kind).toBe("wait");
  });

  it("waits when nothing is queued", () => {
    const d = new PauseController().evaluate(NOW, calm());
    expect(d.kind === "wait" && d.blockers).toEqual(["candidate"]);
  });

  it("reports every blocker at once, with a reason for each rule", () => {
    const d = ready().evaluate(T0 + 100, calm({ expertSpeaking: true, agentSpeaking: true }));
    expect(d.kind === "wait" && d.blockers).toEqual(["screen_idle", "expert_silent", "agent_quiet"]);
    expect(d.checks.map((c) => c.id)).toEqual(["connected", "on_record", "screen_idle", "expert_silent", "agent_quiet", "gap", "budget", "candidate"]);
    expect(d.checks.every((c) => c.detail.length > 0)).toBe(true);
  });
});

describe("question budget", () => {
  it("keeps 60 s between two questions", () => {
    const c = new PauseController();
    c.enqueue(q("a"), T0);
    c.enqueue(q("b"), T0);
    const first = c.evaluate(NOW, calm());
    expect(first.kind).toBe("ask");
    if (first.kind === "ask") c.recordAsk(first.candidate, NOW);
    const soon = c.evaluate(NOW + 59_999, calm({ lastFrameChangeAt: T0 }));
    expect(soon.kind === "wait" && soon.blockers).toEqual(["gap"]);
    expect(c.evaluate(NOW + 60_000, calm()).kind).toBe("ask");
  });

  it("allows at most 5 questions per 10 minutes, then frees a slot", () => {
    const c = new PauseController({ minGapMs: 1000 });
    let t = T0;
    for (let i = 0; i < 6; i++) c.enqueue(q(`q${i}`), t);
    for (let i = 0; i < 5; i++) {
      t += 5000;
      const d = c.evaluate(t, calm());
      expect(d.kind).toBe("ask");
      if (d.kind === "ask") c.recordAsk(d.candidate, t);
    }
    t += 5000;
    const blocked = c.evaluate(t, calm());
    expect(blocked.kind === "wait" && blocked.blockers).toEqual(["budget"]);
    // 10 minutes after the first ask the window has room again (the sixth question is stale by then, so queue a new one).
    const later = T0 + 5000 + 600_000;
    c.enqueue(q("fresh"), later - 1000);
    expect(c.evaluate(later, calm({ lastFrameChangeAt: later - 5000 })).kind).toBe("ask");
  });

  it("a manual ask does not use the budget but still starts the gap", () => {
    const c = new PauseController({ maxPerWindow: 1 });
    c.enqueue(q("a"), T0);
    c.recordAsk({ ...q("m"), queuedAt: T0, source: "manual" }, NOW, true);
    const d = c.evaluate(NOW + 61_000, calm());
    expect(d.kind).toBe("ask");
    const early = c.evaluate(NOW + 5000, calm());
    expect(early.kind === "wait" && early.blockers).toEqual(["gap"]);
  });
});

describe("queue", () => {
  it("drops duplicates, also of questions already asked", () => {
    const c = new PauseController();
    expect(c.enqueue(q("a", "Why 0400?"), T0)).toBe(true);
    expect(c.enqueue(q("b", "why   0400 ?"), T0)).toBe(false);
    expect(c.enqueue(q("a", "Other"), T0)).toBe(false);
    c.recordAsk(c.pending()[0], T0);
    expect(c.enqueue(q("c", "Why 0400?"), T0 + 1)).toBe(false);
  });

  it("ignores empty questions", () => {
    expect(new PauseController().enqueue(q("a", "   "), T0)).toBe(false);
  });

  it("orders by priority, then oldest", () => {
    const c = new PauseController();
    c.enqueue(q("low", "low?", 1), T0);
    c.enqueue(q("high", "high?", 9), T0 + 10);
    c.enqueue(q("low2", "low2?", 1), T0 + 20);
    expect(c.pending().map((x) => x.id)).toEqual(["high", "low", "low2"]);
  });

  it("drops stale questions and caps the queue", () => {
    const c = new PauseController({ maxAgeMs: 1000, maxQueue: 2 });
    expect(c.enqueue(q("a"), T0)).toBe(true);
    expect(c.enqueue(q("b"), T0)).toBe(true);
    expect(c.enqueue(q("c"), T0)).toBe(false);
    expect(c.pending(T0 + 1001)).toEqual([]);
    expect(c.evaluate(T0 + 5000, calm({ lastFrameChangeAt: T0 })).kind).toBe("wait");
  });

  it("recordAsk removes the question from the queue", () => {
    const c = ready();
    c.recordAsk(c.pending()[0], NOW);
    expect(c.pending()).toEqual([]);
  });
});

describe("question source", () => {
  const ev = (over: Partial<PadawanEvent> = {}): PadawanEvent => ({
    id: 2, kind: "change", salient: true, confidence: 0.9, summary: "Cost center field changed from 4711 to 0400",
    entities: { field: "cost center", from: "4711", to: "0400" }, visible_text: [], ...over,
  });
  const res = (over: Partial<FrameResponse> = {}): FrameResponse => ({
    t_ms: 3000, screen_summary: "ERP open", events: [], question_candidates: [], step_update: null, latency_ms: 1, skipped: null, ...over,
  });

  it("reads strings and objects from question_candidates", () => {
    const out = candidatesFromResponse(res({ question_candidates: ["Why now?", { text: "Who approves?", priority: 8, id: "x" }, { nope: 1 }, "  "] }));
    expect(out.map((c) => [c.id, c.question, c.priority])).toEqual([["model-3000-0", "Why now?", 5], ["x", "Who approves?", 8]]);
  });

  it("uses the model's questions and only falls back to the stub when there are none", () => {
    const withModel = questionsForResponse(res({ events: [ev()], question_candidates: ["Why?"] }));
    expect(withModel.map((c) => c.source)).toEqual(["model"]);
    const stub = questionsForResponse(res({ events: [ev()] }));
    expect(stub).toEqual([{ id: "stub-2", question: "Why did you change cost center from 4711 to 0400?", priority: 3, source: "stub" }]);
  });

  it("the stub ignores events that are not salient", () => {
    expect(stubQuestionFromEvent(ev({ salient: false }))).toBeNull();
  });

  it("builds short single-line screen updates under 200 characters", () => {
    expect(screenUpdateText("  invoice 4471\nopen ")).toBe("Screen: invoice 4471 open");
    expect(screenUpdateText("x".repeat(500)).length).toBeLessThan(200);
    expect(screenUpdateText("   ")).toBe("");
  });

  it("throttles contextual updates to one every 2 s", () => {
    const t = new UpdateThrottle(2000);
    expect(t.take(0)).toBe(true);
    expect(t.take(1999)).toBe(false);
    expect(t.take(2000)).toBe(true);
  });
});
