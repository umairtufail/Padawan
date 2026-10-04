"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, listSkills } from "../lib/api";
import { domainOptions, filterByDomain, filterSkills, SORT_OPTIONS, type SkillSort, type SkillSummary } from "../lib/skills";
import { btnGhost, Chip, ErrorBox, Label } from "./ui";
import { formatDate, SkillStats, StatusChip } from "./skill-parts";
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
        <p className="mt-1 line-clamp-2 text-sm text-fg">{skill.description}</p>
        <p className="mt-1 line-clamp-3 flex-1 text-sm text-muted" data-testid="skill-summary">{skill.summary}</p>
        <div className="mt-4"><SkillStats skill={skill} /></div>
        <p className="mt-3 font-mono text-xs text-muted">
          Taught by {skill.author.name} · {formatDate(skill.published_at ?? skill.created_at)}
        </p>
      </Link>
    </li>
  );
}

export default function ArchivesView() {
  const [tab, setTab] = useState<"published" | "mine">("published");
  const [sort, setSort] = useState<SkillSort>("newest");
  const [domain, setDomain] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const latest = useRef(0);

  // The previous list stays on screen while a new sort or tab loads, so the domain chips do not flash away.
  const load = useCallback(async (which: "published" | "mine", order: SkillSort) => {
    const mine = ++latest.current;
    setError("");
    setLoading(true);
    try {
      const rows = await listSkills({ mine: which === "mine", sort: order });
      if (mine === latest.current) setSkills(rows);
    } catch (err) {
      if (mine === latest.current && !(err instanceof ApiError && err.status === 401)) {
        setError(err instanceof Error ? err.message : "Could not open the Archives.");
        setSkills([]);
      }
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load when the tab or the sort changes
    void load(tab, sort);
  }, [load, tab, sort]);

  const domains = useMemo(() => domainOptions(skills ?? []), [skills]);
  const activeDomain = domain && domains.some((d) => d.domain === domain) ? domain : null;
  const shown = useMemo(
    () => (skills ? filterByDomain(filterSkills(skills, query), activeDomain) : []),
    [skills, query, activeDomain],
  );
  const filtering = Boolean(query.trim() || activeDomain);

  const tabCls = (on: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-semibold ${on ? "bg-surface-2 text-gold" : "text-muted hover:text-fg"}`;
  const chipCls = (on: boolean) =>
    `rounded-full border px-3 py-1 font-mono text-xs transition focus-visible:outline-2 focus-visible:outline-info ${
      on ? "border-gold bg-gold/10 text-gold" : "border-line text-muted hover:border-muted hover:text-fg"
    }`;

  function switchTab(next: "published" | "mine") {
    if (next === tab) return;
    setDomain(null);
    setTab(next);
  }

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
          <button role="tab" type="button" aria-selected={tab === "published"} className={tabCls(tab === "published")} onClick={() => switchTab("published")}>
            Published
          </button>
          <button role="tab" type="button" aria-selected={tab === "mine"} className={tabCls(tab === "mine")} onClick={() => switchTab("mine")}>
            My Holocrons
          </button>
        </div>
        <label className="min-w-0 flex-1 basis-56 sm:max-w-sm">
          <span className="sr-only">Search Holocrons</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, domain or Master"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-info"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span className="font-mono text-xs uppercase tracking-widest">Sort</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SkillSort)}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-info"
          >
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>

      {domains.length > 0 && (
        <div role="group" aria-label="Filter by domain" className="flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed={activeDomain === null} className={chipCls(activeDomain === null)} onClick={() => setDomain(null)}>
            All
          </button>
          {domains.map((d) => (
            <button
              key={d.domain}
              type="button"
              aria-pressed={activeDomain === d.domain}
              className={chipCls(activeDomain === d.domain)}
              onClick={() => setDomain(activeDomain === d.domain ? null : d.domain)}
            >
              {d.domain} <span className="opacity-70">{d.count}</span>
            </button>
          ))}
        </div>
      )}

      {skills === null && loading && <p className="font-mono text-sm text-muted" role="status">Consulting the Archives…</p>}
      {error && <ErrorBox>{error}</ErrorBox>}
      {skills && !error && shown.length === 0 && (
        <div className="rounded-xl border border-dashed border-line p-6 text-muted" data-testid="empty-state">
          {filtering ? (
            <>
              <p>No Holocron matches{query.trim() ? ` "${query.trim()}"` : ""}{activeDomain ? ` in ${activeDomain}` : ""}.</p>
              <button type="button" className={`${btnGhost} mt-3`} onClick={() => { setQuery(""); setDomain(null); }}>
                Clear search and filters
              </button>
            </>
          ) : tab === "published" ? (
            <p>The Archives are empty. Teach Yoda something and publish the Holocron.</p>
          ) : (
            <p>Nothing here yet. A finished teaching session shows up as a draft until you publish it.</p>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <ul
          className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${loading ? "opacity-60" : ""}`}
          aria-label="Holocrons"
          aria-busy={loading}
        >
          {shown.map((s) => <SkillCard key={s.id} skill={s} />)}
        </ul>
      )}
    </div>
  );
}
