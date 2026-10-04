/**
 * Skill ("Holocron") types and pure helpers. The JSON follows the contract in Notion page 03
 * (Data Model and Skill Schema). No network or browser code here so it stays easy to test.
 */

export type SkillStatus = "draft" | "published";

export type SkillGuardrail = {
  id: string;
  type: string; // limit | exception | stop_and_ask
  rule: string;
  /** Verbatim from the transcript. Empty when the guardrail came from the teach-back. */
  quote: string;
  /** null for teach-back guardrails. */
  t_ms: number | null;
  source: "expert" | "teachback";
};

export type SkillReason = { text: string; quote: string; t_ms: number };

export type SkillStep = {
  idx: number;
  title: string;
  screen_moment: { t_ms: number; keyframe_path: string | null; description: string };
  decision: { type: string; summary: string }; // routine | judgment
  /** null when the expert never gave a reason (the backend never invents one). */
  reason: SkillReason | null;
  guardrails: SkillGuardrail[];
  /** Set only on judgment steps. */
  predict_prompt: string | null;
};

/** The skill JSON from the contract (Notion page 03). */
export type SkillJson = {
  id: string;
  title: string;
  description: string;
  /** One paragraph written by the model: what the Master showed and why. Missing on older skills. */
  summary?: string;
  author: { id: string; name: string };
  created_at: string;
  language: string;
  steps: SkillStep[];
  global_guardrails: SkillGuardrail[];
  teachback: { confirmed: boolean; corrections: string[] };
};

/** One row of GET /v1/skills. */
export type SkillSummary = {
  id: string;
  title: string;
  description: string;
  /** One paragraph: what the Master showed and why ("" for skills made before summaries existed). */
  summary: string;
  domain: string | null;
  language: string;
  status: SkillStatus;
  author: { id: string; name: string };
  steps_count: number;
  guardrails_count: number;
  created_at: string;
  published_at: string | null;
  /** How many learn sessions started on this skill. Only a count: who learned it is never exposed. */
  learners_count: number;
  /** Average mastery score (0 to 100) of finished lessons, null while nobody has finished one. */
  avg_mastery: number | null;
};

/** GET /v1/skills/{id}: the summary plus the skill JSON (null if it was never synthesized) and the SKILL.md. */
export type SkillDetail = SkillSummary & {
  skill: SkillJson | null;
  skill_md: string | null;
};

export function countGuardrails(skill: Pick<SkillJson, "steps" | "global_guardrails">): number {
  return skill.steps.reduce((n, s) => n + s.guardrails.length, 0) + skill.global_guardrails.length;
}

export function toSummary(d: SkillDetail): SkillSummary {
  return {
    id: d.id, title: d.title, description: d.description, summary: d.summary, domain: d.domain, language: d.language,
    status: d.status, author: d.author, steps_count: d.steps_count, guardrails_count: d.guardrails_count,
    created_at: d.created_at, published_at: d.published_at, learners_count: d.learners_count, avg_mastery: d.avg_mastery,
  };
}

/** Builds a SkillDetail (as the backend returns it) from a skill JSON. Used by the mock API. */
export function detailFromSkill(
  json: SkillJson,
  extra: {
    status: SkillStatus;
    domain: string | null;
    published_at: string | null;
    learners_count?: number;
    avg_mastery?: number | null;
  },
): SkillDetail {
  return {
    id: json.id, title: json.title, description: json.description, summary: json.summary ?? "", language: json.language,
    author: json.author, created_at: json.created_at, learners_count: 0, avg_mastery: null, ...extra,
    steps_count: json.steps.length, guardrails_count: countGuardrails(json),
    skill: json, skill_md: skillToMarkdown(json),
  };
}

