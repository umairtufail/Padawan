"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FrameResponse } from "./api";
import {
  DEFAULT_PRESENCE_CONFIG, PauseController, presenceAction,
  type Check, type PauseConfig, type PresenceConfig, type QuestionCandidate,
} from "./pause-controller";
import { curiosityQuestion, questionsForResponse, screenUpdateText, UpdateThrottle } from "./question-source";

export type TraceEntry = {
  id: number;
  at: number;
  kind: "ask" | "manual" | "skip" | "queued" | "context" | "presence";
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
  /** Yoda asks whether the person is still there; returns false if he could not. */
  checkIn?: () => boolean;
  /** Nothing happened after the check-in either: end the voice session (capture goes on). */
  rest?: () => void;
  config?: Partial<PauseConfig>;
  presence?: Partial<PresenceConfig>;
};

const TICK_MS = 500;
/** With nothing queued, a curious Yoda asks his own question after the screen has been quiet this long. */
const CURIOUS_IDLE_MS = 5000;
/** After the first question, a curious one is only allowed after this long and after this many new events: it must matter. */
const CURIOUS_GAP_MS = 90_000;
const CURIOUS_MIN_EVENTS = 3;
const MAX_TRACE = 40;

/**
 * Connects the pure PauseController to the page: collects questions from frame responses, checks every half second
 * whether this is a natural pause, asks when it is, and records a "why now" trace for every decision.
 */
export function usePauseController(inputs: Inputs) {
  const [controller] = useState(() => new PauseController(inputs.config));
  const [presenceConfig] = useState(() => ({ ...DEFAULT_PRESENCE_CONFIG, ...inputs.presence }));
  const connectedAt = useRef<number | null>(null);
  const checkedInAt = useRef<number | null>(null);
  const latest = useRef(inputs);
  const throttle = useRef(new UpdateThrottle(2000));
  const seq = useRef(0);
  const lastSignature = useRef("");
  const [pending, setPending] = useState<QuestionCandidate[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [asked, setAsked] = useState(0);
  const curious = useRef(0);
  const eventsSince = useRef(0);
  const lastAskTs = useRef<number | null>(null);

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
      eventsSince.current += res.events.length;
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
      // Interactive apprentice, but only when it matters: one opening question after the first changes, then a curious
      // one only after a long quiet stretch with several new events. Real changes (salient events) queue their own.
      if (decision.kind === "wait" && decision.blockers.length === 1 && decision.blockers[0] === "candidate") {
        const idle = s.lastFrameChangeAt === null ? 0 : now - s.lastFrameChangeAt;
        const first = lastAskTs.current === null && eventsSince.current >= 1;
        const later = lastAskTs.current !== null && now - lastAskTs.current >= CURIOUS_GAP_MS && eventsSince.current >= CURIOUS_MIN_EVENTS;
        if (idle >= CURIOUS_IDLE_MS && (first || later)) {
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
          lastAskTs.current = now;
          eventsSince.current = 0;
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

      // Presence: only a still screen and no speech for minutes means "away". Yoda checks in once, then rests.
      if (!s.connected) {
        connectedAt.current = null;
        checkedInAt.current = null;
      } else if (connectedAt.current === null) {
        connectedAt.current = now;
      }
      if (decision.kind === "ask" || connectedAt.current === null) return;
      const lastActivityAt = Math.max(s.lastFrameChangeAt ?? 0, s.lastExpertSpeechAt ?? 0, connectedAt.current);
      if (checkedInAt.current !== null && lastActivityAt > checkedInAt.current) {
        checkedInAt.current = null;
        log("presence", "The Master is back.");
      }
      const action = presenceAction(now, {
        lastActivityAt,
        checkedInAt: checkedInAt.current,
        connected: s.connected,
        agentSpeaking: s.agentSpeaking,
        awaitingAnswer: s.awaitingAnswer,
        offRecord: s.offRecord,
      }, presenceConfig);
      if (action === "check_in" && s.checkIn?.()) {
        checkedInAt.current = now;
        log("presence", "Nothing moved and nobody spoke for a while: Yoda checks in.");
      } else if (action === "rest") {
        checkedInAt.current = null;
        log("presence", "No reply to the check-in: Yoda rests. Capture goes on.");
        s.rest?.();
      }
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [log, controller, presenceConfig]);

  /** The "Ask Yoda" button: ask now, ignoring the pause rules (the person decided). Uses the best waiting question. */
  const askNow = useCallback(
    (fallback: string) => {
      const now = Date.now();
      const next = controller.pending(now)[0];
      const candidate: QuestionCandidate =
        next ?? { id: `manual-${now}`, question: fallback, priority: 0, source: "manual", queuedAt: now };
      if (!latest.current.ask(candidate.question)) return false;
      controller.recordAsk(candidate, now, true);
      lastAskTs.current = now;
      eventsSince.current = 0;
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
