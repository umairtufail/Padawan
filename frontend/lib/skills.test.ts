import { describe, expect, it } from "vitest";
import {
  buildWorkMap, countGuardrails, domainOptions, filterByDomain, filterSkills, formatTimestamp, learnersLabel, masteryLabel,
  skillToMarkdown, slugify, sortSkills,
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

function row(id: string, over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id, title: id, description: "", domain: null, language: "en", status: "published", author: { id: "a", name: "A" },
    steps_count: 1, guardrails_count: 0, created_at: "2026-01-01T00:00:00Z", published_at: null, learners_count: 0, avg_mastery: null, ...over,
  };
}

describe("marketplace helpers", () => {
  const a = row("a", { published_at: "2026-03-01T00:00:00Z", learners_count: 2, avg_mastery: 60, domain: "Finance" });
  const b = row("b", { published_at: "2026-02-01T00:00:00Z", learners_count: 9, avg_mastery: null, domain: "Finance" });
  const c = row("c", { published_at: "2026-01-15T00:00:00Z", learners_count: 2, avg_mastery: 90, domain: "Procurement" });
  const d = row("d", { created_at: "2026-04-01T00:00:00Z", domain: " " });
  const ids = (l: SkillSummary[]) => l.map((x) => x.id).join("");

  it("sorts newest by published_at, falling back to created_at", () => {
    expect(ids(sortSkills([a, b, c, d], "newest"))).toBe("dabc");
  });
  it("sorts popular by learners, ties by mastery then newest", () => {
    expect(ids(sortSkills([a, b, c, d], "popular"))).toBe("bcad");
  });
  it("sorts by mastery with null last", () => {
    expect(ids(sortSkills([a, b, c, d], "mastery"))).toBe("cabd");
  });
  it("does not mutate its input", () => {
    const input = [a, b, c];
    sortSkills(input, "popular");
    expect(ids(input)).toBe("abc");
  });
  it("builds domain options biggest first and skips blanks", () => {
    expect(domainOptions([a, b, c, d])).toEqual([{ domain: "Finance", count: 2 }, { domain: "Procurement", count: 1 }]);
    expect(domainOptions([])).toEqual([]);
  });
  it("filters by domain; null means all", () => {
    expect(ids(filterByDomain([a, b, c], "Finance"))).toBe("ab");
    expect(ids(filterByDomain([a, b, c], null))).toBe("abc");
    expect(filterByDomain([a, b, c], "Nope")).toEqual([]);
  });
  it("labels learners and hides zero", () => {
    expect(learnersLabel(0)).toBeNull();
    expect(learnersLabel(undefined)).toBeNull();
    expect(learnersLabel(1)).toBe("1 learner");
    expect(learnersLabel(12)).toBe("12 learners");
  });
  it("labels mastery and hides null or zero", () => {
    expect(masteryLabel(null)).toBeNull();
    expect(masteryLabel(0)).toBeNull();
    expect(masteryLabel(71.6)).toBe("72% avg mastery");
    expect(masteryLabel(140)).toBe("100% avg mastery");
  });
});

describe("filterSkills", () => {
  const mk = (title: string, name: string, domain: string | null): SkillSummary => ({
    id: title, title, description: "desc", domain, language: "en", status: "published",
    author: { id: name, name }, steps_count: 1, guardrails_count: 0, created_at: "", published_at: null,
    learners_count: 0, avg_mastery: null,
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
