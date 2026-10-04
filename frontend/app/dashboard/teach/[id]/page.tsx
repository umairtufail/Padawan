"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, finishSession, getSession, getSteps, MOCK, setOffTheRecord,
  type FrameResponse, type PadawanEvent, type SessionDetail, type StepDraft,
} from "../../../../lib/api";
import { saveDebrief } from "../../../../lib/debrief-handoff";
import { useCaptureSync } from "../../../../lib/use-capture-sync";
import LiveSteps from "../../../../components/live-steps";
import MockScreenButton from "../../../../components/mock-screen-button";
import type { CapturedFramePayload } from "../../../../lib/frame-delivery";
import { useAgentConversation, type VoiceToolHandlers } from "../../../../lib/use-agent-conversation";
import { useExpertSpeech } from "../../../../lib/use-expert-speech";
import { usePauseController } from "../../../../lib/use-pause-controller";
import YodaVoicePanel from "../../../../components/yoda-voice-panel";
import WhyNowPanel from "../../../../components/why-now-panel";
import { peekStream, releaseStream } from "../../../../lib/capture-handoff";
import { useFrameBuffer } from "../../../../lib/use-frame-buffer";
import ScreenCapture from "../../../screen-capture";
import FrameTimeline from "../../../../components/frame-timeline";
import { btnPrimary, Chip, ErrorBox, Label } from "../../../../components/ui";

const POLL_MS = 3000;
const STEPS_POLL_MS = 4000;

