"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 120;
/** Root-mean-square level (0..1) above which the expert counts as talking. */
const LEVEL = 0.03;
/** Short gaps between words do not end "talking". */
const HANGOVER_MS = 400;

export type ExpertSpeech = {
  speaking: boolean;
  /** Last time speech was heard (ms epoch), or null. */
  lastSpeechAt: number | null;
  /** Mock mode: pretend the expert talks for a while. */
  simulate: (ms: number) => void;
  error: string;
};

/**
 * Is the expert talking? Listens to the microphone locally (an analyser, nothing is sent anywhere), so it also works
 * while the mic to Yoda is muted. In mock mode there is no microphone: `simulate` drives the same signal.
 */
export function useExpertSpeech(enabled: boolean, mock: boolean): ExpertSpeech {
  const [speaking, setSpeaking] = useState(false);
  const [lastSpeechAt, setLastSpeechAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const timers = useRef<number[]>([]);

  const mark = useCallback((on: boolean) => {
    setSpeaking(on);
    if (on) setLastSpeechAt(Date.now());
  }, []);

  useEffect(() => {
    if (!enabled || mock || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let poll: number | undefined;
    let lastLoud = 0;
    let wasOn = false;

    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        poll = window.setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const now = Date.now();
          if (Math.sqrt(sum / buf.length) > LEVEL) lastLoud = now;
          const on = now - lastLoud < HANGOVER_MS;
          if (on !== wasOn || on) {
            wasOn = on;
            mark(on);
          }
        }, POLL_MS);
      })
      .catch(() => {
        if (!cancelled) setError("Microphone not available, so Yoda cannot tell when you are talking.");
      });

    return () => {
      cancelled = true;
      if (poll) window.clearInterval(poll);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      setSpeaking(false);
    };
  }, [enabled, mock, mark]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const simulate = useCallback(
    (ms: number) => {
      mark(true);
      const keepAlive = window.setInterval(() => mark(true), 500);
      const stop = window.setTimeout(() => {
        window.clearInterval(keepAlive);
        setSpeaking(false);
      }, ms);
      timers.current.push(stop);
    },
    [mark],
  );

  return { speaking, lastSpeechAt, simulate, error };
}
