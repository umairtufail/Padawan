import { describe, expect, it } from "vitest";

import { micShouldBeOpen } from "./use-agent-conversation";

describe("voice microphone policy", () => {
  it("keeps the mic open for the whole debrief and tutor conversation", () => {
    expect(micShouldBeOpen("debrief", false)).toBe(true);
    expect(micShouldBeOpen("tutor", false)).toBe(true);
  });

  it("opens capture only for an app-driven answer window", () => {
    expect(micShouldBeOpen("capture", false)).toBe(false);
    expect(micShouldBeOpen("capture", true)).toBe(true);
  });
});
