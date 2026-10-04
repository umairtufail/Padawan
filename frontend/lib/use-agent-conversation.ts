"use client";

import { cleanCaption } from "./captions";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation } from "@elevenlabs/client";
import { MOCK, startVoiceSession, type VoiceMode } from "./api";

export type AgentStatus = "idle" | "connecting" | "connected" | "error";

export type Caption = { id: number; who: "yoda" | "expert"; text: string; at: number };

export type ToolEvent = { id: number; name: string; args: Record<string, unknown>; at: number };

/** What the page does when Yoda calls a client tool (see backend/scripts/setup_voice_agents.py). */
export type VoiceToolHandlers = {
  log_answer?: (a: { question_id?: string; summary: string }) => void;
  set_off_record?: (a: { on: boolean }) => void;
  submit_teachback?: (a: { confirmed: boolean; corrections?: string }) => void;
  /** Return a sentence saying whether the prediction was right. */
  record_prediction?: (a: { step_idx: number; predicted: string }) => string | Promise<string>;
  show_replay?: (a: { step_idx: number }) => void;
  finish_learning?: () => void;
};

type Options = {
  sessionId: string;
  mode: VoiceMode;
  tools?: VoiceToolHandlers;
  /** Called after Yoda's answer was logged or the wait for an answer ran out. */
  onAnswerWindowClosed?: () => void;
};

/** How long Yoda waits for an answer before the mic goes back to muted. */
export const ANSWER_WAIT_MS = 30_000;
const MAX_CAPTIONS = 60;

/**
 * Debrief and tutor are open-mic conversations. Capture is app-driven: Yoda hears the Master for the whole answer
 * window of a question (until log_answer or the timeout), so narration while working never reaches him.
 * Pauses, final transcripts and Yoda speaking do not close the mic; echo is left to the browser's echo cancellation.
 */
export function micShouldBeOpen(mode: VoiceMode, awaitingCaptureAnswer: boolean): boolean {
  return mode === "capture" ? awaitingCaptureAnswer : true;
}

/** Scripted answers of the mock expert, one per question asked. */
const MOCK_ANSWERS = [
  "Because the cost center must match the asset class, equipment over five thousand is always capex.",
  "I stop and ask the controller when there is no asset number, we never book capex without one.",
  "In December some suppliers bill twice, so I hold those and compare before posting.",
  "A new colleague usually forgets to check the purchase order for the asset number.",
];
/** Messages that start with a bracket are our own commands ([ASK], [START]...), not words of the expert. */
const isCommand = (t: string) => /^\s*\[[A-Z_]+\]/.test(t);

/**
 * One conversation with Yoda: start with the signed URL from the backend, captions of both sides, mic mute,
 * contextual updates, `[ASK] ...` messages and the client tools. With NEXT_PUBLIC_API_MOCK=1 no ElevenLabs is
 * involved: a scripted Yoda answers `ask` so the whole page can be tested without a microphone.
 */
