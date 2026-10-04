"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import LearnSession from "../../../../components/learn-session";
import { formatDate, useSkill } from "../../../../components/skill-parts";
import { btnPrimary, ErrorBox, Label } from "../../../../components/ui";
import YodaFigure from "../../../../components/yoda-figure";
import { ApiError } from "../../../../lib/api";
import { createLearnSession } from "../../../../lib/learn-api";
import type { LearnSessionOut } from "../../../../lib/learn";

type DisplayMediaOptionsWithSelfExclusion = Omit<DisplayMediaStreamOptions, "video"> & {
  selfBrowserSurface?: "include" | "exclude";
  video: MediaTrackConstraints & { cursor?: "always" | "motion" | "never" };
};

type Started = { session: LearnSessionOut; stream: MediaStream };

/** /dashboard/learn/[id]: id is the skill (Holocron) id. Start asks for the screen, creates the session, Yoda begins. */
export default function LearnPage() {
  const { id } = useParams<{ id: string }>();
  const { skill, error: loadError, notFound } = useSkill(id);
  const [phase, setPhase] = useState<"idle" | "choosing" | "creating">("idle");
  const [error, setError] = useState("");
  const [started, setStarted] = useState<Started | null>(null);

  async function start() {
    setError("");
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen sharing is not supported in this browser.");
      return;
    }
    // getDisplayMedia needs a user gesture, so the screen is asked for first, right inside this click.
    setPhase("choosing");
    let stream: MediaStream;
    try {
      const options: DisplayMediaOptionsWithSelfExclusion = {
        video: { frameRate: { ideal: 15, max: 30 }, cursor: "never" },
        audio: false,
        selfBrowserSurface: "exclude",
      };
      stream = await navigator.mediaDevices.getDisplayMedia(options);
    } catch (err) {
      setPhase("idle");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Screen sharing was cancelled. Press the button again when you are ready."
          : err instanceof Error ? err.message : "Could not start screen sharing.",
      );
      return;
    }

    setPhase("creating");
    try {
      const session = await createLearnSession(id);
      setStarted({ session, stream });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setPhase("idle");
      if (err instanceof ApiError && err.status === 401) return;
      setError(
        err instanceof ApiError && err.status === 404
          ? "This Holocron is not available to you. Only published Holocrons (or your own drafts) can be learned."
          : err instanceof ApiError && err.status === 409
            ? "This Holocron has no steps yet, so there is nothing to learn."
            : err instanceof Error ? err.message : "Could not start the lesson.",
      );
    }
  }

  if (started) {
    return (
      <LearnSession
        session={started.session}
        stream={started.stream}
        onAgain={() => {
          started.stream.getTracks().forEach((t) => t.stop());
          setStarted(null);
          setPhase("idle");
        }}
      />
    );
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <ErrorBox>Holocron not found. It may be someone else&apos;s draft or no longer exist.</ErrorBox>
        <Link href="/dashboard/skills" className="text-info underline underline-offset-4">Back to the Jedi Archives</Link>
      </div>
    );
  }

  const guardrails = skill?.guardrails_count ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/dashboard/skills" className="font-mono text-xs text-info underline underline-offset-4">&larr; Jedi Archives</Link>

      <section className="rounded-2xl border border-gold/30 bg-surface/90 p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <YodaFigure size={96} label="Yoda, your tutor" />
          <div className="min-w-0 flex-1 basis-64">
            <Label className="!text-gold">Learn with Yoda</Label>
            <h1 className="mt-1 font-heading text-3xl font-black text-fg">{skill ? skill.title : "Opening the Holocron…"}</h1>
            {skill && (
              <p className="mt-1 font-mono text-xs text-muted">
                The Master {skill.author.name} · {skill.steps_count} steps · {guardrails} limits{skill.published_at ? ` · published ${formatDate(skill.published_at)}` : ""}
              </p>
            )}
          </div>
        </div>
        {skill && <p className="mt-5 text-fg">{skill.description}</p>}

        <ol className="mt-6 space-y-3 text-sm text-muted">
          <li><span className="font-mono text-gold">1 </span>Share the screen where you do the work. Yoda only watches what you share.</li>
          <li><span className="font-mono text-gold">2 </span>Yoda speaks every step aloud and asks what you expect. Answer him by voice, so allow the microphone and use headphones.</li>
          <li><span className="font-mono text-gold">3 </span>If you are about to break one of the Master&apos;s limits, Yoda stops you and shows the Master&apos;s moment.</li>
          <li><span className="font-mono text-gold">4 </span>At the end you get a mastery report: what you mastered and what to practise.</li>
        </ol>

        {(error || loadError) && <div className="mt-6"><ErrorBox>{error || loadError}</ErrorBox></div>}

        <div className="mt-6">
          <button type="button" onClick={() => void start()} disabled={phase !== "idle" || !skill} className={btnPrimary}>
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-danger" />
            {phase === "choosing" ? "Choose what to share…" : phase === "creating" ? "Waking Yoda…" : "Begin the lesson"}
          </button>
        </div>
      </section>
    </div>
  );
}
