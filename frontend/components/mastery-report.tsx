"use client";

import Link from "next/link";
import { formatDuration, predictionLabel, RESULT_LABEL, scoreTitle, scoreTone, type MasteryReport } from "../lib/learn";
import { btnGhost, btnPrimary, Chip, Label } from "./ui";
import YodaFigure from "./yoda-figure";

const TONE_TEXT = { jade: "text-jade", gold: "text-gold", danger: "text-danger" } as const;
const TONE_STROKE = { jade: "stroke-jade", gold: "stroke-gold", danger: "stroke-danger" } as const;
const RESULT_TONE = { mastered: "jade", practise: "gold", not_reached: "muted" } as const;

function ScoreRing({ score }: { score: number }) {
  const tone = scoreTone(score);
  const r = 54;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-36 w-36 shrink-0" role="img" aria-label={`Mastery score ${score} out of 100`}>
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" strokeWidth="10" className="stroke-line" />
        <circle
          cx="64" cy="64" r={r} fill="none" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${(Math.min(100, Math.max(0, score)) / 100) * c} ${c}`}
          className={TONE_STROKE[tone]}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`font-heading text-4xl font-black ${TONE_TEXT[tone]}`} data-testid="mastery-score">{score}</span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted">of 100</span>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "text-fg" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 px-4 py-3">
      <p className={`font-heading text-2xl font-black ${tone}`}>{value}</p>
      <Label>{label}</Label>
    </div>
  );
}

/** The mastery report: score, per-step result and prediction, stops and warnings, what to practise next, Yoda's summary. */
export default function MasteryReportView({ report, onAgain }: { report: MasteryReport; onAgain?: () => void }) {
  const tone = scoreTone(report.mastery_score);
  return (
    <div className="space-y-6" data-testid="mastery-report">
      <section aria-labelledby="report-title" className="rounded-2xl border border-gold/40 bg-surface/90 p-5 sm:p-7">
        <Label className="!text-gold">Mastery report</Label>
        <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-5">
          <ScoreRing score={report.mastery_score} />
          <div className="min-w-0 flex-1 basis-64">
            <h2 id="report-title" className={`font-heading text-2xl font-black sm:text-3xl ${TONE_TEXT[tone]}`}>{scoreTitle(report.mastery_score)}</h2>
            <p className="mt-1 text-muted">{report.skill_title}</p>
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-jade/30 bg-jade/5 p-3">
              <YodaFigure size={44} animated={false} label="Yoda" className="shrink-0" />
              <p className="text-fg" data-testid="report-summary">&ldquo;{report.summary}&rdquo;</p>
            </div>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Steps mastered" value={`${report.steps_mastered}/${report.steps_total}`} tone="text-jade" />
          <Stat label="Predictions right" value={`${report.predictions_right}/${report.predictions_total}`} tone="text-info" />
          <Stat label="Stops" value={String(report.interventions_total)} tone={report.interventions_total ? "text-danger" : "text-fg"} />
          <Stat label="Warnings" value={String(report.warnings_total)} tone={report.warnings_total ? "text-gold" : "text-fg"} />
        </div>
        <p className="mt-3 font-mono text-xs text-muted">
          Time {formatDuration(report.time_total_ms)} · {report.steps_reached} of {report.steps_total} steps reached
        </p>
      </section>

      <section aria-labelledby="report-steps">
        <h2 id="report-steps" className="font-heading text-xl font-black text-gold">Step by step</h2>
        <ol className="mt-3 space-y-3">
          {report.steps.map((s) => (
            <li key={s.step_idx} data-result={s.result} className="rounded-xl border border-line bg-surface/80 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted">Step {s.step_idx}</span>
                <Chip tone={RESULT_TONE[s.result]}>{RESULT_LABEL[s.result]}</Chip>
                {s.decision_type === "judgment" && <Chip tone="muted">judgment</Chip>}
                <span className="ml-auto font-mono text-xs text-muted">{Math.round(s.score * 100)}% · {formatDuration(s.time_ms)}</span>
              </div>
              <p className="mt-2 font-semibold text-fg">{s.title}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone={s.predicted_right === true ? "jade" : s.predicted_right === false ? "danger" : "muted"}>{predictionLabel(s)}</Chip>
                {s.interventions > 0 && <Chip tone="danger">{s.interventions} stop{s.interventions > 1 ? "s" : ""}</Chip>}
                {s.warnings > 0 && <Chip tone="gold">{s.warnings} warning{s.warnings > 1 ? "s" : ""}</Chip>}
              </div>
              {s.predicted && <p className="mt-2 text-sm text-muted">You predicted: &ldquo;{s.predicted}&rdquo;</p>}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="report-next">
        <h2 id="report-next" className="font-heading text-xl font-black text-gold">Practise next</h2>
        {report.practise_next.length === 0 ? (
          <p className="mt-3 rounded-xl border border-jade/30 bg-jade/5 p-4 text-fg">Nothing to practise. Every step is mastered.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {report.practise_next.map((p) => (
              <li key={p.step_idx} className="rounded-xl border border-gold/40 bg-gold/5 p-4">
                <p className="font-mono text-xs uppercase tracking-widest text-gold">Step {p.step_idx}</p>
                <p className="mt-1 font-semibold text-fg">{p.title}</p>
                <p className="mt-1 text-sm text-muted">{p.why}</p>
                {p.rule && <p className="mt-2 text-sm text-fg"><span className="font-mono text-xs uppercase tracking-widest text-danger">Rule </span>{p.rule}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap gap-3">
        {onAgain && <button type="button" onClick={onAgain} className={btnPrimary}>Learn it again</button>}
        <Link href="/dashboard/skills" className={btnGhost}>Back to the Jedi Archives</Link>
      </div>
    </div>
  );
}
