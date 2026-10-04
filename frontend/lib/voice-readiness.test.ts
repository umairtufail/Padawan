import { describe, expect, it } from "vitest";

import { classifyMicPeak, MIN_USABLE_MIC_RMS } from "./voice-readiness";

describe("voice readiness", () => {
  it("requires a meaningful microphone signal", () => {
    expect(classifyMicPeak(0)).toBe("quiet");
    expect(classifyMicPeak(MIN_USABLE_MIC_RMS - 0.0001)).toBe("quiet");
    expect(classifyMicPeak(MIN_USABLE_MIC_RMS)).toBe("good");
    expect(classifyMicPeak(0.1)).toBe("good");
  });
});
