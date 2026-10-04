"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, finishSession, postAnswer, postQuestionAsked, postTeachback, type FinishResult, type Gap, type TeachbackResult,
} from "../lib/api";
import { askedBody, newUuid, pickAnswerQuote, expertLinesSince } from "../lib/capture-sync";
import {
  buildTeachbackSummary, debriefReady, debriefTimeMs, GAP_LABEL, gapsContext, parseCorrections, questionTypeForGap,
  requiredAnswers, resolveGapId, sortGaps,
} from "../lib/debrief";
import { clearDebrief, loadDebrief, saveDebrief } from "../lib/debrief-handoff";
import { useAgentConversation, type VoiceToolHandlers } from "../lib/use-agent-conversation";
import { useCaptureSync } from "../lib/use-capture-sync";
import LiveSteps from "./live-steps";
import YodaVoicePanel from "./yoda-voice-panel";
import { btnGhost, btnPrimary, Chip, ErrorBox, Label } from "./ui";

type Answer = { text: string; via: "voice" | "typed" };

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span aria-hidden className={`mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full border text-center text-[10px] leading-[14px] ${ok ? "border-jade bg-jade/20 text-jade" : "border-line text-muted"}`}>
        {ok ? "✓" : ""}
      </span>
      <span className={ok ? "text-fg" : "text-muted"}>{children}</span>
      <span className="sr-only">{ok ? "(done)" : "(not yet)"}</span>
    </li>
  );
}

/**
 * The debrief: what Yoda understood (steps), the questions he still has (gaps, by voice or typed), then the
 * teach-back (Yoda explains it all, the Master confirms or corrects) which writes the draft Holocron.
 */
