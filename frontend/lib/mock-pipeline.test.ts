import { describe, expect, it } from "vitest";
import { findGaps, segmentEvents, synthesizeMockSkill, type MockEvent, type MockQuestion } from "./mock-pipeline";

const ev = (id: number, salient: boolean, t_ms = id * 1000): MockEvent => ({ id, summary: `Event ${id} happened.`, salient, t_ms });
const events = [ev(1, false), ev(2, true), ev(3, false), ev(4, true), ev(5, false)];

describe("segmentEvents", () => {
  it("closes a step after each salient event and leaves the tail open", () => {
    const steps = segmentEvents(events, [], false);
    expect(steps.map((s) => [s.idx, s.event_ids, s.status])).toEqual([
      [1, [1, 2], "closed"], [2, [3, 4], "closed"], [3, [5], "open"],
    ]);
    expect(steps[0]).toMatchObject({ title: "Event 2 happened", t_start_ms: 1000, t_end_ms: 2000 });
  });
  it("closes everything on finish and handles no events", () => {
    expect(segmentEvents(events, [], true).every((s) => s.status === "closed")).toBe(true);
    expect(segmentEvents([], [], true)).toEqual([]);
  });
  it("attaches live questions to the step of their anchor event", () => {
    const q: MockQuestion = { id: "q1", type: "reason", text: "Why?", anchor_event_id: 4, phase: "live", answered: true };
    expect(segmentEvents(events, [q], true)[1].question_ids).toEqual(["q1"]);
  });
});

describe("findGaps", () => {
  it("asks for the missing reason and limit of each step, sorted, at least 3 and at most 12", () => {
    const steps = segmentEvents(events, [], true);
    const gaps = findGaps(steps, events);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps.length).toBeLessThanOrEqual(12);
    expect(gaps.map((g) => g.priority)).toEqual([...gaps.map((g) => g.priority)].sort((a, b) => b - a));
    expect(gaps.some((g) => g.type === "missing_reason" && g.step_idx === 1)).toBe(true);
    expect(gaps.some((g) => g.type === "missing_guardrail" && g.anchor_event_id === 2)).toBe(true);
    expect(new Set(gaps.map((g) => g.id)).size).toBe(gaps.length);
  });
  it("does not ask for a reason that was already given live", () => {
    const q: MockQuestion = { id: "q1", type: "reason", text: "Why?", anchor_event_id: 2, phase: "live", answered: true };
    const steps = segmentEvents(events, [q], true);
    expect(findGaps(steps, events).some((g) => g.type === "missing_reason" && g.step_idx === 1)).toBe(false);
  });
});

describe("synthesizeMockSkill", () => {
  const q = (id: string, type: string, anchor: number): MockQuestion => ({ id, type, text: "?", anchor_event_id: anchor, phase: "live", answered: true });
  const questions = [q("q1", "reason", 2), q("q2", "guardrail", 4)];
  const answers = [
    { question_id: "q1", quote: "Equipment over five thousand is capex", summary: "Equipment over 5000 is capex" },
    { question_id: "q2", quote: "I stop and ask the controller", summary: "Stop and ask the controller" },
  ];
  const steps = segmentEvents(events, questions, true);
  const skill = synthesizeMockSkill({
    id: "s1", title: "Invoices", author: { id: "admin", name: "Admin" }, steps, events, questions, answers,
    corrections: ["Hold in December"], now: "2026-10-04T10:00:00Z",
  });

  it("makes a step per detected step with null reasons where the Master gave none", () => {
    expect(skill.steps).toHaveLength(3);
    expect(skill.steps[0].reason?.quote).toBe("Equipment over five thousand is capex");
    expect(skill.steps[1].reason).toBeNull();
    expect(skill.steps[2].reason).toBeNull();
    expect(skill.steps[2].decision.type).toBe("routine");
    expect(skill.steps[2].predict_prompt).toBeNull();
    expect(skill.steps[0].predict_prompt).not.toBeNull();
  });
  it("turns guardrail answers into guardrails and corrections into teach-back guardrails, with unique ids", () => {
    expect(skill.steps[1].guardrails).toHaveLength(1);
    expect(skill.steps[1].guardrails[0]).toMatchObject({ type: "stop_and_ask", source: "expert", quote: "I stop and ask the controller" });
    expect(skill.global_guardrails[0]).toMatchObject({ rule: "Hold in December", source: "teachback", quote: "", t_ms: null });
    const ids = [...skill.steps.flatMap((s) => s.guardrails), ...skill.global_guardrails].map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(skill.teachback).toEqual({ confirmed: true, corrections: ["Hold in December"] });
  });
});
