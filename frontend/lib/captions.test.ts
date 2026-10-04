import { describe, expect, it } from "vitest";
import { cleanCaption } from "./captions";

describe("cleanCaption", () => {
  it("removes audio tags", () => {
    expect(cleanCaption("[calm] Good. [calm] What are you checking, Padawan?")).toBe("Good. What are you checking, Padawan?");
    expect(cleanCaption("[sad] ...")).toBe("...");
  });
  it("keeps normal text, digits and brackets that are not tags", () => {
    expect(cleanCaption("Step [1] costs 4711.")).toBe("Step [1] costs 4711.");
    expect(cleanCaption("Plain.")).toBe("Plain.");
  });
});
