"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, exportSkill, publishSkill, type SkillDetail, type SkillStep } from "../lib/api";
import { formatTimestamp, guardrailLabel } from "../lib/skills";
import { btnGhost, btnPrimary, Chip, ErrorBox, Label } from "./ui";
import { formatDate, StatusChip, useSkill } from "./skill-parts";
import WorkMap from "./work-map";
import YodaFigure from "./yoda-figure";

function StepDetail({ step }: { step: SkillStep }) {
  return (
    <article aria-label={`Step ${step.idx}: ${step.title}`} className="space-y-5 rounded-2xl border border-gold/30 bg-surface/90 p-5 sm:p-6">
      <header>
        <Label className="!text-gold">Step {step.idx}</Label>
        <h2 className="mt-1 font-heading text-2xl font-black text-fg">{step.title}</h2>
      </header>

      <section aria-label="Screen moment" className="rounded-xl border border-line bg-bg/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <Label>Screen moment</Label>
          <Chip tone="info">{formatTimestamp(step.screen_moment.t_ms)}</Chip>
        </div>
        {/* Keyframes are private storage with signed URLs, not available yet: show the description and time. */}
        <div className="mt-3 flex min-h-28 items-center justify-center rounded-lg border border-dashed border-line bg-surface p-4 text-center text-sm text-muted">
          {step.screen_moment.description}
        </div>
      </section>

      <section aria-label="Decision">
        <Label>Decision</Label>
        <p className="mt-1 text-fg">
          <Chip tone={step.decision.type === "routine" ? "muted" : "gold"}>{step.decision.type}</Chip>{" "}
          <span className="ml-1">{step.decision.summary}</span>
        </p>
      </section>

      <section aria-label="Reason">
        <Label className="!text-jade">Why, in the Master&apos;s words</Label>
        <blockquote className="mt-2 border-l-2 border-jade/60 pl-4">
          <p className="font-heading text-lg italic text-fg">&ldquo;{step.reason.quote}&rdquo;</p>
          <p className="mt-1 text-sm text-muted">{step.reason.text}</p>
          <footer className="mt-1 font-mono text-xs text-muted">at {formatTimestamp(step.reason.t_ms)}</footer>
        </blockquote>
      </section>

      <section aria-label="Guardrails">
        <Label className="!text-danger">Guardrails</Label>
        {step.guardrails.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No guardrails recorded for this step.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {step.guardrails.map((g) => (
              <li key={g.id} className="rounded-xl border border-danger/40 bg-danger/5 p-3">
                <Chip tone="danger">{guardrailLabel(g.type)}</Chip>
                <p className="mt-2 font-semibold text-fg">{g.rule}</p>
                <p className="mt-1 text-sm italic text-muted">&ldquo;{g.quote}&rdquo; <span className="not-italic">({formatTimestamp(g.t_ms)})</span></p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {step.predict_prompt && (
        <section aria-label="Yoda asks" className="rounded-xl border border-info/30 bg-info/5 p-3">
          <Label className="!text-info">Yoda will ask the Padawan</Label>
          <p className="mt-1 text-sm text-fg">{step.predict_prompt}</p>
        </section>
      )}
    </article>
  );
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function HolocronView({ id }: { id: string }) {
  const { skill, setSkill, error, notFound } = useSkill(id);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState<"" | "publish" | "export">("");
  const [actionError, setActionError] = useState("");

  if (notFound) {
    return (
      <div className="space-y-4">
        <ErrorBox>This Holocron does not exist, or it is not yours to see.</ErrorBox>
        <Link href="/dashboard/skills" className={btnGhost}>Back to the Jedi Archives</Link>
      </div>
    );
  }
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!skill) return <p className="font-mono text-sm text-muted" role="status">Consulting the Holocron…</p>;

  const steps = [...skill.steps].sort((a, b) => a.idx - b.idx);
  const current = steps.find((s) => s.idx === selected) ?? steps[0];

  async function act(kind: "publish" | "export", fn: () => Promise<void>) {
    setBusy(kind);
    setActionError("");
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setActionError(err instanceof Error ? err.message : "That did not work.");
      }
    } finally {
      setBusy("");
    }
  }

  const onPublish = () => act("publish", async () => setSkill(await publishSkill((skill as SkillDetail).id)));
  const onExport = () =>
    act("export", async () => {
      const md = await exportSkill((skill as SkillDetail).id);
      download("SKILL.md", md);
    });

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="font-mono text-xs text-muted">
        <Link href="/dashboard/skills" className="underline underline-offset-4 hover:text-fg">Jedi Archives</Link> / Holocron
      </nav>

      <header className="flex flex-col gap-5 rounded-2xl border border-line bg-surface/80 p-5 sm:flex-row sm:items-center sm:p-6">
        <YodaFigure size={84} label="" className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={skill.status} />
            {skill.domain && <Chip tone="info">{skill.domain}</Chip>}
            <Chip tone="muted">{skill.steps.length} steps</Chip>
            <Chip tone="danger">{skill.guardrails_count} {skill.guardrails_count === 1 ? "guardrail" : "guardrails"}</Chip>
          </div>
          <h1 className="mt-2 font-heading text-2xl font-black text-gold sm:text-3xl">{skill.title}</h1>
          <p className="mt-1 text-muted">{skill.description}</p>
          <p className="mt-2 font-mono text-xs text-muted">
            Taught by {skill.author.name} · {formatDate(skill.published_at ?? skill.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:flex-col">
          {skill.status === "draft" ? (
            <button type="button" className={btnPrimary} onClick={() => void onPublish()} disabled={busy !== ""}>
              {busy === "publish" ? "Publishing…" : "Publish to the Archives"}
            </button>
          ) : (
            <Link href={`/dashboard/learn/${encodeURIComponent(skill.id)}`} className={btnPrimary}>Start learning</Link>
          )}
          <button type="button" className={btnGhost} onClick={() => void onExport()} disabled={busy !== ""}>
            {busy === "export" ? "Exporting…" : "Export SKILL.md"}
          </button>
        </div>
      </header>

      {actionError && <ErrorBox>{actionError}</ErrorBox>}

      {skill.teachback?.corrections && skill.teachback.corrections.length > 0 && (
        <p className="rounded-xl border border-gold/30 bg-gold/5 px-4 py-3 text-sm text-fg">
          <span className="font-mono text-xs uppercase tracking-widest text-gold">Master&apos;s correction </span>
          {skill.teachback.corrections.join(" ")}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section aria-labelledby="map-h">
          <h2 id="map-h" className="mb-3 font-heading text-xl font-black text-fg">Work map</h2>
          <WorkMap skill={skill} selected={current?.idx ?? null} onSelect={setSelected} />
        </section>
        <section aria-labelledby="detail-h" className="lg:sticky lg:top-6 lg:self-start">
          <h2 id="detail-h" className="sr-only">Step detail</h2>
          {current ? <StepDetail step={current} /> : <p className="text-muted">This Holocron has no steps yet.</p>}
        </section>
      </div>
    </div>
  );
}
