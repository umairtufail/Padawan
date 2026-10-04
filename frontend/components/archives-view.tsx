"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, listSkills } from "../lib/api";
import { filterSkills, type SkillStatus, type SkillSummary } from "../lib/skills";
import { Chip, ErrorBox, Label } from "./ui";
import { formatDate, StatusChip } from "./skill-parts";
import YodaFigure from "./yoda-figure";

function SkillCard({ skill }: { skill: SkillSummary }) {
  return (
    <li>
      <Link
        href={`/dashboard/skills/${encodeURIComponent(skill.id)}`}
        className="flex h-full flex-col rounded-2xl border border-line bg-surface/80 p-5 transition hover:border-jade/60 focus-visible:outline-2 focus-visible:outline-info"
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={skill.status} />
          {skill.domain && <Chip tone="info">{skill.domain}</Chip>}
        </div>
        <h3 className="mt-3 font-heading text-lg font-bold text-fg">{skill.title}</h3>
        <p className="mt-1 line-clamp-3 flex-1 text-sm text-muted">{skill.description}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Chip tone="muted">{skill.steps_count} steps</Chip>
          <Chip tone="danger">{skill.guardrails_count} guardrails</Chip>
        </div>
        <p className="mt-3 font-mono text-xs text-muted">
          {skill.author.name} · {formatDate(skill.published_at ?? skill.created_at)}
        </p>
      </Link>
    </li>
  );
}

export default function ArchivesView() {
  const [tab, setTab] = useState<SkillStatus>("published");
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async (status: SkillStatus) => {
    setError("");
    setSkills(null);
    try {
      setSkills(await listSkills(status));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setError(err instanceof Error ? err.message : "Could not open the Archives.");
        setSkills([]);
      }
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load when the tab changes
    void load(tab);
  }, [load, tab]);

  const shown = useMemo(() => (skills ? filterSkills(skills, query) : []), [skills, query]);
  const tabCls = (on: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-semibold ${on ? "bg-surface-2 text-gold" : "text-muted hover:text-fg"}`;

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        <YodaFigure size={72} label="" className="shrink-0" />
        <div>
          <Label className="!text-jade">The Jedi Archives</Label>
          <h1 className="font-heading text-3xl font-black text-gold">Holocrons</h1>
          <p className="text-muted">What the Masters taught Yoda. Pick one and begin to learn.</p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Which Holocrons" className="flex gap-1 rounded-lg border border-line p-1">
          <button role="tab" type="button" aria-selected={tab === "published"} className={tabCls(tab === "published")} onClick={() => setTab("published")}>
            Published
          </button>
          <button role="tab" type="button" aria-selected={tab === "draft"} className={tabCls(tab === "draft")} onClick={() => setTab("draft")}>
            My drafts
          </button>
        </div>
        <label className="min-w-0 flex-1 sm:max-w-sm">
          <span className="sr-only">Search Holocrons</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, domain or Master"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-info"
          />
        </label>
      </div>

      {skills === null && <p className="font-mono text-sm text-muted" role="status">Consulting the Archives…</p>}
      {error && <ErrorBox>{error}</ErrorBox>}
      {skills && !error && shown.length === 0 && (
        <p className="rounded-xl border border-dashed border-line p-6 text-muted">
          {query
            ? "No Holocron matches that search."
            : tab === "published"
              ? "The Archives are empty. Teach Yoda something and publish the Holocron."
              : "No drafts. A finished teaching session shows up here until you publish it."}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Holocrons">
          {shown.map((s) => <SkillCard key={s.id} skill={s} />)}
        </ul>
      )}
    </div>
  );
}
