import { describe, expect, it } from "vitest";
import { curiosityQuestion } from "./question-source";

describe("curiosityQuestion", () => {
  it("rotates through different questions and wraps around", () => {
    const seen = new Set(Array.from({ length: 6 }, (_, i) => curiosityQuestion(i)));
    expect(seen.size).toBe(6);
    expect(curiosityQuestion(6)).toBe(curiosityQuestion(0));
  });
});