export function useAgentConversation({ sessionId, mode, tools, onAnswerWindowClosed }: Options) {
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState("");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [micOn, setMicOnState] = useState(false);
  const [awaitingAnswer, setAwaitingAnswer] = useState(false);

  const conv = useRef<Conversation | null>(null);
  const toolsRef = useRef(tools);
  const closedRef = useRef(onAnswerWindowClosed);
  const seq = useRef(0);
  const timers = useRef(new Set<number>());
  const answerTimer = useRef<number | null>(null);
  const awaitingAnswerRef = useRef(false);
  const userMutedRef = useRef(false);
  const alive = useRef(true);
  const mockAnswerIdx = useRef(0);

  useEffect(() => {
    toolsRef.current = tools;
    closedRef.current = onAnswerWindowClosed;
  }, [tools, onAnswerWindowClosed]);

  const later = useCallback((fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      if (alive.current) fn();
    }, ms);
    timers.current.add(t);
    return t;
  }, []);

  const addCaption = useCallback((who: Caption["who"], text: string) => {
    if (!text.trim()) return;
    setCaptions((prev) => [...prev, { id: ++seq.current, who, text: text.trim(), at: Date.now() }].slice(-MAX_CAPTIONS));
  }, []);

  const logTool = useCallback((name: string, args: Record<string, unknown>) => {
    setToolEvents((prev) => [...prev, { id: ++seq.current, name, args, at: Date.now() }].slice(-30));
  }, []);

  const applyMic = useCallback((on: boolean) => {
    setMicOnState(on);
    // Real conversation: muted means nothing is sent to Yoda.
    conv.current?.setMicMuted(!on);
  }, []);

  const syncMic = useCallback(() => {
    applyMic(!userMutedRef.current && micShouldBeOpen(mode, awaitingAnswerRef.current));
  }, [applyMic, mode]);

  /** The person's mute button. It always wins: muted stays muted until they unmute. */
  const setMic = useCallback(
    (on: boolean) => {
      userMutedRef.current = !on;
      applyMic(on);
    },
    [applyMic],
  );

  const closeAnswerWindow = useCallback(() => {
    if (answerTimer.current !== null) {
      window.clearTimeout(answerTimer.current);
      timers.current.delete(answerTimer.current);
      answerTimer.current = null;
    }
    setAwaitingAnswer(false);
    awaitingAnswerRef.current = false;
    syncMic();
    closedRef.current?.();
  }, [syncMic]);

  /** Runs a client tool call (from ElevenLabs or from the mock). */
  const runTool = useCallback(
    (name: string, args: Record<string, unknown>): string | Promise<string> | void => {
      logTool(name, args);
      const t = toolsRef.current ?? {};
      switch (name) {
        case "log_answer":
          t.log_answer?.({ question_id: args.question_id as string | undefined, summary: String(args.summary ?? "") });
          closeAnswerWindow();
          return;
        case "set_off_record":
          t.set_off_record?.({ on: args.on === true });
          return;
        case "submit_teachback":
          t.submit_teachback?.({ confirmed: args.confirmed === true, corrections: args.corrections as string | undefined });
          return;
        case "record_prediction":
          return t.record_prediction?.({ step_idx: Number(args.step_idx ?? 0), predicted: String(args.predicted ?? "") }) ?? "Noted.";
        case "show_replay":
          t.show_replay?.({ step_idx: Number(args.step_idx ?? 0) });
          return;
        case "finish_learning":
          t.finish_learning?.();
          return;
        default:
          return;
      }
    },
    [logTool, closeAnswerWindow],
  );

  const stop = useCallback(async () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current.clear();
    answerTimer.current = null;
    const c = conv.current;
    conv.current = null;
    awaitingAnswerRef.current = false;
    userMutedRef.current = false;
    setAgentSpeaking(false);
    setAwaitingAnswer(false);
    setMicOnState(false);
    setStatus("idle");
    try {
      await c?.endSession();
    } catch {
      /* already closed */
    }
  }, []);

  const start = useCallback(async () => {
    if (status === "connecting" || status === "connected") return;
    setError("");
    setStatus("connecting");
    try {
      const vs = await startVoiceSession(sessionId, mode);
      if (!alive.current) return;
      if (MOCK) {
        setStatus("connected");
        if (mode !== "tutor") {
          addCaption("yoda", mode === "debrief"
            ? "Mock mode: Yoda is ready for the debrief. Ask him the open questions one by one."
            : "Mock mode: Yoda is listening and stays silent until he is asked something.");
        }
        return;
      }
      const { Conversation } = await import("@elevenlabs/client");
      // @elevenlabs/client's web input requests echo cancellation, noise suppression, automatic gain control,
      // mono audio and voice isolation; the agent also filters background voices (setup_voice_agents.py).
      const c = await Conversation.startSession({
        signedUrl: vs.signed_url,
        dynamicVariables: vs.dynamic_variables,
        clientTools: {
          log_answer: (a: Record<string, unknown>) => runTool("log_answer", a),
          set_off_record: (a: Record<string, unknown>) => runTool("set_off_record", a),
          submit_teachback: (a: Record<string, unknown>) => runTool("submit_teachback", a),
          record_prediction: (a: Record<string, unknown>) => runTool("record_prediction", a),
          show_replay: (a: Record<string, unknown>) => runTool("show_replay", a),
          finish_learning: (a: Record<string, unknown>) => runTool("finish_learning", a),
        },
        onMessage: ({ role, message }) => {
          if (role === "agent") addCaption("yoda", cleanCaption(message));
          else if (!isCommand(message)) addCaption("expert", message);
        },
        onModeChange: ({ mode: m }) => setAgentSpeaking(m === "speaking"),
        onStatusChange: ({ status: s }) => {
          if (s === "disconnected") {
            conv.current = null;
            setStatus("idle");
            setAgentSpeaking(false);
            setMicOnState(false);
          }
        },
        onError: (message) => {
          setError(typeof message === "string" ? message : "Yoda's voice connection failed.");
        },
      });
      if (!alive.current) {
        await c.endSession();
        return;
      }
      conv.current = c;
      syncMic();
      setStatus("connected");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not start the conversation with Yoda.");
    }
  }, [status, sessionId, mode, addCaption, runTool, syncMic]);

  /** Short screen context. Does not make Yoda speak. */
  const sendContext = useCallback((text: string) => {
    if (!text) return;
    conv.current?.sendContextualUpdate(text);
  }, []);

  const openAnswerWindow = useCallback(() => {
    setAwaitingAnswer(true);
    awaitingAnswerRef.current = true;
    syncMic();
    if (answerTimer.current !== null) window.clearTimeout(answerTimer.current);
    answerTimer.current = later(closeAnswerWindow, ANSWER_WAIT_MS);
  }, [syncMic, later, closeAnswerWindow]);

  /** Make Yoda ask `question` aloud and open the mic for the answer. */
  const ask = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q) return false;
      if (status !== "connected") return false;
      openAnswerWindow();

      if (MOCK) {
        // A scripted Yoda: speaks the question, then a simulated expert answer is logged.
        later(() => {
          setAgentSpeaking(true);
          addCaption("yoda", q);
        }, 400);
        later(() => setAgentSpeaking(false), 3200);
        const answer = MOCK_ANSWERS[mockAnswerIdx.current++ % MOCK_ANSWERS.length];
        later(() => addCaption("expert", `(simulated answer) ${answer}`), 5200);
        later(() => {
          addCaption("yoda", "Got it.");
          runTool("log_answer", { question_id: "", summary: answer });
        }, 6500);
      } else {
        conv.current?.sendUserMessage(`[ASK] ${q}`);
      }
      return true;
    },
    [status, openAnswerWindow, later, addCaption, runTool],
  );

  /** The person seems away: Yoda asks once whether they are still there, and the mic opens for the reply. */
  const checkIn = useCallback(() => {
    if (status !== "connected") return false;
    openAnswerWindow();
    if (MOCK) {
      later(() => {
        setAgentSpeaking(true);
        addCaption("yoda", "Are you still there?");
      }, 300);
      later(() => setAgentSpeaking(false), 2000);
    } else {
      conv.current?.sendUserMessage("[CHECKIN]");
    }
    return true;
  }, [status, openAnswerWindow, later, addCaption]);

  /**
   * A plain command to Yoda (for example "[START]" in debrief mode). With mock voice there is no agent: `mockSpeech`
   * is what a scripted Yoda says instead, so the screen can be tested without ElevenLabs.
   */
  /** Mock voice only: the Master "says" a line (a caption, like a transcribed utterance). */
  const simulateExpertLine = useCallback((text: string) => addCaption("expert", text), [addCaption]);

  const sendMessage = useCallback(
    (command: string, mockSpeech?: string) => {
      if (status !== "connected") return false;
      if (MOCK) {
        if (mockSpeech) {
          later(() => {
            setAgentSpeaking(true);
            addCaption("yoda", mockSpeech);
          }, 300);
          later(() => setAgentSpeaking(false), 3000);
        }
        return true;
      }
      conv.current?.sendUserMessage(command);
      return true;
    },
    [status, later, addCaption],
  );

  /**
   * Makes Yoda say something by voice: `command` is the user message the tutor prompt understands ([START], [STEP],
   * [INTERVENE]...). In mock mode a scripted Yoda "speaks" `mockSay` (captions only ever show what is said) and may
   * then call a client tool, so the learn flow can be run without ElevenLabs.
   */
  const tell = useCallback(
    (command: string, mockSay?: { text: string; tool?: { name: string; args: Record<string, unknown>; afterMs?: number } }) => {
      if (status !== "connected") return false;
      if (!MOCK) {
        conv.current?.sendUserMessage(command);
        return true;
      }
      if (!mockSay) return true;
      const speakMs = Math.min(6000, 600 + mockSay.text.split(/\s+/).length * 220);
      later(() => {
        setAgentSpeaking(true);
        addCaption("yoda", mockSay.text);
      }, 300);
      later(() => setAgentSpeaking(false), 300 + speakMs);
      const tool = mockSay.tool;
      if (tool) later(() => void runTool(tool.name, tool.args), 300 + speakMs + (tool.afterMs ?? 1200));
      return true;
    },
    [status, later, addCaption, runTool],
  );

  useEffect(() => {
    alive.current = true;
    const pending = timers.current;
    return () => {
      alive.current = false;
      pending.forEach((t) => window.clearTimeout(t));
      pending.clear();
      void conv.current?.endSession().catch(() => undefined);
      conv.current = null;
    };
  }, []);

  return {
    status, error, captions, toolEvents, agentSpeaking, micOn, awaitingAnswer,
    start, stop, setMic, sendContext, ask, checkIn, sendMessage, simulateExpertLine, tell,
    /** Mock mode only: lets the page type a fake expert line. */
    mock: MOCK,
  };
}
