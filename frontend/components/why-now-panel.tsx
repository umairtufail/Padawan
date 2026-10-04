"use client";

import type { Check, QuestionCandidate } from "../lib/pause-controller";
import type { TraceEntry } from "../lib/use-pause-controller";
import type { ToolEvent } from "../lib/use-agent-conversation";
import { Chip, Label } from "./ui";

const KIND_TONE = { ask: "jade", manual: "gold", skip: "muted", queued: "info", context: "muted", presence: "gold" } as const;
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

type Props = {
  checks: Check[];
  pending: QuestionCandidate[];
  trace: TraceEntry[];
  tools: ToolEvent[];
  asked: number;
  budgetMax: number;
};

/** Dev panel: the pause rules as they are right now, the question queue, and a "why now" line for every decision. */
export default function WhyNowPanel({ checks, pending, trace, tools, asked, budgetMax }: Props) {
  return (
    <details className="rounded-2xl border border-line bg-surface/80 p-5" open data-testid="why-now-panel">
      <summary className="cursor-pointer font-heading text-lg font-bold text-gold">
        Why now? <span className="font-mono text-xs font-normal text-muted">dev panel · {asked} asked · budget {budgetMax} per 10 min</span>
      </summary>

      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <div>
          <Label>Pause rules right now</Label>
          <ul className="mt-2 space-y-1 text-sm">
            {checks.length === 0 && <li className="text-muted">Evaluating…</li>}
            {checks.map((c) => (
              <li key={c.id} className="flex gap-2" data-check={c.id} data-ok={c.ok}>
                <span aria-hidden className={c.ok ? "text-jade" : "text-danger"}>{c.ok ? "✓" : "✗"}</span>
                <span className="sr-only">{c.ok ? "passes:" : "blocks:"}</span>
                <span className="text-fg">{c.detail}</span>
              </li>
            ))}
          </ul>

          <Label className="mt-5 block">Questions waiting</Label>
          <ul className="mt-2 space-y-1 text-sm">
            {pending.length === 0 && <li className="text-muted">None.</li>}
            {pending.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-2">
                <Chip tone="muted">{q.source}</Chip>
                <span className="text-fg">{q.question}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <Label>Decisions (newest first)</Label>
          <ol className="mt-2 max-h-72 space-y-2 overflow-y-auto text-sm" aria-label="Why now trace">
            {trace.length === 0 && <li className="text-muted">No decision yet. A question must be waiting first.</li>}
            {trace.map((t) => (
              <li key={t.id} data-kind={t.kind}>
                <div className="flex items-center gap-2">
                  <Chip tone={KIND_TONE[t.kind]}>{t.kind}</Chip>
                  <span className="font-mono text-xs text-muted">{time(t.at)}</span>
                </div>
                <p className="mt-1 break-words text-fg">{t.text}</p>
                {t.checks && t.kind !== "skip" && (
                  <p className="mt-0.5 break-words font-mono text-xs text-muted">{t.checks.map((c) => c.detail).join(" · ")}</p>
                )}
              </li>
            ))}
          </ol>

          <Label className="mt-5 block">Tool calls from Yoda</Label>
          <ul className="mt-2 space-y-1 text-sm">
            {tools.length === 0 && <li className="text-muted">None yet.</li>}
            {[...tools].reverse().map((t) => (
              <li key={t.id} className="break-words font-mono text-xs text-fg">
                {time(t.at)} {t.name}({JSON.stringify(t.args)})
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}
