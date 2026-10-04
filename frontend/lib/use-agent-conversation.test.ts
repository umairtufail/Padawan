import { describe, expect, it } from "vitest";

import { micStartsOpen } from "./use-agent-conversation";

describe("voice microphone policy", () => {
  it("starts capture muted so narration cannot trigger Yoda", () => {
    expect(micStartsOpen("capture")).toBe(false);
  });

  it("keeps conversational modes open", () => {
    expect(micStartsOpen("debrief")).toBe(true);
    expect(micStartsOpen("tutor")).toBe(true);
  });
});
