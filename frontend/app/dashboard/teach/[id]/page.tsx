"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getSession, type FrameResponse, type PadawanEvent, type SessionDetail } from "../../../../lib/api";
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
import { Chip, ErrorBox, Label } from "../../../../components/ui";

const POLL_MS = 3000;

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
  const { items, push, counts, lastLatency } = useFrameBuffer(id, { onSettled: () => void refresh(), onResponse: forwardResponse });

  const [offRecord, setOffRecord] = useState(false);
  const offRecordRef = useRef(false);
  const [answers, setAnswers] = useState<string[]>([]);
  const tools = useMemo<VoiceToolHandlers>(
    () => ({
      log_answer: ({ summary }) => setAnswers((a) => [...a, summary]),
      set_off_record: ({ on }) => setOffRecord(on),
    }),
    [],
  );
  const convo = useAgentConversation({ sessionId: id, mode: "capture", tools });
  const speech = useExpertSpeech(convo.status === "connected", convo.mock);
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
  });
  useEffect(() => {
    frameResponseRef.current = pause.onFrameResponse;
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

      <ScreenCapture
        embedded
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