export default function DebriefView({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<FinishResult | null>(null);
  const [loadError, setLoadError] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [gapError, setGapError] = useState("");
  const [corrections, setCorrections] = useState("");
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [saved, setSaved] = useState<TeachbackResult | null>(null);
  const [yodaNote, setYodaNote] = useState("");

  const [openedAt] = useState(() => Date.now());
  const qids = useRef(new Map<string, string>());
  const askedAt = useRef(new Map<string, number>());
  const lastAsked = useRef<string | null>(null);
  const submitting = useRef(false);

  // Load the finish result handed over by the session page, or finish now (a reload of this page).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cached = loadDebrief(id);
        const result = cached ?? (await finishSession(id));
        if (!cached) saveDebrief(id, result);
        if (alive) setData(result);
      } catch (err) {
        if (alive && !(err instanceof ApiError && err.status === 401)) {
          setLoadError(err instanceof ApiError && err.status === 404 ? "This session does not exist, or it is not yours." : err instanceof Error ? err.message : "Could not close the session.");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  const gaps = useMemo(() => sortGaps(data?.gaps ?? []), [data]);
  const steps = useMemo(() => data?.steps ?? [], [data]);
  const answeredIds = useMemo(() => new Set(Object.keys(answers)), [answers]);
  const ready = debriefReady(gaps, answeredIds);
  const need = requiredAnswers(gaps);

  // Refs so the voice tool handlers (created once) always see the latest state.
  const live = useRef({ gaps, answeredIds, steps });
  useEffect(() => {
    live.current = { gaps, answeredIds, steps };
  });
  const captionsRef = useRef<{ who: "yoda" | "expert"; text: string; at: number }[]>([]);
  const suppressRef = useRef<(lines: string[]) => void>(() => undefined);
  const teachbackRef = useRef<(c: string[]) => void>(() => undefined);

  /** Records a gap's question and its answer in the backend (asked first, then the answer). */
  const saveGapAnswer = useCallback(
    async (gap: Gap, quote: string, summary: string, via: Answer["via"]) => {
      const qid = qids.current.get(gap.id) ?? newUuid();
      qids.current.set(gap.id, qid);
      const now = Date.now();
      const t = debriefTimeMs(live.current.steps, openedAt, now);
      await postQuestionAsked(
        id, qid,
        askedBody({ question: gap.text, type: questionTypeForGap(gap.type), anchorEventId: gap.anchor_event_id }, { askedAtMs: t, phase: "debrief", manual: via === "typed" }),
      );
      await postAnswer(id, { question_id: qid, quote, summary, t_ms: t });
      setAnswers((a) => ({ ...a, [gap.id]: { text: summary || quote, via } }));
    },
    [id, openedAt],
  );

  const tools = useMemo<VoiceToolHandlers>(
    () => ({
      log_answer: ({ question_id, summary }) => {
        const { gaps: gs, answeredIds: done } = live.current;
        const gapId = resolveGapId(question_id, gs, done, lastAsked.current);
        const gap = gs.find((g) => g.id === gapId);
        if (!gap) return;
        const since = askedAt.current.get(gap.id) ?? Date.now() - 60_000;
        const lines = expertLinesSince(captionsRef.current, since);
        const quote = pickAnswerQuote(captionsRef.current, since, summary);
        suppressRef.current(lines);
        setGapError("");
        saveGapAnswer(gap, quote, summary || quote, "voice").catch((err) => {
          if (!(err instanceof ApiError && err.status === 401)) setGapError(`Could not save Yoda's note: ${err instanceof Error ? err.message : "failed"}`);
        });
      },
      submit_teachback: ({ confirmed, corrections: c }) => {
        if (!confirmed) {
          setYodaNote("The Master has not confirmed yet. Correct Yoda below or say what is wrong, then confirm.");
          return;
        }
        teachbackRef.current(parseCorrections(c));
      },
    }),
    [saveGapAnswer],
  );
  const convo = useAgentConversation({ sessionId: id, mode: "debrief", tools });
  useEffect(() => {
    captionsRef.current = convo.captions;
  });
  const sync = useCaptureSync({
    sessionId: id, phase: "debrief", captions: convo.captions,
    toSessionMs: (at) => debriefTimeMs(steps, openedAt, at),
  });
  useEffect(() => {
    suppressRef.current = sync.suppress;
  });

  const askGap = useCallback(
    (gap: Gap) => {
      lastAsked.current = gap.id;
      askedAt.current.set(gap.id, Date.now());
      return convo.ask(gap.text);
    },
    [convo],
  );
  const nextOpenGap = gaps.find((g) => !answeredIds.has(g.id));

  const answerSummaries = gaps.filter((g) => answers[g.id]).map((g) => ({ gap: g, summary: answers[g.id].text }));
  const summary = useMemo(() => buildTeachbackSummary(steps, answerSummaries), [steps, answerSummaries]);

  // The voice debrief is opt-in: the session has ended, nothing keeps listening until the Master presses Start.
  // Typing is only the accessibility fallback: when the voice session or the microphone is not available.
  const [typing, setTyping] = useState(false);
  // A connection that hangs (microphone prompt ignored or blocked) also opens the fallback after a while.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (convo.status !== "connecting") return;
    const t = window.setTimeout(() => setStuck(true), 15_000);
    return () => window.clearTimeout(t);
  }, [convo.status]);
  const typingOn = typing || convo.status === "idle" || convo.status === "error" || stuck;

  // Once connected Yoda leads. Real voice: he gets the gaps and the process, and the interviewer prompt makes him
  // ask every gap and then explain it back. Mock voice: a scripted Yoda "speaks" the same things as timed captions.
  const ledRef = useRef(false);
  const askedGapsRef = useRef(new Set<string>());
  const narratedRef = useRef(false);
  useEffect(() => {
    if (convo.status !== "connected" || !data) return;
    if (!convo.mock) {
      if (!ledRef.current) {
        ledRef.current = true;
        convo.sendContext(gapsContext(gaps));
        convo.sendMessage("[START]");
      }
      return;
    }
    if (convo.awaitingAnswer || convo.agentSpeaking) return;
    if (!ready && nextOpenGap && !askedGapsRef.current.has(nextOpenGap.id)) {
      askedGapsRef.current.add(nextOpenGap.id);
      askGap(nextOpenGap);
    } else if (ready && !narratedRef.current && !writing) {
      narratedRef.current = true;
      convo.sendMessage("[EXPLAIN]", summary);
    }
  }, [convo, data, gaps, ready, nextOpenGap, askGap, summary, writing]);

  // Real voice: tell Yoda the process once the gaps are closed, so his teach-back matches the steps.
  const contextSentRef = useRef(false);
  useEffect(() => {
    if (convo.mock || !ready || contextSentRef.current || convo.status !== "connected") return;
    contextSentRef.current = true;
    convo.sendContext(`Process as the Master showed it: ${summary}`.slice(0, 1800));
  }, [convo, ready, summary]);

  /** Teach-back confirmed: write the Holocron and open it. Runs once at a time. */
  const confirm = useCallback(
    async (fixes: string[]) => {
      if (submitting.current) return;
      submitting.current = true;
      setWriting(true);
      setWriteError("");
      try {
        await convo.stop();
        await sync.flush();
        const result = await postTeachback(id, true, fixes);
        clearDebrief(id);
        // Show the name Yoda gave the Holocron for a moment, then open it.
        setSaved(result);
        window.setTimeout(() => router.push(`/dashboard/skills/${encodeURIComponent(result.skill_id)}`), 3500);
      } catch (err) {
        submitting.current = false;
        setWriting(false);
        if (err instanceof ApiError && err.status === 401) return;
        setWriteError(
          err instanceof ApiError && err.status === 409
            ? "Yoda saw nothing in this session, so there is nothing to write. Record something first."
            : err instanceof Error ? err.message : "The Holocron could not be written.",
        );
      }
    },
    [id, router, convo, sync],
  );
  useEffect(() => {
    teachbackRef.current = (c) => void confirm(c);
  });

  async function saveTyped(gap: Gap) {
    const text = (drafts[gap.id] ?? "").trim();
    if (!text) return;
    setSaving(gap.id);
    setGapError("");
    try {
      await saveGapAnswer(gap, text, text, "typed");
      setDrafts((d) => ({ ...d, [gap.id]: "" }));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setGapError(err instanceof Error ? err.message : "Could not save the answer.");
    } finally {
      setSaving(null);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBox>{loadError}</ErrorBox>
        <Link href="/dashboard" className="text-info underline underline-offset-4">Back to overview</Link>
      </div>
    );
  }
  if (!data) return <p className="font-mono text-sm text-muted" role="status">Yoda is sorting what he saw…</p>;

  const answeredCount = gaps.filter((g) => answers[g.id]).length;

  return (
    <div className="space-y-8">
      <div>
        <Link href={`/dashboard/teach/${encodeURIComponent(id)}`} className="font-mono text-xs text-info underline underline-offset-4">&larr; Back to the session</Link>
        <h1 className="mt-3 font-heading text-3xl font-black text-gold">The debrief</h1>
        <p className="mt-1 max-w-2xl text-muted">
          Yoda sorted what he saw into steps. Before he writes the Holocron, he asks what is still unclear, then explains it all back to you.
        </p>
      </div>

      <section aria-label="Done criteria" className="rounded-2xl border border-line bg-surface/80 p-5">
        <Label>Before the Holocron</Label>
        <ul className="mt-2 space-y-1.5">
          <Check ok={steps.length > 0}>{steps.length} {steps.length === 1 ? "step" : "steps"} detected</Check>
          <Check ok={ready}>{answeredCount} of {need} questions answered{gaps.length > need ? ` (${gaps.length} open in all)` : ""}</Check>
          <Check ok={writing}>The Master confirms the teach-back</Check>
        </ul>
      </section>

      <LiveSteps steps={steps} title="The steps Yoda detected" empty="No steps were detected. Record the task again before you debrief." />

      <section aria-labelledby="gaps-h" className="space-y-4">
        <div>
          <h2 id="gaps-h" className="font-heading text-2xl font-black text-gold">What is still unclear</h2>
          <p className="mt-1 text-sm text-muted">
            Yoda asks these out loud, one at a time, and listens. Answer in your own words; the captions show what is said.
          </p>
        </div>

        <YodaVoicePanel
          status={convo.status}
          error={convo.error}
          captions={convo.captions}
          agentSpeaking={convo.agentSpeaking}
          awaitingAnswer={convo.awaitingAnswer}
          micOn={convo.micOn}
          expertSpeaking={false}
          offRecord={false}
          waitingQuestions={gaps.length - answeredCount}
          mock={convo.mock}
          onStart={() => void convo.start()}
          onStop={() => void convo.stop()}
          onMic={convo.setMic}
          onAskYoda={() => nextOpenGap && askGap(nextOpenGap)}
        />

        {gapError && <ErrorBox>{gapError}</ErrorBox>}
        {sync.syncError && <ErrorBox>{sync.syncError}</ErrorBox>}

        {gaps.length === 0 && <p className="rounded-xl border border-dashed border-line p-6 text-muted">Yoda has no open questions. He goes straight to the teach-back.</p>}
        <ul className="space-y-3" aria-label="Open questions">
          {gaps.map((g) => {
            const a = answers[g.id];
            const current = !a && nextOpenGap?.id === g.id;
            return (
              <li key={g.id} data-gap={g.id} data-answered={a ? "true" : "false"} className={`rounded-2xl border p-4 ${a ? "border-jade/50 bg-jade/5" : current ? "border-gold/50 bg-surface/80" : "border-line bg-surface/60"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={a ? "jade" : "gold"}>{GAP_LABEL[g.type]}</Chip>
                  {g.step_idx !== null && <Chip tone="muted">step {g.step_idx}</Chip>}
                  {a && <Chip tone="jade">answered {a.via === "voice" ? "by voice" : "in writing"}</Chip>}
                  {current && !a && <Chip tone="info">next</Chip>}
                </div>
                <p className="mt-2 text-fg">{g.text}</p>
                {a && <p className="mt-2 border-l-2 border-jade/60 pl-3 text-sm text-fg">{a.text}</p>}
                {!a && typingOn && (
                  <div className="mt-3 space-y-2">
                    <label className="block">
                      <span className="sr-only">Your answer to: {g.text}</span>
                      <textarea
                        rows={2}
                        value={drafts[g.id] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [g.id]: e.target.value }))}
                        placeholder="Type your answer…"
                        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-info"
                      />
                    </label>
                    <button type="button" className={btnPrimary} onClick={() => void saveTyped(g)} disabled={saving !== null || !(drafts[g.id] ?? "").trim()}>
                      {saving === g.id ? "Saving…" : "Save answer"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {!typingOn && (
          <p className="text-sm text-muted">
            No microphone or cannot speak?{" "}
            <button type="button" className="text-info underline underline-offset-4" onClick={() => setTyping(true)}>Answer in writing instead</button>
          </p>
        )}
      </section>

      <section aria-labelledby="tb-h" className="space-y-4 rounded-2xl border border-gold/30 bg-surface/90 p-5">
        <div>
          <Label className="!text-gold">Teach-back</Label>
          <h2 id="tb-h" className="font-heading text-2xl font-black text-fg">Yoda explains it back</h2>
        </div>
        {!ready ? (
          <p className="text-sm text-muted" role="status">
            After {need - answeredCount} more {need - answeredCount === 1 ? "answer" : "answers"}, Yoda explains the whole process back to you, aloud.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted" role="status">
              Yoda is explaining the process aloud (captions below). Say &ldquo;yes, exactly&rdquo; or correct him; he writes the Holocron when you confirm.
            </p>
            <blockquote className="border-l-2 border-gold/60 pl-4 text-fg" data-testid="teachback-summary">{summary}</blockquote>
          </>
        )}
        {yodaNote && <p className="rounded-lg border border-gold/30 bg-gold/5 px-3 py-2 text-sm text-fg">{yodaNote}</p>}

        {ready && convo.mock && convo.status === "connected" && !writing && (
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              convo.simulateExpertLine("(simulated) Yes, exactly.");
              void confirm(parseCorrections(corrections));
            }}
          >
            Simulate the Master saying &ldquo;yes, exactly&rdquo;
          </button>
        )}

        {ready && typingOn && (
          <>
            <label className="block">
              <Label>Something wrong or missing? One correction per line (optional)</Label>
              <textarea
                rows={3}
                value={corrections}
                onChange={(e) => setCorrections(e.target.value)}
                placeholder="Hold applies to every supplier who double-bills in December"
                className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-info"
              />
            </label>
            <button type="button" className={btnPrimary} onClick={() => void confirm(parseCorrections(corrections))} disabled={writing}>
              {parseCorrections(corrections).length ? "Yes, with these corrections" : "Yes, exactly"}
            </button>
          </>
        )}
        {writing && !saved && <p className="font-mono text-xs text-gold" role="status">Yoda is writing the Holocron… this can take up to 30 seconds.</p>}
        {saved && (
          <div className="space-y-2 rounded-xl border border-jade/50 bg-jade/10 p-4" role="status" data-testid="holocron-saved">
            <Label className="!text-jade">Holocron saved as a draft</Label>
            <h3 className="font-heading text-xl font-black text-gold">{saved.title}</h3>
            {saved.description && <p className="text-sm text-fg">{saved.description}</p>}
            {saved.summary && saved.summary !== saved.description && <p className="text-sm text-muted">{saved.summary}</p>}
            <Link href={`/dashboard/skills/${encodeURIComponent(saved.skill_id)}`} className={btnPrimary}>Open the Holocron</Link>
          </div>
        )}
        {writeError && (
          <div className="space-y-2">
            <ErrorBox>{writeError}</ErrorBox>
            <p className="text-sm text-muted">Nothing was saved.</p>
            <button type="button" className={btnPrimary} onClick={() => void confirm(parseCorrections(corrections))}>Try again</button>
          </div>
        )}
      </section>
    </div>
  );
}
