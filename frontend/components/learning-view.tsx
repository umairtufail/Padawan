"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../lib/api";
import { listLearnSessions } from "../lib/learn-api";
import { scoreTone } from "../lib/learn";
import { learningStats, progressLabel, progressPercent, sortSessions, type LearnSessionRow } from "../lib/learning";
import { btnGhost, btnPrimary, Chip, ErrorBox, Label } from "./ui";
import { formatDate } from "./skill-parts";
import YodaFigure from "./yoda-figure";

export function MasteryBadge({ score }: { score: number | null }) {
  if (score === null) return <Chip tone="muted">No score yet</Chip>;
  const shown = Math.round(score); // the API sends a float
  return <Chip tone={scoreTone(shown)}>Mastery {shown}</Chip>;
}

function ProgressBar({ row }: { row: LearnSessionRow }) {
  const pct = progressPercent(row);
  return (
    <div>
      <div
        role="progressbar"
        aria-label={`Progress: ${progressLabel(row)}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 overflow-hidden rounded-full bg-line"
      >
        <div className={`h-full rounded-full ${row.finished ? "bg-jade" : "bg-gold"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 font-mono text-xs text-muted">{progressLabel(row)}</p>
    </div>
  );
}

function SessionCard({ row }: { row: LearnSessionRow }) {
  const skillHref = row.skill_id ? `/dashboard/skills/${encodeURIComponent(row.skill_id)}` : null;
  const learnHref = row.skill_id ? `/dashboard/learn/${encodeURIComponent(row.skill_id)}` : null;
  return (
    <li className="rounded-2xl border border-line bg-surface/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-heading text-lg font-bold text-fg">{row.skill_title}</h3>
          <p className="font-mono text-xs text-muted">{formatDate(row.created_at)}</p>
        </div>
        <div className="flex items-center gap-2">
          {row.finished ? <Chip tone="jade">Finished</Chip> : <Chip tone="gold">In progress</Chip>}
          <MasteryBadge score={row.mastery_score} />
        </div>
      </div>
      <div className="mt-4"><ProgressBar row={row} /></div>
      <div className="mt-4 flex flex-wrap gap-2">
        {row.finished ? (
          <>
            <Link href={`/dashboard/learning/${encodeURIComponent(row.session_id)}`} className={btnPrimary}>View report</Link>
            {learnHref && <Link href={learnHref} className={btnGhost}>Learn it again</Link>}
          </>
        ) : learnHref && skillHref ? (
          <>
            {/* A lesson cannot be resumed: the lesson page always starts a fresh session on this Holocron. */}
            <Link href={learnHref} className={btnPrimary}>Start the lesson again</Link>
            <Link href={skillHref} className={btnGhost}>Open the Holocron</Link>
          </>
        ) : (
          <p className="text-sm text-muted">This Holocron is no longer available.</p>
        )}
      </div>
    </li>
  );
}

export default function LearningView() {
  const [rows, setRows] = useState<LearnSessionRow[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setRows(sortSessions(await listLearnSessions()));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setError(err instanceof Error ? err.message : "Could not load your lessons.");
        setRows([]);
      }
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void load();
  }, [load]);

  const stats = useMemo(() => learningStats(rows ?? []), [rows]);

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-4">
        <YodaFigure size={72} label="" className="shrink-0" />
        <div>
          <Label className="!text-jade">For the Padawan</Label>
          <h1 className="font-heading text-3xl font-black text-gold">My learning</h1>
          <p className="text-muted">Your lessons with Yoda. Only you can see them.</p>
        </div>
      </header>

      {rows && rows.length > 0 && (
        <p className="font-mono text-sm text-muted" data-testid="learning-stats">
          {stats.total} {stats.total === 1 ? "lesson" : "lessons"} · {stats.finished} finished
          {stats.avgMastery !== null ? ` · average mastery ${stats.avgMastery}` : ""}
        </p>
      )}

      {rows === null && <p className="font-mono text-sm text-muted" role="status">Opening your lessons…</p>}
      {error && <ErrorBox>{error}</ErrorBox>}
      {rows && !error && rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-line p-6 text-muted" data-testid="empty-state">
          <p>You have not started a lesson yet. Pick a Holocron in the Jedi Archives and Yoda will tutor you.</p>
          <Link href="/dashboard/skills" className={`${btnPrimary} mt-4`}>Browse the Archives</Link>
        </div>
      )}
      {rows && rows.length > 0 && (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="My lessons">
          {rows.map((r) => <SessionCard key={r.session_id} row={r} />)}
        </ul>
      )}
    </div>
  );
}
