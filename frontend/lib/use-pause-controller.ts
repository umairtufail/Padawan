"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FrameResponse } from "./api";
import { PauseController, type Check, type PauseConfig, type QuestionCandidate } from "./pause-controller";
import { curiosityQuestion, questionsForResponse, screenUpdateText, UpdateThrottle } from "./question-source";

export type TraceEntry = {
  id: number;
  at: number;
  kind: "ask" | "manual" | "skip" | "queued" | "context";
  text: string;
  /** The rules as they were at that moment (for "why now"). */
  checks?: Check[];
};

type Inputs = {
  /** When the screen last changed, from the frame timeline (ms epoch), or null. */
  lastFrameChangeAt: number | null;
  expertSpeaking: boolean;
  lastExpertSpeechAt: number | null;
  connected: boolean;
  agentSpeaking: boolean;
  awaitingAnswer: boolean;
  offRecord: boolean;
  /** Sends `[ASK] question` to Yoda; returns false if it could not. */
  ask: (question: string) => boolean;
  sendContext: (text: string) => void;
  /** Called after a question was sent to Yoda (report it to the backend). `checks` is the "why now" trace. */
  onAsked?: (candidate: QuestionCandidate, info: { manual: boolean; checks?: Check[] }) => void;
  config?: Partial<PauseConfig>;
};

const TICK_MS = 500;
/** With nothing queued, a curious Yoda asks his own question after the screen has been quiet this long. */
const CURIOUS_IDLE_MS = 5000;
const MAX_TRACE = 40;

/**
 * Connects the pure PauseController to the page: collects questions from frame responses, checks every half second
 * whether this is a natural pause, asks when it is, and records a "why now" trace for every decision.
 */
export function usePauseController(inputs: Inputs) {
  const [controller] = useState(() => new PauseController(inputs.config));
  const latest = useRef(inputs);
  const throttle = useRef(new UpdateThrottle(2000));
  const seq = useRef(0);
  const lastSignature = useRef("");
  const [pending, setPending] = useState<QuestionCandidate[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [asked, setAsked] = useState(0);
  const curious = useRef(0);

  useEffect(() => {
    latest.current = inputs;
  });

  const log = useCallback((kind: TraceEntry["kind"], text: string, entryChecks?: Check[]) => {
    setTrace((prev) => [{ id: ++seq.current, at: Date.now(), kind, text, checks: entryChecks }, ...prev].slice(0, MAX_TRACE));
  }, []);

  /** Feed every analysed frame response here. */
  const onFrameResponse = useCallback(
    (res: FrameResponse) => {
      const now = Date.now();
      for (const q of questionsForResponse(res)) {
        if (controller.enqueue({ ...q }, now)) log("queued", `Queued (${q.source}): ${q.question}`);
      }
      setPending(controller.pending(now));
      if (res.events.length > 0 && latest.current.connected) {
        const text = screenUpdateText(res.screen_summary || res.events[res.events.length - 1].summary);
        if (text && throttle.current.take(now)) {
          latest.current.sendContext(text);
          log("context", text);
        }
      }
    },
    [log, controller],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const s = latest.current;
      const decision = controller.evaluate(now, {
        lastFrameChangeAt: s.lastFrameChangeAt,
        expertSpeaking: s.expertSpeaking,
        lastExpertSpeechAt: s.lastExpertSpeechAt,
        agentSpeaking: s.agentSpeaking,
        awaitingAnswer: s.awaitingAnswer,
        connected: s.connected,
        offRecord: s.offRecord,
      });
      setChecks(decision.checks);
      setPending(controller.pending(now));
      // Interactive apprentice: when only "no question waiting" blocks him, ask his own curious question.
      if (decision.kind === "wait" && decision.blockers.length === 1 && decision.blockers[0] === "candidate") {
        const idle = s.lastFrameChangeAt === null ? 0 : now - s.lastFrameChangeAt;
        if (idle >= CURIOUS_IDLE_MS) {
          const q = curiosityQuestion(curious.current++);
          controller.enqueue({ id: `curious-${now}`, question: q, priority: -2, source: "stub", type: "reason", anchorEventId: null }, now);
          log("queued", `Queued (curious): ${q}`);
          setPending(controller.pending(now));
        }
      }
      if (decision.kind === "ask") {
        const c = decision.candidate;
        if (s.ask(c.question)) {
          controller.recordAsk(c, now);
          lastSignature.current = "";
          setAsked((n) => n + 1);
          log("ask", `Asked now: ${c.question}`, decision.checks);
          try {
            s.onAsked?.(c, { manual: false, checks: decision.checks });
          } catch {
            /* reporting must never break the conversation */
          }
          setPending(controller.pending(now));
        }
      } else if (controller.pending(now).length > 0) {
        // Only explain a wait when something is waiting, and only when the reason changed.
        const sig = decision.blockers.join(",");
        if (sig !== lastSignature.current) {
          lastSignature.current = sig;
          const why = decision.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ");
          log("skip", `Waiting: ${why}`, decision.checks);
        }
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [log, controller]);

  /** The "Ask Yoda" button: ask now, ignoring the pause rules (the person decided). Uses the best waiting question. */
  const askNow = useCallback(
    (fallback: string) => {
      const now = Date.now();
      const next = controller.pending(now)[0];
      const candidate: QuestionCandidate =
        next ?? { id: `manual-${now}`, question: fallback, priority: 0, source: "manual", queuedAt: now };
      if (!latest.current.ask(candidate.question)) return false;
      controller.recordAsk(candidate, now, true);
      setAsked((n) => n + 1);
      log("manual", `Asked on request: ${candidate.question}`);
      try {
        latest.current.onAsked?.(candidate, { manual: true });
      } catch {
        /* reporting must never break the conversation */
      }
      setPending(controller.pending(now));
      return true;
    },
    [log, controller],
  );

  return { pending, trace, checks, asked, onFrameResponse, askNow, config: controller.config };
}
