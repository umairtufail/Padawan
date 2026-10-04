import { describe, expect, it } from "vitest";
import {
  askedBody, expertLinesSince, isUuid, newUuid, pickAnswerQuote, questionIdFor, resolveQuestionId, speakerFor, UtteranceQueue,
} from "./capture-sync";

const line = (text: string, t_ms = 0, speaker: "expert" | "agent" = "expert") => ({ t_ms, speaker, text });

describe("question ids", () => {
  it("recognises UUIDs", () => {
    expect(isUuid(newUuid())).toBe(true);
    expect(isUuid("stub-3")).toBe(false);
    expect(isUuid("manual-1700000000000")).toBe(false);
  });
  it("keeps a UUID candidate id and makes a fresh UUID for stub and manual questions", () => {
    const real = "0b3cc50a-1111-4222-8333-444455556666";
    expect(questionIdFor(real, () => "x")).toBe(real);
    expect(questionIdFor("stub-3", () => "generated")).toBe("generated");
  });
});

describe("askedBody", () => {
  it("builds the asked body with the why-now trace", () => {
    const body = askedBody(
      { question: "Why 0400?", type: "reason", anchorEventId: 42 },
      { askedAtMs: 19500.4, phase: "live", manual: false, checks: [{ id: "screen_idle", ok: true, detail: "idle 2.1s" }] },
    );
    expect(body).toEqual({
      type: "reason", text: "Why 0400?", anchor_event_id: 42, asked_at_ms: 19500, phase: "live",
      why_now: { manual: false, checks: [{ id: "screen_idle", ok: true, detail: "idle 2.1s" }] },
    });
  });
  it("defaults the type, keeps text within the limit and never sends a negative time", () => {
    const body = askedBody({ question: "x".repeat(900) }, { askedAtMs: -5, phase: "debrief", manual: true });
    expect(body.type).toBe("reason");
    expect(body.text).toHaveLength(500);
    expect(body.asked_at_ms).toBe(0);
    expect(body.anchor_event_id).toBeNull();
    expect(body.phase).toBe("debrief");
  });
});

describe("answers", () => {
  const caps = [
    { who: "expert" as const, text: "old talk", at: 100 },
    { who: "yoda" as const, text: "Why 0400?", at: 1000 },
    { who: "expert" as const, text: " Equipment over five thousand ", at: 1500 },
    { who: "expert" as const, text: "is always capex.", at: 2500 },
  ];
  it("collects the expert's lines since the question was asked", () => {
    expect(expertLinesSince(caps, 1000)).toEqual(["Equipment over five thousand", "is always capex."]);
  });
  it("uses the spoken words as the quote, else the summary, else a placeholder", () => {
    expect(pickAnswerQuote(caps, 1000, "summary")).toBe("Equipment over five thousand is always capex.");
    expect(pickAnswerQuote(caps, 5000, " capex rule ")).toBe("capex rule");
    expect(pickAnswerQuote(caps, 5000, "")).toBe("(answered aloud)");
    expect(pickAnswerQuote(caps, 0, "", 10)).toHaveLength(10);
  });
  it("reports an answer against the id the agent named if we asked it, else the open question", () => {
    const known = new Set(["a", "b"]);
    expect(resolveQuestionId("b", known, "a")).toBe("b");
    expect(resolveQuestionId("unknown", known, "a")).toBe("a");
    expect(resolveQuestionId(undefined, known, null)).toBeNull();
  });
  it("maps captions to speakers", () => {
    expect(speakerFor("yoda")).toBe("agent");
    expect(speakerFor("expert")).toBe("expert");
  });
});

describe("UtteranceQueue", () => {
  it("drops blank lines, trims, rounds and caps the text", () => {
    const q = new UtteranceQueue();
    q.add(line("   "));
    q.add(line("  hello  ", 1234.7));
    q.add(line("y".repeat(5000)));
    expect(q.size).toBe(2);
    const [a, b] = q.take();
    expect(a).toEqual({ t_ms: 1235, speaker: "expert", text: "hello" });
    expect(b.text).toHaveLength(4000);
    expect(q.size).toBe(0);
  });
  it("sends batches of at most 200 and puts a failed batch back in front", () => {
    const q = new UtteranceQueue(2);
    ["a", "b", "c"].forEach((t) => q.add(line(t)));
    const first = q.take();
    expect(first.map((l) => l.text)).toEqual(["a", "b"]);
    q.putBack(first);
    expect(q.take().map((l) => l.text)).toEqual(["a", "b"]);
    expect(q.take().map((l) => l.text)).toEqual(["c"]);
  });
  it("suppresses a line stored another way, waiting or not yet arrived", () => {
    const q = new UtteranceQueue();
    q.add(line("waiting"));
    q.suppress("waiting");
    expect(q.size).toBe(0);
    q.suppress("later");
    q.add(line("later"));
    q.add(line("later")); // a second, genuinely new line with the same text is kept
    expect(q.size).toBe(1);
  });
  it("does not suppress the agent's lines", () => {
    const q = new UtteranceQueue();
    q.suppress("Why?");
    q.add(line("Why?", 0, "agent"));
    expect(q.size).toBe(1);
  });
});
