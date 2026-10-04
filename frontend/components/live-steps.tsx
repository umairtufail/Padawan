import type { StepDraft } from "../lib/pipeline-types";
import { formatTimestamp } from "../lib/skills";
import { Chip, Label } from "./ui";

type Props = {
  steps: StepDraft[];
  /** The step the backend says is open right now (from the last frame response), if known. */
  current?: { idx: number; title: string } | null;
  title?: string;
  empty?: string;
};

/** The steps Yoda has understood so far (GET /steps). The open one is the step in progress. */
export default function LiveSteps({ steps, current, title = "What Yoda has understood so far", empty }: Props) {
  return (
    <section aria-labelledby="live-steps" className="rounded-2xl border border-gold/30 bg-surface/90 p-5" data-testid="live-steps">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="!text-gold">Steps</Label>
        <h2 id="live-steps" className="font-heading text-xl font-black text-fg">{title}</h2>
        {current && <Chip tone="jade">now: step {current.idx}</Chip>}
      </div>
      {steps.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          {empty ?? "No steps yet. Yoda groups what he sees into steps every few seconds once the screen starts to change."}
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {steps.map((s) => (
            <li
              key={s.idx}
              data-status={s.status}
              className={`flex gap-3 rounded-xl border p-3 ${s.status === "open" ? "border-jade/60 bg-jade/5" : "border-line bg-bg/50"}`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-jade/60 font-heading text-xs font-black text-jade">{s.idx}</span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-fg">{s.title}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted">
                  {s.t_start_ms !== null && <span>{formatTimestamp(s.t_start_ms)}</span>}
                  <span>{s.event_ids.length} events</span>
                  <span>{s.question_ids.length} {s.question_ids.length === 1 ? "question" : "questions"} asked</span>
                  <Chip tone={s.status === "open" ? "jade" : "muted"}>{s.status === "open" ? "in progress" : "done"}</Chip>
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
