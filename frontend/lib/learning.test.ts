import { describe, expect, it } from "vitest";
import { learningStats, pickContinue, progressLabel, progressPercent, sortSessions, type LearnSessionRow } from "./learning";

const row = (id: string, over: Partial<LearnSessionRow> = {}): LearnSessionRow => ({
  session_id: id, skill_id: `s-${id}`, skill_title: id, created_at: "2026-01-01T00:00:00Z", finished: false,
  mastery_score: null, steps_total: 4, steps_done: 1, ...over,
});

describe("learning helpers", () => {
  const a = row("a", { created_at: "2026-03-01T00:00:00Z", finished: true, mastery_score: 80, steps_done: 4 });
  const b = row("b", { created_at: "2026-03-05T00:00:00Z" });
  const c = row("c", { created_at: "2026-03-03T00:00:00Z" });

  it("sorts newest first without mutating", () => {
    const input = [a, b, c];
    expect(sortSessions(input).map((r) => r.session_id)).toEqual(["b", "c", "a"]);
    expect(input.map((r) => r.session_id)).toEqual(["a", "b", "c"]);
  });
  it("computes a safe progress percentage", () => {
    expect(progressPercent({ steps_done: 1, steps_total: 4 })).toBe(25);
    expect(progressPercent({ steps_done: 9, steps_total: 4 })).toBe(100);
    expect(progressPercent({ steps_done: 1, steps_total: 0 })).toBe(0);
  });
  it("labels progress and clamps", () => {
    expect(progressLabel({ steps_done: 2, steps_total: 5 })).toBe("2 of 5 steps");
    expect(progressLabel({ steps_done: 7, steps_total: 5 })).toBe("5 of 5 steps");
  });
  it("picks the newest unfinished session to continue", () => {
    expect(pickContinue([a, b, c])?.session_id).toBe("b");
    expect(pickContinue([a])).toBeNull();
    expect(pickContinue([row("gone", { skill_id: null, created_at: "2026-04-01T00:00:00Z" }), c])?.session_id).toBe("c");
    expect(pickContinue([])).toBeNull();
  });
  it("summarises the rows", () => {
    expect(learningStats([a, b, c])).toEqual({ total: 3, finished: 1, inProgress: 2, avgMastery: 80 });
    expect(learningStats([]).avgMastery).toBeNull();
  });
});
