import { describe, expect, it } from "vitest";
import {
  buildTeachbackSummary, debriefReady, debriefTimeMs, gapsContext, parseCorrections, questionTypeForGap, requiredAnswers,
  resolveGapId, sortGaps,
} from "./debrief";
import type { Gap, StepDraft } from "./pipeline-types";

const gap = (id: string, priority: number, over: Partial<Gap> = {}): Gap => ({
  id, type: "missing_reason", text: `Question ${id}?`, step_idx: 1, anchor_event_id: null, priority, ...over,
});
const step = (idx: number, title: string, t_end_ms: number | null = null): StepDraft => ({
  idx, title, t_start_ms: null, t_end_ms, event_ids: [], question_ids: [], status: "closed",
});

describe("gaps", () => {
  it("sorts by priority, best first", () => {
    expect(sortGaps([gap("a", 0.2), gap("b", 0.9), gap("c", 0.5)]).map((g) => g.id)).toEqual(["b", "c", "a"]);
  });
  it("maps gap types to question types", () => {
    expect(questionTypeForGap("missing_guardrail")).toBe("guardrail");
    expect(questionTypeForGap("unseen_case")).toBe("exception");
    expect(questionTypeForGap("unclear_term")).toBe("reason");
  });
  it("needs 3 answers, or all of them when there are fewer", () => {
    const five = ["a", "b", "c", "d", "e"].map((id, i) => gap(id, i));
    expect(requiredAnswers(five)).toBe(3);
    expect(requiredAnswers([gap("a", 1), gap("b", 1)])).toBe(2);
    expect(requiredAnswers([])).toBe(0);
    expect(debriefReady(five, new Set(["a", "b"]))).toBe(false);
    expect(debriefReady(five, new Set(["a", "b", "e"]))).toBe(true);
    expect(debriefReady([], new Set())).toBe(true);
  });
  it("does not count answers for gaps that are not in the list", () => {
    expect(debriefReady([gap("a", 1), gap("b", 1), gap("c", 1)], new Set(["x", "y", "z"]))).toBe(false);
  });
});

describe("resolveGapId", () => {
  const gaps = [gap("g1", 0.9), gap("g2", 0.8), gap("g3", 0.7)];
  it("uses the id the agent named when that gap is still open", () => {
    expect(resolveGapId("g2", gaps, new Set(), null)).toBe("g2");
  });
  it("falls back to the gap we asked last, then to the best open one", () => {
    expect(resolveGapId("nope", gaps, new Set(), "g3")).toBe("g3");
    expect(resolveGapId(undefined, gaps, new Set(["g1"]), null)).toBe("g2");
  });
  it("ignores answered gaps and returns null when all are closed", () => {
    expect(resolveGapId("g1", gaps, new Set(["g1"]), "g1")).toBe("g2");
    expect(resolveGapId("g1", gaps, new Set(["g1", "g2", "g3"]), null)).toBeNull();
  });
});

describe("gapsContext", () => {
  it("lists the gaps in priority order with their ids, capped", () => {
    const text = gapsContext([gap("g1", 0.1), gap("g2", 0.9)], 1);
    expect(text).toContain("1. [g2] Question g2?");
    expect(text).not.toContain("g1");
    expect(gapsContext([])).toBe("");
  });
});

describe("buildTeachbackSummary", () => {
  it("explains every step in order and adds the reasons and limits the Master gave", () => {
    const steps = [step(2, "Post the invoice."), step(1, "Code the invoice")];
    const gaps = [
      { gap: gap("g1", 1, { step_idx: 1, type: "missing_reason" }), summary: "Equipment over 5000 is capex." },
      { gap: gap("g2", 1, { step_idx: 1, type: "missing_guardrail" }), summary: "No asset number: stop and ask" },
    ];
    const text = buildTeachbackSummary(steps, gaps);
    expect(text.indexOf("Step 1")).toBeLessThan(text.indexOf("Step 2"));
    expect(text).toContain("Step 1: Code the invoice. Why: Equipment over 5000 is capex. Limit: No asset number: stop and ask.");
    expect(text).toContain("Step 2: Post the invoice.");
    expect(text.endsWith("Is that how it works?")).toBe(true);
  });
  it("says so when there is nothing to explain", () => {
    expect(buildTeachbackSummary([])).toMatch(/nothing/);
  });
});

describe("parseCorrections", () => {
  it("splits lines, strips bullets and blanks", () => {
    expect(parseCorrections("- Hold applies in December\n\n  2) Ask the controller \n")).toEqual(["Hold applies in December", "Ask the controller"]);
  });
  it("accepts an array and undefined, and caps at 50", () => {
    expect(parseCorrections([" a ", ""])).toEqual(["a"]);
    expect(parseCorrections(undefined)).toEqual([]);
    expect(parseCorrections(Array.from({ length: 80 }, (_, i) => `c${i}`))).toHaveLength(50);
  });
});

describe("debriefTimeMs", () => {
  it("continues the session clock after the last step", () => {
    expect(debriefTimeMs([step(1, "a", 9000), step(2, "b", 20000), step(3, "c")], 1000, 4500)).toBe(23500);
    expect(debriefTimeMs([], 1000, 500)).toBe(0);
  });
});
