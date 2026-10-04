"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ScreenCapture from "../app/screen-capture";
import type { FrameResponse } from "../lib/api";
import type { CapturedFramePayload } from "../lib/frame-delivery";
import {
  applyVerdict, initialLearnState, interventionMessage, predictionSentence, replayForStep, reportMessage, shouldAnnounceStep,
  stepById, stepMessage, warnMessage,
  type LearnFrameResponse, type LearnSessionOut, type MasteryReport, type PredictionNote, type VerdictEffect,
} from "../lib/learn";
import { finishLearning, recordPrediction, sendLearnFrame } from "../lib/learn-api";
import { asksPrediction, mockReportSpeech, mockStepSpeech, mockStopSpeech, mockWarnSpeech } from "../lib/learn-script";
import { useAgentConversation, type VoiceToolHandlers } from "../lib/use-agent-conversation";
import { useFrameBuffer } from "../lib/use-frame-buffer";
import InterventionBanner from "./intervention-banner";
import LearnSteps from "./learn-steps";
import LearnVoicePanel from "./learn-voice-panel";
import MasteryReportView from "./mastery-report";
import ReplayDrawer from "./replay-drawer";
import { btnPrimary, Chip, ErrorBox, Label } from "./ui";

type Props = {
  session: LearnSessionOut;
  /** The live screen share the Start button asked for (a user gesture is needed for getDisplayMedia). */
  stream: MediaStream;
  onAgain: () => void;
};

type Replay = { stepIdx: number; momentMs: number; text: string };

