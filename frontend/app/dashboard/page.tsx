"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  API_URL, MOCK, ApiError, createTeachSession, health, listSessions, type SessionSummary,
} from "../../lib/api";
import { btnPrimary, Chip, ErrorBox, Label } from "../../components/ui";
import YodaFigure from "../../components/yoda-figure";

type Backend = "checking" | "up" | "down";

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function Overview() {
  const router = useRouter();
  const [backend, setBackend] = useState<Backend>("checking");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    setSessions(null);
    health().then(() => setBackend("up")).catch(() => setBackend("down"));
    try {
      setSessions(await listSessions());
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setLoadError(err instanceof Error ? err.message : "Could not load sessions.");
        setSessions([]);
      }
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void load();
  }, [load]);

  async function startTeaching() {
    setCreating(true);
    setCreateError("");
    try {
      const s = await createTeachSession("New task");
      router.push(`/dashboard/teach/${s.session_id}`);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setCreateError(err instanceof Error ? err.message : "Could not create a session.");
      }
      setCreating(false);
    }
  }

  const statusText = backend === "checking" ? "Checking backend…" : backend === "up" ? "Backend reachable" : "Backend unreachable";
  const statusTone = backend === "up" ? "jade" : backend === "down" ? "danger" : "info";

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface/70 px-4 py-3" role="status">
        <Chip tone={statusTone}>{statusText}</Chip>
        <span className="font-mono text-xs text-muted">
          API: {MOCK ? "mock mode (no network)" : API_URL}
        </span>
      </div>

      <section className="grid gap-5 md:grid-cols-2" aria-label="What would you like to do">
        <article className="flex flex-col rounded-2xl border border-jade/30 bg-surface/90 p-7">
          <div className="flex items-center gap-4">
            <YodaFigure size={76} label="" />
            <Label className="!text-jade">For the Master</Label>
          </div>
          <h2 className="mt-4 font-heading text-3xl font-black text-gold">Teach Yoda</h2>
          <p className="mt-2 flex-1 leading-relaxed text-muted">
            Share your screen while you work. Yoda watches, notes what changes and learns the why behind each step.
          </p>
          {createError && <div className="mt-4"><ErrorBox>{createError}</ErrorBox></div>}
          <button type="button" onClick={startTeaching} disabled={creating} className={`${btnPrimary} mt-6 self-start`}>
            {creating ? "Creating session…" : "Start teaching"}
          </button>
        </article>

        <article className="flex flex-col rounded-2xl border border-line bg-surface/50 p-7 opacity-80">
          <Label>For the Padawan</Label>
          <h2 className="mt-4 font-heading text-3xl font-black text-muted">Learn from Yoda</h2>
          <p className="mt-2 flex-1 leading-relaxed text-muted">
            Yoda tutors you through a Holocron and stops you before you break a guardrail.
          </p>
          <button type="button" disabled className="mt-6 cursor-not-allowed self-start rounded-lg border border-line px-5 py-2.5 text-sm font-semibold text-muted">
            Coming soon
          </button>
        </article>
      </section>

      <section aria-label="Stats" className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface/70 p-4">
          <Label>Sessions</Label>
          <p className="mt-2 font-heading text-3xl font-black text-fg">{sessions ? sessions.length : "–"}</p>
        </div>
        <div className="rounded-xl border border-line bg-surface/70 p-4">
          <Label>Events captured</Label>
          <p className="mt-2 font-heading text-3xl font-black text-fg">
            {sessions ? sessions.reduce((n, s) => n + s.events_count, 0) : "–"}
          </p>
        </div>
      </section>

      <section aria-labelledby="my-sessions">
        <div className="flex items-center justify-between">
          <h2 id="my-sessions" className="font-heading text-2xl font-black text-gold">My sessions</h2>
          <button type="button" onClick={() => void load()} className="font-mono text-xs text-info underline underline-offset-4 hover:text-fg">
            Refresh
          </button>
        </div>
        <div className="mt-4">
          {sessions === null && <p className="font-mono text-sm text-muted" role="status">Loading sessions…</p>}
          {loadError && <ErrorBox>{loadError}</ErrorBox>}
          {sessions && sessions.length === 0 && !loadError && (
            <p className="rounded-xl border border-dashed border-line p-6 text-muted">
              No sessions yet. Start teaching and your first one will show up here.
            </p>
          )}
          {sessions && sessions.length > 0 && (
            <ul className="space-y-3">
              {sessions.map((s) => (
                <li key={s.session_id}>
                  <Link
                    href={`/dashboard/teach/${s.session_id}`}
                    className="block rounded-xl border border-line bg-surface/80 p-4 transition hover:border-jade/60 focus-visible:outline-2 focus-visible:outline-info"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-heading text-lg font-bold text-fg">{s.title}</h3>
                      <span className="font-mono text-xs text-muted">{formatDate(s.created_at)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted">
                      {s.last_screen_summary || "No screen captured yet."}
                    </p>
                    <div className="mt-3"><Chip tone="info">{s.events_count} events</Chip></div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
