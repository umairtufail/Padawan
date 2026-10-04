"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, postAnswer, postQuestionAsked, postUtterances } from "./api";
import {
  askedBody, expertLinesSince, newUuid, pickAnswerQuote, questionIdFor, resolveQuestionId, speakerFor, UtteranceQueue,
  type CaptionLike,
} from "./capture-sync";
import type { Check, QuestionCandidate } from "./pause-controller";

const FLUSH_MS = 4000;

type Options = {
  sessionId: string;
  phase: "live" | "debrief";
  captions: (CaptionLike & { id: number })[];
  /** While true the expert's lines are not stored (off the record). */
  offRecord?: boolean;
  /** Milliseconds on the session clock for a wall-clock time (ms epoch). */
  toSessionMs: (at: number) => number;
};

/**
 * Sends the live conversation to the backend pipeline: transcript lines in batches (utterances), the questions Yoda
 * asked (with their "why now" trace) and the expert's answers. Errors are shown, never thrown: the session carries on.
 */
export function useCaptureSync({ sessionId, phase, captions, offRecord = false, toSessionMs }: Options) {
  const [syncError, setSyncError] = useState("");
  const queue = useRef(new UtteranceQueue());
  const seen = useRef(0);
  const captionsRef = useRef(captions);
  const offRef = useRef(offRecord);
  const toMsRef = useRef(toSessionMs);
  const known = useRef(new Set<string>());
  const open = useRef<{ id: string; askedAt: number } | null>(null);
  const recorded = useRef(new Map<string, Promise<boolean>>());
  const flushing = useRef<Promise<void> | null>(null);

  useEffect(() => {
    captionsRef.current = captions;
    offRef.current = offRecord;
    toMsRef.current = toSessionMs;
  });

  const fail = useCallback((err: unknown, what: string) => {
    if (err instanceof ApiError && err.status === 401) return; // the API client sends you to /login
    setSyncError(`${what}: ${err instanceof Error ? err.message : "failed"}`);
  }, []);

  // New captions become transcript lines.
  useEffect(() => {
    for (const c of captions) {
      if (c.id <= seen.current) continue;
      seen.current = c.id;
      if (c.who === "expert" && offRef.current) continue;
      queue.current.add({ t_ms: toMsRef.current(c.at), speaker: speakerFor(c.who), text: c.text });
    }
  }, [captions]);

  const flushOnce = useCallback(async () => {
    const batch = queue.current.take();
    if (batch.length === 0) return;
    try {
      await postUtterances(sessionId, batch);
    } catch (err) {
      queue.current.putBack(batch);
      fail(err, "Could not save the transcript");
      throw err;
    }
  }, [sessionId, fail]);

  /** Sends everything waiting. Safe to call often; one send at a time. */
  const flush = useCallback(async () => {
    if (flushing.current) {
      await flushing.current.catch(() => undefined);
    }
    const run = (async () => {
      while (queue.current.size > 0) await flushOnce();
    })();
    flushing.current = run;
    try {
      await run;
    } catch {
      /* already reported */
    } finally {
      if (flushing.current === run) flushing.current = null;
    }
  }, [flushOnce]);

  useEffect(() => {
    const timer = window.setInterval(() => void flush(), FLUSH_MS);
    return () => window.clearInterval(timer);
  }, [flush]);

  /** Report a question Yoda was just told to ask. */
  const onAsked = useCallback(
    (c: QuestionCandidate, info: { manual: boolean; checks?: Check[] }) => {
      const id = questionIdFor(c.id, newUuid);
      const askedAt = Date.now();
      known.current.add(id);
      open.current = { id, askedAt };
      const body = askedBody(
        { question: c.question, type: c.type, anchorEventId: c.anchorEventId },
        { askedAtMs: toMsRef.current(askedAt), phase, manual: info.manual, checks: info.checks },
      );
      const p = postQuestionAsked(sessionId, id, body).then(
        () => true,
        (err) => {
          fail(err, "Could not record the question");
          return false;
        },
      );
      recorded.current.set(id, p);
    },
    [sessionId, phase, fail],
  );

  /** The interviewer's `log_answer` tool. Returns the question id it was stored against, or null. */
  const onAnswer = useCallback(
    async (a: { question_id?: string; summary: string }): Promise<string | null> => {
      const id = resolveQuestionId(a.question_id, known.current, open.current?.id ?? null);
      if (!id) return null;
      const askedAt = open.current?.id === id ? open.current.askedAt : Date.now() - 60_000;
      const lines = expertLinesSince(captionsRef.current, askedAt);
      const quote = pickAnswerQuote(captionsRef.current, askedAt, a.summary);
      lines.forEach((l) => queue.current.suppress(l));
      if (open.current?.id === id) open.current = null;
      if (!(await (recorded.current.get(id) ?? Promise.resolve(false)))) return null;
      try {
        await postAnswer(sessionId, { question_id: id, quote, summary: a.summary, t_ms: toMsRef.current(Date.now()) });
        return id;
      } catch (err) {
        fail(err, "Could not save the answer");
        return null;
      }
    },
    [sessionId, fail],
  );

  /** Lines that were stored another way (an answer quote) must not be sent again. */
  const suppress = useCallback((lines: string[]) => lines.forEach((l) => queue.current.suppress(l)), []);

  return { onAsked, onAnswer, flush, suppress, syncError, clearSyncError: () => setSyncError("") };
}