function EventCard({ ev }: { ev: PadawanEvent }) {
  const entities = Object.entries(ev.entities ?? {});
  return (
    <li
      className={`rounded-xl border p-4 ${ev.salient ? "border-gold/60 bg-gold/5" : "border-line bg-surface/80"}`}
      data-salient={ev.salient ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={ev.salient ? "gold" : "info"}>{ev.kind}</Chip>
        {ev.salient && <Chip tone="gold">salient</Chip>}
        {typeof ev.t_ms === "number" && <span className="font-mono text-xs text-muted">{(ev.t_ms / 1000).toFixed(1)}s</span>}
      </div>
      <p className="mt-2 text-fg">{ev.summary}</p>
      {entities.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {entities.map(([k, v]) => (
            <span key={k} className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted">
              {k}: <span className="text-fg">{String(v)}</span>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

export default function TeachSessionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  // The live screen share started by the "Start" button on the previous page, if we arrived from there.
  const [initialStream] = useState(() => peekStream(id));

  const refresh = useCallback(async () => {
    try {
      const s = await getSession(id);
      setSession(s);
      setError("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else if (!(err instanceof ApiError && err.status === 401)) setError(err instanceof Error ? err.message : "Could not load the session.");
    }
  }, [id]);

  // Yoda's voice: the frame buffer reports analysed frames through a stable forwarder (the pause controller is created below).
  const frameResponseRef = useRef<((res: FrameResponse) => void) | null>(null);
  const forwardResponse = useCallback((res: FrameResponse) => frameResponseRef.current?.(res), []);
  const { items, push, counts, lastLatency, startedAtMs } = useFrameBuffer(id, { onSettled: () => void refresh(), onResponse: forwardResponse });
  const countsRef = useRef(counts);
  useEffect(() => {
    countsRef.current = counts;
  });

  // Live steps: GET /steps every few seconds, and at once when a frame response says the open step changed.
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [stepHint, setStepHint] = useState<{ idx: number; title: string } | null>(null);
  const refreshSteps = useCallback(async () => {
    try {
      setSteps(await getSteps(id));
    } catch {
      /* steps are a nice-to-have while recording; the debrief loads them again */
    }
  }, [id]);

  const [offRecord, setOffRecord] = useState(false);
  const offRecordRef = useRef(false);
  const [answers, setAnswers] = useState<string[]>([]);
  const answerRef = useRef<((a: { question_id?: string; summary: string }) => Promise<string | null>) | null>(null);
  const tools = useMemo<VoiceToolHandlers>(
    () => ({
      log_answer: ({ question_id, summary }) => {
        setAnswers((a) => [...a, summary]);
        void answerRef.current?.({ question_id, summary });
      },
      set_off_record: ({ on }) => {
        setOffRecord(on);
        void setOffTheRecord(id, on).catch(() => undefined);
      },
    }),
    [id],
  );
  const convo = useAgentConversation({ sessionId: id, mode: "capture", tools });
  const [clockBase] = useState(() => Date.now());
  const toSessionMs = useCallback((at: number) => Math.max(0, at - (startedAtMs() ?? clockBase)), [startedAtMs, clockBase]);
  const sync = useCaptureSync({ sessionId: id, phase: "live", captions: convo.captions, offRecord, toSessionMs });
  useEffect(() => {
    answerRef.current = sync.onAnswer;
  });
  const speech = useExpertSpeech(convo.status === "connected", convo.mock);
  // Yoda talks by voice from the first second: the person just clicked Start, so the browser allows audio and the mic.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !initialStream || convo.status !== "idle") return;
    autoStarted.current = true;
    void convo.start();
  }, [initialStream, convo]);
  const lastFrameChangeAt = items.length ? items[items.length - 1].takenAt.getTime() : null;
  const pause = usePauseController({
    lastFrameChangeAt,
    expertSpeaking: speech.speaking,
    lastExpertSpeechAt: speech.lastSpeechAt,
    connected: convo.status === "connected",
    agentSpeaking: convo.agentSpeaking,
    awaitingAnswer: convo.awaitingAnswer,
    offRecord,
    ask: convo.ask,
    sendContext: convo.sendContext,
    onAsked: sync.onAsked,
  });
  useEffect(() => {
    frameResponseRef.current = (res) => {
      pause.onFrameResponse(res);
      const u = res.step_update;
      if (u) {
        setStepHint((prev) => {
          if (!prev || prev.idx !== u.idx || prev.title !== u.title) void refreshSteps();
          return { idx: u.idx, title: u.title };
        });
      }
    };
    offRecordRef.current = offRecord;
  });
  // Off the record: frames are not sent while the Master asked Yoda to pause the capture.
  const pushFrame = useCallback(
    (payload: CapturedFramePayload) => {
      if (!offRecordRef.current) push(payload);
    },
    [push],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void refreshSteps();
    const timer = window.setInterval(() => void refreshSteps(), STEPS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshSteps]);

  // Finish: stop Yoda, let the last frames and transcript lines land, close the steps, then go to the debrief.
  const [finishing, setFinishing] = useState("");
  const [finishError, setFinishError] = useState("");
  async function onFinish() {
    setFinishError("");
    try {
      setFinishing("Sending the last moments to Yoda…");
      await convo.stop();
      for (let i = 0; i < 20 && countsRef.current.queued > 0; i++) await new Promise((r) => setTimeout(r, 500));
      await sync.flush();
      setFinishing("Yoda is sorting the steps…");
      const result = await finishSession(id);
      saveDebrief(id, result);
      router.push(`/dashboard/teach/${encodeURIComponent(id)}/debrief`);
    } catch (err) {
      setFinishing("");
      if (!(err instanceof ApiError && err.status === 401)) {
        setFinishError(err instanceof Error ? err.message : "Could not finish the session.");
      }
    }
  }

  useEffect(() => () => releaseStream(id), [id]);

  if (notFound) {
    return (
      <div className="space-y-4">
        <ErrorBox>Session not found. It may belong to someone else or no longer exist.</ErrorBox>
        <Link href="/dashboard" className="text-info underline underline-offset-4">Back to overview</Link>
      </div>
    );
  }

  const events = session ? [...session.events].reverse() : [];

  return (
    <div className="space-y-8">
      <div>
        <Link href="/dashboard" className="font-mono text-xs text-info underline underline-offset-4">&larr; Overview</Link>
        <h1 className="mt-3 font-heading text-3xl font-black text-gold">{session ? session.title : "Loading session…"}</h1>
        {session && <p className="mt-1 font-mono text-xs text-muted">Session {session.session_id} · {session.events_count} events</p>}
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gold/30 bg-surface/90 p-4" data-testid="finish-bar">
        <div className="min-w-0 flex-1 basis-60">
          <p className="font-semibold text-fg">Done with the task?</p>
          <p className="text-sm text-muted">Yoda sorts what he saw into steps, then asks what is still unclear before he writes the Holocron.</p>
        </div>
        {MOCK && <MockScreenButton onFrame={pushFrame} />}
        <button type="button" className={btnPrimary} onClick={() => void onFinish()} disabled={finishing !== ""}>
          {finishing || "Finish session"}
        </button>
      </div>
      {finishError && <ErrorBox>{finishError}</ErrorBox>}
      {sync.syncError && <ErrorBox>{sync.syncError}</ErrorBox>}

      <ScreenCapture
        embedded
        onStopped={() => void convo.stop()}
        showCaptures={false}
        initialStream={initialStream}
        onFrame={pushFrame}
        stats={
          <>
            <Chip tone="info">{counts.captured} captured</Chip>
            <Chip tone="jade">{counts.analyzed} analysed</Chip>
            {counts.queued > 0 && <Chip tone="gold">{counts.queued} in buffer</Chip>}
            {counts.skipped + counts.dropped + counts.failed > 0 && <Chip tone="muted">{counts.skipped + counts.dropped + counts.failed} not analysed</Chip>}
            {lastLatency !== null && <Chip tone="muted">{lastLatency} ms</Chip>}
          </>
        }
      />

      <YodaVoicePanel
        status={convo.status}
        error={convo.error || speech.error}
        captions={convo.captions}
        agentSpeaking={convo.agentSpeaking}
        awaitingAnswer={convo.awaitingAnswer}
        micOn={convo.micOn}
        expertSpeaking={speech.speaking}
        offRecord={offRecord}
        waitingQuestions={pause.pending.length}
        mock={convo.mock}
        onStart={() => void convo.start()}
        onStop={() => void convo.stop()}
        onMic={convo.setMic}
        onAskYoda={() => pause.askNow(session?.last_screen_summary ? "Why did you do that last step?" : "What are you doing right now, and why?")}
        onSimulateSpeech={() => speech.simulate(4000)}
      />

      <LiveSteps steps={steps} current={stepHint} />

      {answers.length > 0 && (
        <section aria-labelledby="answers" className="rounded-2xl border border-gold/30 bg-surface/90 p-5">
          <Label className="!text-gold">What Yoda learned</Label>
          <h2 id="answers" className="sr-only">Answers logged by Yoda</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-fg">
            {answers.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </section>
      )}

      <section aria-labelledby="screen" className="rounded-2xl border border-jade/30 bg-surface/90 p-5">
        <Label className="!text-jade">What Yoda sees now</Label>
        <h2 id="screen" className="sr-only">Latest screen summary</h2>
        <p className="mt-2 text-lg text-fg">
          {session ? session.last_screen_summary || "Nothing yet. The first look arrives a few seconds after recording starts." : "…"}
        </p>
      </section>

      <WhyNowPanel
        checks={pause.checks}
        pending={pause.pending}
        trace={pause.trace}
        tools={convo.toolEvents}
        asked={pause.asked}
        budgetMax={pause.config.maxPerWindow}
      />

      <FrameTimeline items={items} />

      <section aria-labelledby="events">
        <h2 id="events" className="font-heading text-2xl font-black text-gold">All events</h2>
        <p className="mt-1 text-sm text-muted">Everything Yoda reported in this session, newest first.</p>
        <div className="mt-4">
          {session && events.length === 0 && (
            <p className="rounded-xl border border-dashed border-line p-6 text-muted">No events yet. Yoda is waiting for the screen to change.</p>
          )}
          {events.length > 0 && (
            <ul className="space-y-3">
              {events.map((ev) => <EventCard key={ev.id} ev={ev} />)}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
