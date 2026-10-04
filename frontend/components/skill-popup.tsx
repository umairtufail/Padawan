"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { formatTimestamp } from "../lib/skills";
import { btnGhost, btnPrimary, Chip, ErrorBox } from "./ui";
import { formatDate, StatusChip, useSkill } from "./skill-parts";

/** Modal shown over the Archives grid (intercepting route). Direct links get the full page instead. */
export default function SkillPopup() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { skill, error, notFound } = useSkill(id);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.back();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [router]);

  const steps = skill ? [...skill.steps].sort((a, b) => a.idx - b.idx) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) router.back();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={skill ? skill.title : "Holocron"}
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-gold/30 bg-surface shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div className="min-w-0">
            {skill && (
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip status={skill.status} />
                {skill.domain && <Chip tone="info">{skill.domain}</Chip>}
              </div>
            )}
            <h2 className="mt-2 font-heading text-xl font-black text-gold sm:text-2xl">{skill ? skill.title : "Consulting the Holocron…"}</h2>
            {skill && (
              <p className="mt-1 font-mono text-xs text-muted">
                Taught by {skill.author.name} · {formatDate(skill.published_at ?? skill.created_at)}
              </p>
            )}
          </div>
          <button ref={closeRef} type="button" onClick={() => router.back()} className={btnGhost} aria-label="Close">
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {error && <ErrorBox>{error}</ErrorBox>}
          {notFound && <ErrorBox>This Holocron does not exist, or it is not yours to see.</ErrorBox>}
          {skill && (
            <>
              <p className="text-fg">{skill.description}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Chip tone="muted">{skill.steps.length} steps</Chip>
                <Chip tone="danger">{skill.guardrails_count} guardrails</Chip>
              </div>
              <h3 className="mt-5 font-mono text-xs uppercase tracking-widest text-muted">Steps</h3>
              <ol className="mt-2 space-y-2">
                {steps.map((s) => (
                  <li key={s.idx} className="flex gap-3 rounded-xl border border-line bg-bg/50 p-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-jade/60 font-heading text-xs font-black text-jade">{s.idx}</span>
                    <div className="min-w-0">
                      <p className="font-semibold text-fg">{s.title}</p>
                      <p className="text-sm text-muted">{s.decision.summary}</p>
                      <p className="mt-1 font-mono text-[11px] text-muted">
                        {formatTimestamp(s.screen_moment.t_ms)}
                        {s.guardrails.length > 0 && <span className="text-danger"> · {s.guardrails.length} guardrail{s.guardrails.length > 1 ? "s" : ""}</span>}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>

        {skill && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line p-4">
            {/* Plain anchor on purpose: a hard navigation skips the interception and loads the full page. */}
            <a href={`/dashboard/skills/${encodeURIComponent(skill.id)}`} className={btnGhost}>
              Open the full Holocron
            </a>
            {skill.status === "published" && (
              <Link href={`/dashboard/learn/${encodeURIComponent(skill.id)}`} className={btnPrimary}>
                Start learning
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
