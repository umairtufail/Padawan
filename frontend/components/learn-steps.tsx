"use client";

import type { LearnState, PredictionNote } from "../lib/learn";
import { stepStatus } from "../lib/learn";
import type { SkillStep } from "../lib/skills";
import { Chip, Label } from "./ui";

type Props = {
  steps: SkillStep[];
  state: LearnState;
  predictions: Record<number, PredictionNote>;
};

/** The Holocron's steps with the current one highlighted. The Master's decisions stay hidden until the Padawan tries. */
export default function LearnSteps({ steps, state, predictions }: Props) {
  const ordered = [...steps].sort((a, b) => a.idx - b.idx);
  const current = ordered.find((s) => s.idx === state.stepIdx);

  return (
    <section aria-labelledby="learn-steps" className="rounded-2xl border border-gold/30 bg-surface/90 p-5" data-testid="learn-steps">
      <div className="flex items-center justify-between gap-3">
        <Label className="!text-gold">The Holocron</Label>
        <Chip tone="gold">
          Step {current ? ordered.indexOf(current) + 1 : "-"} of {ordered.length}
        </Chip>
      </div>
      <h2 id="learn-steps" className="sr-only">Steps of this Holocron</h2>
      <ol className="mt-3 space-y-2">
        {ordered.map((s) => {
          const status = stepStatus(s, state.stepIdx);
          const pred = predictions[s.idx];
          const stops = state.stops[s.idx] ?? 0;
          const warns = state.warns[s.idx] ?? 0;
          const here = status === "current";
          return (
            <li
              key={s.idx}
              aria-current={here ? "step" : undefined}
              data-status={status}
              className={`rounded-xl border p-3 transition ${
                here ? "border-gold bg-gold/10 shadow-[0_0_24px_-8px_rgba(255,210,74,0.6)]" : status === "done" ? "border-jade/30 bg-surface-2/40" : "border-line bg-surface-2/20"
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs ${
                    here ? "border-gold bg-gold text-[#05070d]" : status === "done" ? "border-jade/60 text-jade" : "border-line text-muted"
                  }`}
                >
                  {status === "done" ? "✓" : s.idx}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`font-semibold ${here ? "text-fg" : status === "done" ? "text-fg" : "text-muted"}`}>
                    {s.title}
                    <span className="sr-only"> ({status === "done" ? "done" : here ? "current step" : "not yet"})</span>
                  </p>
                  {here && <p className="mt-1 text-sm text-muted">{s.predict_prompt ?? "Work through it. Yoda is watching."}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {s.decision.type !== "routine" && <Chip tone="muted">judgment</Chip>}
                    {pred && <Chip tone={pred.correct ? "jade" : "danger"}>{pred.correct ? "predicted right" : "predicted wrong"}</Chip>}
                    {stops > 0 && <Chip tone="danger">{stops} stop{stops > 1 ? "s" : ""}</Chip>}
                    {warns > 0 && <Chip tone="gold">{warns} warning{warns > 1 ? "s" : ""}</Chip>}
                  </div>
                  {pred && !pred.correct && (
                    <p className="mt-2 text-xs text-muted">
                      You said &ldquo;{pred.predicted}&rdquo;. The Master: {pred.expected}
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
