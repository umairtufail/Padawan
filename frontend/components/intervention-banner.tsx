"use client";

import { stripWait, type Banner } from "../lib/learn";
import { formatTimestamp } from "../lib/skills";

type Props = {
  banner: Banner;
  /** Yoda is saying it right now. */
  speaking: boolean;
  onReplay: (stepIdx: number) => void;
  onDismiss: () => void;
};

/**
 * The intervention. A `stop` is a strong full-width red banner (Yoda says it aloud and the replay opens);
 * a `warn` is a softer gold note that does not block anything.
 */
export default function InterventionBanner({ banner, speaking, onReplay, onDismiss }: Props) {
  const v = banner.verdict;
  const stop = banner.kind === "stop";
  const stepIdx = v.replay?.step_idx ?? v.step_idx;

  if (!stop) {
    return (
      <div role="status" data-testid="warn-note" className="rounded-xl border border-gold/50 bg-gold/10 px-4 py-3 text-sm">
        <span className="font-mono text-xs uppercase tracking-widest text-gold">Careful, Padawan </span>
        <span className="text-fg">{v.reason || v.rule}</span>
        {v.rule && v.reason && <span className="text-muted"> Rule: {v.rule}</span>}
        <button type="button" onClick={onDismiss} className="ml-3 text-xs text-muted underline underline-offset-4 hover:text-fg">
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="stop-banner"
      className="stop-banner relative overflow-hidden rounded-2xl border-2 border-danger bg-danger/15 p-5 shadow-[0_0_40px_-6px_rgba(255,84,104,0.55)] sm:p-6"
    >
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 border-danger bg-danger/20 font-heading text-2xl font-black text-danger">
          !
        </span>
        <div className="min-w-0 flex-1 basis-64">
          <p className="font-mono text-xs uppercase tracking-widest text-danger">
            Stop{v.step_title ? ` · step ${v.step_idx ?? ""}: ${v.step_title}` : ""}
          </p>
          <h2 className="mt-1 font-heading text-2xl font-black text-fg sm:text-3xl">Wait. The Master would stop here.</h2>
          {v.reason && <p className="mt-2 text-lg text-fg">{stripWait(v.reason)}</p>}
          {v.rule && (
            <p className="mt-2 text-sm text-fg">
              <span className="font-mono text-xs uppercase tracking-widest text-danger">Rule </span>
              {v.rule}
            </p>
          )}
          {v.expert_quote && <p className="mt-1 text-sm italic text-muted">&ldquo;{v.expert_quote}&rdquo;</p>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {stepIdx ? (
              <button
                type="button"
                onClick={() => onReplay(stepIdx)}
                className="inline-flex items-center gap-2 rounded-lg bg-danger px-4 py-2 font-heading text-sm font-bold text-[#05070d] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
              >
                See the Master&apos;s moment{v.replay ? ` (${formatTimestamp(v.replay.t_ms)})` : ""}
              </button>
            ) : null}
            {speaking && <span className="font-mono text-xs text-jade">Yoda is speaking…</span>}
            {v.committed && <span className="font-mono text-xs text-gold">Already saved: too late to stop it, practise it.</span>}
          </div>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted">
        Stay on this page. The banner clears when your screen no longer shows the problem.{" "}
        <button type="button" onClick={onDismiss} className="underline underline-offset-4 hover:text-fg">
          I understand, hide it
        </button>
      </p>
    </div>
  );
}