/** "3:12" for 192000 ms, "1:02:03" past an hour. Negative or invalid input gives "0:00". */
export function formatTimestamp(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Case-insensitive match of every word in the query against title, description, domain and author. */
export function filterSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return skills;
  return skills.filter((s) => {
    const hay = `${s.title} ${s.description} ${s.summary} ${s.domain ?? ""} ${s.author.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export type SkillSort = "newest" | "popular" | "mastery";

export const SORT_OPTIONS: { value: SkillSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "popular", label: "Most learned" },
  { value: "mastery", label: "Best mastery" },
];

const when = (s: Pick<SkillSummary, "published_at" | "created_at">) => s.published_at ?? s.created_at;

/** Same ordering as GET /v1/skills?sort=. Returns a new array. Ties fall back to newest first. */
export function sortSkills(skills: SkillSummary[], sort: SkillSort): SkillSummary[] {
  const newest = (a: SkillSummary, b: SkillSummary) => when(b).localeCompare(when(a));
  const byMastery = (a: SkillSummary, b: SkillSummary) => (b.avg_mastery ?? -1) - (a.avg_mastery ?? -1);
  const byLearners = (a: SkillSummary, b: SkillSummary) => b.learners_count - a.learners_count;
  const cmp =
    sort === "popular"
      ? (a: SkillSummary, b: SkillSummary) => byLearners(a, b) || byMastery(a, b) || newest(a, b)
      : sort === "mastery"
        ? (a: SkillSummary, b: SkillSummary) => byMastery(a, b) || byLearners(a, b) || newest(a, b)
        : newest;
  return [...skills].sort(cmp);
}

export type DomainOption = { domain: string; count: number };

/** Domains present in the data with how many Holocrons each has: biggest first, then A to Z. Blank domains are skipped. */
export function domainOptions(skills: Pick<SkillSummary, "domain">[]): DomainOption[] {
  const counts = new Map<string, number>();
  for (const s of skills) {
    const d = s.domain?.trim();
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

/** Keeps only one domain. null or empty means all. */
export function filterByDomain<T extends Pick<SkillSummary, "domain">>(skills: T[], domain: string | null): T[] {
  return domain ? skills.filter((s) => s.domain === domain) : skills;
}

/** "1 learner", "12 learners", or null when nobody learned it yet (the UI hides the stat then). */
export function learnersLabel(count: number | null | undefined): string | null {
  if (!count || count < 1 || !Number.isFinite(count)) return null;
  return `${count} ${count === 1 ? "learner" : "learners"}`;
}

/** "72% avg mastery", or null for null, 0 or invalid (hidden in the UI). */
export function masteryLabel(avg: number | null | undefined): string | null {
  if (avg === null || avg === undefined || !Number.isFinite(avg) || avg <= 0) return null;
  return `${Math.round(Math.min(100, avg))}% avg mastery`;
}

export type WorkMapNode = {
  idx: number;
  title: string;
  t_ms: number;
  decisionType: string;
  /** Judgment calls and steps with guardrails are where the Master's reasoning matters most. */
  emphasis: boolean;
  guardrails: { id: string; type: string; rule: string }[];
};

/** Flattens a skill into ordered nodes for the visual work map. Steps are sorted by idx. */
export function buildWorkMap(skill: Pick<SkillJson, "steps">): WorkMapNode[] {
  return [...skill.steps]
    .sort((a, b) => a.idx - b.idx)
    .map((s) => ({
      idx: s.idx,
      title: s.title,
      t_ms: s.screen_moment.t_ms,
      decisionType: s.decision.type,
      emphasis: s.decision.type !== "routine" || s.guardrails.length > 0,
      guardrails: s.guardrails.map((g) => ({ id: g.id, type: g.type, rule: g.rule })),
    }));
}

/** "Yes, exactly" style label for where a guardrail came from. */
export function guardrailSourceLabel(g: Pick<SkillGuardrail, "source">): string {
  return g.source === "teachback" ? "Added in the teach-back" : "From the Master";
}

export function guardrailLabel(type: string): string {
  return type === "stop_and_ask" ? "Stop and ask" : type === "limit" ? "Limit" : type.replace(/_/g, " ");
}

export function slugify(title: string): string {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "holocron";
}

/** Renders the SKILL.md an agent loads (format from Notion page 03). Used for the mock export and tests. */
export function skillToMarkdown(skill: SkillJson): string {
  const lines: string[] = [
    "---",
    `name: ${slugify(skill.title)}`,
    `description: ${skill.description.replace(/\s+/g, " ").trim()}`,
    `author: ${skill.author.name}`,
    `created: ${skill.created_at.slice(0, 10)}`,
    "---",
    "# Steps",
  ];
  for (const s of [...skill.steps].sort((a, b) => a.idx - b.idx)) {
    lines.push(`## ${s.idx}. ${s.title}`);
    lines.push(`- Moment: ${s.screen_moment.description} (${formatTimestamp(s.screen_moment.t_ms)})`);
    lines.push(`- Decision: ${s.decision.summary}`);
    lines.push(s.reason ? `- Why (expert): "${s.reason.quote}"` : "- Why: not given by the expert");
    for (const g of s.guardrails) lines.push(`- ${guardrailLabel(g.type)}: ${g.rule}`);
  }
  if (skill.global_guardrails.length > 0) {
    lines.push("# Global guardrails");
    for (const g of skill.global_guardrails) lines.push(`- ${guardrailLabel(g.type)}: ${g.rule}`);
  }
  return lines.join("\n") + "\n";
}
