import { describe, expect, it } from "vitest";
import {
  applyVerdict, formatDuration, initialLearnState, interventionMessage, predictionLabel, predictionSentence, replayForStep,
  scoreTitle, scoreTone, stripWait, shouldAnnounceStep, stepMessage, stepStatus, warnMessage,
  type GuardrailVerdict, type PredictionResult,
} from "./learn";
import type { SkillStep } from "./skills";

const verdict = (over: Partial<GuardrailVerdict> = {}): GuardrailVerdict => ({
  verdict: "ok", checked: true, step_idx: 1, step_title: "Code the invoice", guardrail_id: null, rule: "", expert_quote: "",
  reason: "", confidence: 0.9, committed: false, repeated: false, degraded: false, replay: null, ...over,
});
const stop = (over: Partial<GuardrailVerdict> = {}) =>
  verdict({ verdict: "stop", guardrail_id: "g2", rule: "Never 4711", reason: "Wait. It is capex.", expert_quote: "never to 4711", ...over });

describe("applyVerdict", () => {
  it("ignores a skipped frame (null) and degraded verdicts silently", () => {
    const s = initialLearnState(1);
    expect(applyVerdict(s, null)).toEqual({ state: s, effect: null });
    const stopped = applyVerdict(s, stop()).state;
    const out = applyVerdict(stopped, verdict({ degraded: true, step_idx: 3 }));
    expect(out.state).toBe(stopped);
    expect(out.effect).toBeNull();
  });

  it("shows a stop, counts it and asks for speech", () => {
    const out = applyVerdict(initialLearnState(1), stop());
    expect(out.state.banner?.kind).toBe("stop");
    expect(out.state.stops).toEqual({ 1: 1 });
    expect(out.effect?.type).toBe("stop");
  });

  it("shows a warn softly and counts it", () => {
    const out = applyVerdict(initialLearnState(1), verdict({ verdict: "warn", reason: "check the amount" }));
    expect(out.state.banner?.kind).toBe("warn");
    expect(out.state.warns).toEqual({ 1: 1 });
    expect(out.effect?.type).toBe("warn");
  });

  it("keeps the banner on a repeated verdict but does not speak or count again", () => {
    const first = applyVerdict(initialLearnState(1), stop()).state;
    const out = applyVerdict(first, stop({ repeated: true }));
    expect(out.effect).toBeNull();
    expect(out.state.stops).toEqual({ 1: 1 });
    expect(out.state.banner?.kind).toBe("stop");
  });

  it("does not clear a stop on an unchecked ok, but clears it on a checked ok", () => {
    const first = applyVerdict(initialLearnState(1), stop()).state;
    expect(applyVerdict(first, verdict({ checked: false })).state.banner?.kind).toBe("stop");
    expect(applyVerdict(first, verdict()).state.banner).toBeNull();
  });

  it("does not downgrade a visible stop to a warn", () => {
    const first = applyVerdict(initialLearnState(1), stop()).state;
    const out = applyVerdict(first, verdict({ verdict: "warn" }));
    expect(out.state.banner?.kind).toBe("stop");
    expect(out.state.warns).toEqual({ 1: 1 });
  });

  it("moves the step marker with step_idx, even on unchecked verdicts", () => {
    expect(applyVerdict(initialLearnState(1), verdict({ step_idx: 3, checked: false })).state.stepIdx).toBe(3);
    expect(applyVerdict(initialLearnState(2), verdict({ step_idx: null })).state.stepIdx).toBe(2);
  });
});

describe("stripWait", () => {
  it("drops a leading Wait so the banner does not say it twice", () => {
    expect(stripWait("Wait. Equipment is capex.")).toBe("Equipment is capex.");
    expect(stripWait("Stop. It is capex.")).toBe("It is capex.");
    expect(stripWait("It is capex.")).toBe("It is capex.");
  });
});

describe("messages for Yoda", () => {
  it("builds the [INTERVENE] and [WARN] messages from the docs", () => {
    expect(interventionMessage(stop())).toBe("[INTERVENE] step 1, guardrail g2: Never 4711. Wait. It is capex.");
    expect(warnMessage(verdict({ verdict: "warn", guardrail_id: "g1", rule: "Check", reason: "Slow down." }))).toBe("[WARN] step 1, guardrail g1: Check. Slow down.");
  });
  it("asks Yoda to teach a step and ask for a prediction", () => {
    const m = stepMessage({ idx: 2, title: "Check supplier" }, true);
    expect(m.startsWith("[START]")).toBe(true);
    expect(m).toContain("step 2: Check supplier");
    expect(stepMessage({ idx: 3, title: "x" }, false).startsWith("[STEP]")).toBe(true);
  });
  it("announces a step only when it changed", () => {
    expect(shouldAnnounceStep(null, 1)).toBe(true);
    expect(shouldAnnounceStep(1, 1)).toBe(false);
    expect(shouldAnnounceStep(1, 2)).toBe(true);
    expect(shouldAnnounceStep(null, 0)).toBe(false);
  });
});

describe("predictions and replay", () => {
  const result: PredictionResult = {
    step_idx: 1, predicted: "capex", correct: true, judged_by: "model", expected: "cost center 0400", reason: "capex",
    reason_quote: "always capex", replay: { step_idx: 1, t_ms: 5000, description: "field", keyframe_path: null },
  };
  it("tells Yoda whether the prediction was right", () => {
    expect(predictionSentence(result)).toBe('Right. The Master decided: cost center 0400. The Master said: "always capex"');
    expect(predictionSentence({ ...result, correct: false, reason_quote: null }).startsWith("Not quite.")).toBe(true);
  });
  const step = (idx: number): SkillStep => ({
    idx, title: `S${idx}`, screen_moment: { t_ms: idx * 1000, keyframe_path: null, description: "moment" }, decision: { type: "routine", summary: "d" },
    reason: { text: "t", quote: "q", t_ms: 1 }, guardrails: [], predict_prompt: null,
  });
  it("finds the Master's moment for a step", () => {
    expect(replayForStep({ steps: [step(1), step(2)] }, 2)?.moment).toEqual({ step_idx: 2, t_ms: 2000, description: "moment", keyframe_path: null });
    expect(replayForStep({ steps: [step(1)] }, 9)).toBeNull();
  });
  it("labels steps relative to the current one", () => {
    expect(stepStatus({ idx: 1 }, 2)).toBe("done");
    expect(stepStatus({ idx: 2 }, 2)).toBe("current");
    expect(stepStatus({ idx: 3 }, 2)).toBe("todo");
  });
});

describe("report helpers", () => {
  it("formats durations", () => {
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(0)).toBe("-");
    expect(formatDuration(null)).toBe("-");
  });
  it("bands the score at the backend's mastered cut", () => {
    expect(scoreTone(75)).toBe("jade");
    expect(scoreTone(74)).toBe("gold");
    expect(scoreTone(10)).toBe("danger");
    expect(scoreTitle(80)).toMatch(/mastered/);
  });
  it("describes the prediction of a step", () => {
    expect(predictionLabel({ predicted: null, predicted_right: null })).toBe("No prediction");
    expect(predictionLabel({ predicted: "x", predicted_right: true })).toBe("Predicted right");
    expect(predictionLabel({ predicted: "x", predicted_right: false })).toBe("Predicted wrong");
  });
});