/** The learn screen: the Padawan works, Yoda tutors by voice, verdicts stop or warn, the report ends it. */
export default function LearnSession({ session, stream, onAgain }: Props) {
  const sid = session.session_id;
  const skill = session.skill;

  const [learn, setLearn] = useState(() => initialLearnState(session.current_step_idx));
  const learnRef = useRef(learn);
  const [predictions, setPredictions] = useState<Record<number, PredictionNote>>({});
  const [replay, setReplay] = useState<Replay | null>(null);
  const [report, setReport] = useState<MasteryReport | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");
  const finishedRef = useRef(false);

  // Verdicts arrive from the frame buffer; the side effect (Yoda speaks) is run through a ref, set below.
  const effectRef = useRef<(e: VerdictEffect) => void>(() => undefined);
  const onResponse = useCallback((res: FrameResponse) => {
    const out = applyVerdict(learnRef.current, (res as LearnFrameResponse).verdict ?? null);
    learnRef.current = out.state;
    setLearn(out.state);
    if (out.effect) effectRef.current(out.effect);
  }, []);
  const { items, push, counts, lastLatency } = useFrameBuffer(sid, { onResponse, send: sendLearnFrame });

  const pushFrame = useCallback(
    (payload: CapturedFramePayload) => {
      if (!finishedRef.current) push(payload);
    },
    [push],
  );

  const openReplay = useCallback(
    (stepIdx: number) => {
      const found = replayForStep(skill, stepIdx);
      if (!found) return;
      const fromVerdict = learnRef.current.banner?.verdict.replay;
      const m = fromVerdict && fromVerdict.step_idx === stepIdx ? fromVerdict : found.moment;
      setReplay({ stepIdx, momentMs: m.t_ms, text: m.description });
    },
    [skill],
  );

  const finishRef = useRef<(speak: boolean) => Promise<void>>(async () => undefined);
  const tools = useMemo<VoiceToolHandlers>(
    () => ({
      record_prediction: async ({ step_idx, predicted }) => {
        try {
          const out = await recordPrediction(sid, step_idx, predicted);
          if (!out.result) return "Noted.";
          const r = out.result;
          setPredictions((p) => ({ ...p, [step_idx]: { predicted: r.predicted, correct: r.correct, expected: r.expected } }));
          return predictionSentence(r);
        } catch {
          return "Noted.";
        }
      },
      show_replay: ({ step_idx }) => openReplay(step_idx),
      finish_learning: () => void finishRef.current(false),
    }),
    [sid, openReplay],
  );
  const convo = useAgentConversation({ sessionId: sid, mode: "tutor", tools });

  useEffect(() => {
    effectRef.current = (e) => {
      if (!e) return;
      if (e.type === "stop") convo.tell(interventionMessage(e.verdict), mockStopSpeech(e.verdict));
      else convo.tell(warnMessage(e.verdict), mockWarnSpeech(e.verdict));
    };
    finishRef.current = async (speak) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setFinishing(true);
      setError("");
      try {
        const r = await finishLearning(sid);
        setReport(r);
        setReplay(null);
        if (speak) convo.tell(reportMessage(r), mockReportSpeech(r));
        else void convo.stop();
      } catch (err) {
        finishedRef.current = false;
        setError(err instanceof Error ? err.message : "Could not finish the lesson.");
      } finally {
        setFinishing(false);
      }
    };
  });

  // Yoda's voice starts on its own: the person just pressed Start, so the browser allows audio and the microphone.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || convo.status !== "idle") return;
    autoStarted.current = true;
    void convo.start();
  }, [convo]);

  // The Padawan talks back (predictions are spoken), so the microphone opens once Yoda is there.
  const micOpened = useRef(false);
  useEffect(() => {
    if (convo.status !== "connected" || micOpened.current) return;
    micOpened.current = true;
    convo.setMic(true);
  }, [convo.status, convo]);

  // Yoda teaches every step aloud and asks what the Padawan expects (not while a stop is being handled).
  const announced = useRef<number | null>(null);
  const asked = useRef(0);
  useEffect(() => {
    if (convo.status !== "connected" || learn.banner?.kind === "stop") return;
    if (!shouldAnnounceStep(announced.current, learn.stepIdx)) return;
    const step = stepById(skill, learn.stepIdx);
    if (!step) return;
    const first = announced.current === null;
    announced.current = learn.stepIdx;
    const n = asked.current;
    if (asksPrediction(step)) asked.current += 1;
    convo.tell(stepMessage(step, first), mockStepSpeech(step, first, n));
  }, [convo, learn.stepIdx, learn.banner, skill]);

  const dismissBanner = useCallback(() => {
    learnRef.current = { ...learnRef.current, banner: null };
    setLearn(learnRef.current);
  }, []);

  const lastSummary = [...items].reverse().find((i) => i.status === "analyzed")?.summary ?? "";
  const replayStep = replay ? stepById(skill, replay.stepIdx) : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/dashboard/skills" className="font-mono text-xs text-info underline underline-offset-4">&larr; Jedi Archives</Link>
          <h1 className="mt-3 font-heading text-3xl font-black text-gold">{skill.title}</h1>
          <p className="mt-1 font-mono text-xs text-muted">Learning with the Master {skill.author.name}&apos;s Holocron</p>
        </div>
        {!report && (
          <button type="button" className={btnPrimary} onClick={() => void finishRef.current(true)} disabled={finishing}>
            {finishing ? "Reading your report…" : "Finish the lesson"}
          </button>
        )}
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {!report && learn.banner && (
        <div className="sticky top-2 z-30">
          <InterventionBanner banner={learn.banner} speaking={convo.agentSpeaking} onReplay={openReplay} onDismiss={dismissBanner} />
        </div>
      )}

      {report ? (
        <>
          <MasteryReportView report={report} onAgain={onAgain} />
          <LearnVoicePanel
            status={convo.status} error={convo.error} captions={convo.captions} agentSpeaking={convo.agentSpeaking} micOn={convo.micOn}
            mock={convo.mock} onStart={() => void convo.start()} onStop={() => void convo.stop()} onMic={convo.setMic}
          />
        </>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-6 lg:col-start-2 lg:row-start-1">
            <LearnSteps steps={skill.steps} state={learn} predictions={predictions} />
            <section aria-labelledby="learn-sees" className="rounded-2xl border border-jade/30 bg-surface/90 p-5">
              <Label className="!text-jade">What Yoda sees now</Label>
              <h2 id="learn-sees" className="sr-only">Latest screen summary</h2>
              <p className="mt-2 text-fg">{lastSummary || "Nothing yet. The first look arrives a few seconds after the lesson starts."}</p>
            </section>
          </div>
          <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
            <LearnVoicePanel
              status={convo.status} error={convo.error} captions={convo.captions} agentSpeaking={convo.agentSpeaking} micOn={convo.micOn}
              mock={convo.mock} onStart={() => void convo.start()} onStop={() => void convo.stop()} onMic={convo.setMic}
            />
            <ScreenCapture
              embedded
              onStopped={() => void convo.stop()}
              showCaptures={false}
              initialStream={stream}
              onFrame={pushFrame}
              stats={
                <>
                  <Chip tone="info">{counts.captured} captured</Chip>
                  <Chip tone="jade">{counts.analyzed} analysed</Chip>
                  {counts.queued > 0 && <Chip tone="gold">{counts.queued} in buffer</Chip>}
                  {lastLatency !== null && <Chip tone="muted">{lastLatency} ms</Chip>}
                </>
              }
            />
          </div>
        </div>
      )}

      {replay && replayStep && (
        <ReplayDrawer step={replayStep} momentMs={replay.momentMs} momentText={replay.text} onClose={() => setReplay(null)} />
      )}
    </div>
  );
}
