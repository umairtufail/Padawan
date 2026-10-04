/**
 * Skill ("Holocron") types and pure helpers. The JSON follows the contract in Notion page 03
 * (Data Model and Skill Schema). No network or browser code here so it stays easy to test.
 */

export type SkillStatus = "draft" | "published";

export type SkillGuardrail = {
  id: string;
  type: string; // limit | stop_and_ask | ...
  rule: string;
  quote: string;
  t_ms: number;
};

export type SkillStep = {
  idx: number;
  title: string;
  screen_moment: { t_ms: number; keyframe_path?: string | null; description: string };
  decision: { type: string; summary: string }; // routine | judgment | ...
  reason: { text: string; quote: string; t_ms: number };
  guardrails: SkillGuardrail[];
  predict_prompt?: string;
};

/** The skill JSON from the contract. */
export type SkillJson = {
  id: string;
  title: string;
  description: string;
  author: { id: string; name: string };
  created_at: string;
  language: string;
  steps: SkillStep[];
  global_guardrails: SkillGuardrail[];
  teachback?: { confirmed: boolean; corrections: string[] };
};

/** Row shape of GET /v1/skills (the `skills` table columns, with the author resolved). */
export type SkillSummary = {
  id: string;
  title: string;
  description: string;
  domain: string | null;
  language: string;
  status: SkillStatus;
  author: { id: string; name: string };
  steps_count: number;
  guardrails_count: number;
  created_at: string;
  published_at: string | null;
};

/** GET /v1/skills/{id}: the skill JSON plus the table fields that are not part of it. */
export type SkillDetail = SkillJson & {
  status: SkillStatus;
  domain: string | null;
  steps_count: number;
  guardrails_count: number;
  published_at: string | null;
};

export function countGuardrails(skill: Pick<SkillJson, "steps" | "global_guardrails">): number {
  return skill.steps.reduce((n, s) => n + s.guardrails.length, 0) + skill.global_guardrails.length;
}

export function toSummary(skill: SkillDetail): SkillSummary {
  return {
    id: skill.id, title: skill.title, description: skill.description, domain: skill.domain,
    language: skill.language, status: skill.status, author: skill.author,
    steps_count: skill.steps.length, guardrails_count: countGuardrails(skill),
    created_at: skill.created_at, published_at: skill.published_at,
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
    const hay = `${s.title} ${s.description} ${s.domain ?? ""} ${s.author.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
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
    lines.push(`- Why (expert): "${s.reason.quote}"`);
    for (const g of s.guardrails) lines.push(`- ${guardrailLabel(g.type)}: ${g.rule}`);
  }
  if (skill.global_guardrails.length > 0) {
    lines.push("# Global guardrails");
    for (const g of skill.global_guardrails) lines.push(`- ${guardrailLabel(g.type)}: ${g.rule}`);
  }
  return lines.join("\n") + "\n";
}
