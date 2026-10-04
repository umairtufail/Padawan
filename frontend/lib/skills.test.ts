import { describe, expect, it } from "vitest";
import {
  buildWorkMap, countGuardrails, filterSkills, formatTimestamp, skillToMarkdown, slugify,
  type SkillJson, type SkillSummary,
} from "./skills";

const g = (id: string, type = "limit") => ({ id, type, rule: `rule ${id}`, quote: "q", t_ms: 1 as number | null, source: "expert" as const });
const step = (idx: number, type: string, guardrails = [] as ReturnType<typeof g>[]) => ({
  idx, title: `Step ${idx}`,
  screen_moment: { t_ms: idx * 1000, keyframe_path: null, description: "moment" },
  decision: { type, summary: "did a thing" },
  reason: { text: "because", quote: "because I said", t_ms: 1 },
  guardrails,
  predict_prompt: null,
});
const skill: SkillJson = {
  id: "s1", title: "Process Supplier Invoices!", description: "How to\nprocess  invoices.",
  author: { id: "a", name: "Sabine" }, created_at: "2026-10-03T18:00:00Z", language: "en",
  steps: [step(2, "judgment", [g("g1"), g("g2", "stop_and_ask")]), step(1, "routine")],
  global_guardrails: [g("gg")],
  teachback: { confirmed: true, corrections: [] },
};

describe("formatTimestamp", () => {
  it("formats minutes and hours", () => {
    expect(formatTimestamp(192000)).toBe("3:12");
    expect(formatTimestamp(5000)).toBe("0:05");
    expect(formatTimestamp(3_723_000)).toBe("1:02:03");
  });
  it("is safe on bad input", () => {
    expect(formatTimestamp(-5)).toBe("0:00");
    expect(formatTimestamp(NaN)).toBe("0:00");
  });
});

describe("filterSkills", () => {
  const mk = (title: string, name: string, domain: string | null): SkillSummary => ({
    id: title, title, description: "desc", domain, language: "en", status: "published",
    author: { id: name, name }, steps_count: 1, guardrails_count: 0, created_at: "", published_at: null,
  });
  const list = [mk("Invoices", "Sabine", "finance"), mk("Vendor onboarding", "Marc", "procurement")];
  it("returns all for an empty query", () => expect(filterSkills(list, "  ")).toHaveLength(2));
  it("matches every word across fields", () => {
    expect(filterSkills(list, "sabine FINANCE").map((s) => s.id)).toEqual(["Invoices"]);
    expect(filterSkills(list, "invoices marc")).toHaveLength(0);
  });
});

describe("buildWorkMap", () => {
  it("sorts by idx and carries guardrails", () => {
    const map = buildWorkMap(skill);
    expect(map.map((n) => n.idx)).toEqual([1, 2]);
    expect(map[1].guardrails).toHaveLength(2);
    expect(map[0].emphasis).toBe(false);
    expect(map[1].emphasis).toBe(true);
  });
});

describe("counting and export", () => {
  it("counts step and global guardrails", () => expect(countGuardrails(skill)).toBe(3));
  it("slugifies", () => {
    expect(slugify("Process Supplier Invoices!")).toBe("process-supplier-invoices");
    expect(slugify("!!!")).toBe("holocron");
  });
  it("renders a step without a reason honestly", () => {
    const s = { ...skill, steps: [{ ...step(1, "routine"), reason: null }] };
    expect(skillToMarkdown(s)).toContain("- Why: not given by the expert");
  });
  it("renders SKILL.md in step order", () => {
    const md = skillToMarkdown(skill);
    expect(md.startsWith("---\nname: process-supplier-invoices\ndescription: How to process invoices.\nauthor: Sabine\ncreated: 2026-10-03\n---\n# Steps")).toBe(true);
    expect(md.indexOf("## 1.")).toBeLessThan(md.indexOf("## 2."));
    expect(md).toContain("- Stop and ask: rule g2");
    expect(md).toContain("# Global guardrails");
  });
});
