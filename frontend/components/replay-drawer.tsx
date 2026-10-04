"use client";

import { useEffect, useRef } from "react";
import type { SkillStep } from "../lib/skills";
import { formatTimestamp, guardrailLabel } from "../lib/skills";
import { btnGhost, Chip, Label } from "./ui";

type Props = {
  step: SkillStep;
  /** The Master's moment (from the verdict or the skill). */
  momentMs: number;
  momentText: string;
  onClose: () => void;
};

/** The Master's moment for one step: what was on screen, what he decided, why, and the limits. */
export default function ReplayDrawer({ step, momentMs, momentText, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      role="dialog"
      aria-label={`The Master's moment, step ${step.idx}`}
      data-testid="replay-drawer"
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-gold/40 bg-surface shadow-[-20px_0_60px_-10px_rgba(0,0,0,0.7)]"
    >
      <div className="flex items-start justify-between gap-3 border-b border-line p-5">
        <div>
          <Label className="!text-gold">The Master&apos;s moment</Label>
          <h2 className="mt-1 font-heading text-xl font-black text-fg">
            Step {step.idx}: {step.title}
          </h2>
        </div>
        <button ref={closeRef} type="button" className={btnGhost} onClick={onClose} aria-label="Close the replay">
          Close
        </button>
      </div>

      <div className="space-y-5 p-5">
        <section aria-label="Screen moment" className="rounded-xl border border-line bg-bg/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <Label>On his screen</Label>
            <Chip tone="info">{formatTimestamp(momentMs)}</Chip>
          </div>
          {/* Keyframe images are private storage with signed URLs, not shown yet: the description and the time. */}
          <div className="mt-3 flex min-h-24 items-center justify-center rounded-lg border border-dashed border-line bg-surface p-4 text-center text-sm text-muted">
            {momentText}
          </div>
        </section>

        <section aria-label="Decision">
          <Label>His decision</Label>
          <p className="mt-1 text-fg">
            <Chip tone={step.decision.type === "routine" ? "muted" : "gold"}>{step.decision.type}</Chip>{" "}
            <span className="ml-1">{step.decision.summary}</span>
          </p>
        </section>

        <section aria-label="Reason">
          <Label className="!text-jade">Why, in his words</Label>
          <blockquote className="mt-2 border-l-2 border-jade/60 pl-4">
            <p className="font-heading text-lg italic text-fg">&ldquo;{step.reason.quote}&rdquo;</p>
            <p className="mt-1 text-sm text-muted">{step.reason.text}</p>
          </blockquote>
        </section>

        <section aria-label="Guardrails">
          <Label className="!text-danger">Limits</Label>
          {step.guardrails.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No limits recorded for this step.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {step.guardrails.map((g) => (
                <li key={g.id} className="rounded-xl border border-danger/40 bg-danger/5 p-3">
                  <Chip tone="danger">{guardrailLabel(g.type)}</Chip>
                  <p className="mt-2 font-semibold text-fg">{g.rule}</p>
                  <p className="mt-1 text-sm italic text-muted">&ldquo;{g.quote}&rdquo;</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
