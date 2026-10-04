import { describe, expect, it } from "vitest";

import { micShouldBeOpen, micStartsOpen } from "./use-agent-conversation";

describe("voice microphone policy", () => {
  it("starts every mode muted so startup noise cannot trigger Yoda", () => {
    expect(micStartsOpen("capture")).toBe(false);
    expect(micStartsOpen("debrief")).toBe(false);
    expect(micStartsOpen("tutor")).toBe(false);
  });

  it("never opens while Yoda is speaking or before a completed Yoda turn", () => {
    expect(micShouldBeOpen("debrief", "speaking", true, false)).toBe(false);
    expect(micShouldBeOpen("tutor", "listening", false, false)).toBe(false);
  });

  it("opens conversational modes after Yoda finishes a turn", () => {
    expect(micShouldBeOpen("debrief", "listening", true, false)).toBe(true);
    expect(micShouldBeOpen("tutor", "listening", true, false)).toBe(true);
  });

  it("opens capture only for an app-driven answer window", () => {
    expect(micShouldBeOpen("capture", "listening", true, false)).toBe(false);
    expect(micShouldBeOpen("capture", "listening", true, true)).toBe(true);
  });
});
