import { describe, expect, it } from "vitest";
import { applyVerdict, initialLearnState } from "./learn";
import { buildReport, judgePrediction, newMockLearn, recordVerdict, scriptedVerdict } from "./learn-mock";
import { seedSkills } from "./skills-mock";

const skill = seedSkills().find((s) => s.id === "skill-invoices")!;

describe("scripted verdicts", () => {
  it("runs ok, ok, warn, STOP (kept through unchecked frames), cleared, then moves on, through the real reducer", () => {
    const m = newMockLearn(skill);
    let state = initialLearnState(m.currentIdx);
    const kinds: (string | null)[] = [];
    for (let f = 1; f <= 9; f++) {
      const v = scriptedVerdict(m, f);
      recordVerdict(m, v, f * 4000);
      state = applyVerdict(state, v).state;
      kinds.push(state.banner?.kind ?? null);
    }
    expect(kinds).toEqual([null, null, "warn", "stop", "stop", "stop", null, null, null]);
    expect(state.stops).toEqual({ 3: 1 });
    expect(state.stepIdx).toBeGreaterThan(3);
  });

  it("the stop carries the guardrail, the reason and the Master's moment", () => {
    const v = scriptedVerdict(newMockLearn(skill), 4);
    expect(v.verdict).toBe("stop");
    expect(v.guardrail_id).toBe("g3");
    expect(v.replay?.t_ms).toBe(192_000);
    expect(v.reason).toMatch(/^Wait\./);
  });
});

describe("judgePrediction", () => {
  it("is right when half of the Master's key words are present", () => {
    expect(judgePrediction("coded to capex 0400 not opex", "Re-coded from opex 4711 to capex 0400")).toBe(true);
    expect(judgePrediction("skip the check", "Re-coded from opex 4711 to capex 0400")).toBe(false);
  });
});

describe("buildReport", () => {
  it("scores like the backend: safety and prediction averaged, unreached steps count zero", () => {
    const m = newMockLearn(skill);
    for (let f = 1; f <= 7; f++) recordVerdict(m, scriptedVerdict(m, f), f * 4000);
    m.predictions.set(3, { predicted: "opex 4711", correct: false });
    const r = buildReport(m, "sid", "sum");
    const s3 = r.steps.find((s) => s.step_idx === 3)!;
    expect(s3.interventions).toBe(1);
    expect(s3.score).toBe(0.25); // (1 - 0.5 safety + 0 prediction) / 2
    expect(s3.result).toBe("practise");
    expect(r.steps.find((s) => s.step_idx === 2)!.warnings).toBe(1);
    expect(r.steps.find((s) => s.step_idx === 5)!.result).toBe("not_reached");
    expect(r.practise_next.some((p) => p.step_idx === 3)).toBe(true);
    expect(r.interventions_total).toBe(1);
    expect(r.predictions_total).toBe(1);
    expect(r.mastery_score).toBeGreaterThan(0);
    expect(r.mastery_score).toBeLessThan(100);
  });

  it("gives 100 when everything was reached cleanly", () => {
    const m = newMockLearn(skill);
    skill.steps.forEach((s) => m.reached.add(s.idx));
    expect(buildReport(m, "sid", "").mastery_score).toBe(100);
  });
});
