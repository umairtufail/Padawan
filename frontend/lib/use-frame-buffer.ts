"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, sendFrame, type FrameResponse, type PadawanEvent } from "./api";
import type { CapturedFramePayload, ChangeRegion } from "./frame-delivery";

export type FrameStatus = "queued" | "sending" | "analyzed" | "skipped" | "failed" | "dropped";

/** One captured image on the timeline, with what the model said about it once it comes back. */
export type TimelineItem = {
  id: string;
  /** The moment the screen was captured (not when it was uploaded). */
  takenAt: Date;
  /** Milliseconds since the first frame of this recording. */
  tMs: number;
  reason: "initial" | "change";
  changedPercent: number;
  region: ChangeRegion | null;
  thumbUrl: string;
  width: number;
  height: number;
  bytes: number;
  status: FrameStatus;
  latencyMs: number | null;
  /** Events the model reported for this frame. */
  events: PadawanEvent[];
  /** The model's one-sentence description of the whole screen at this moment. */
  summary: string;
  /** Why it was skipped, dropped or failed. */
  note: string;
};

type Options = {
  /** At most this many frames wait to be sent; the oldest waiting ones are dropped beyond it. */
  maxBuffered?: number;
  /** Timeline length; the oldest finished frames fall off. */
  maxItems?: number;
  /** Called after every frame has been handled (to refresh the session). */
  onSettled?: () => void;
  /** Called with every analysed frame response (question candidates, events, screen summary). */
  onResponse?: (res: FrameResponse) => void;
};

const MAX_WIDTH = 1024;
/** The first look is what gives Yoda his starting picture: if the model is slow or busy, try it again. */
const INITIAL_RETRIES = 2;
const TRANSIENT = new Set(["timeout", "busy", "vision_error", "parse_error", "storage_error"]);
const JPEG_QUALITY = 0.6;

/** Downscale to ~1024 px wide JPEG q0.6 so frames stay around 80-150 KB (backend limit is 4 MB). */
async function downscale(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare a canvas to downscale the frame.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the frame."))), "image/jpeg", JPEG_QUALITY),
  );
}

/**
 * The frame buffer: captured images wait in order (oldest first), are sent one at a time to the backend
 * (which analyses one frame at a time), and every item keeps its capture time and the model's description.
 * `items` is oldest first.
 */
export function useFrameBuffer(sessionId: string, { maxBuffered = 6, maxItems = 80, onSettled, onResponse }: Options = {}) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const queue = useRef<string[]>([]);
  const blobs = useRef(new Map<string, Blob>());
  const busy = useRef(false);
  const mounted = useRef(true);
  const startedAt = useRef<number | null>(null);
  const settledRef = useRef(onSettled);
  const urls = useRef(new Set<string>());
  const attempts = useRef(new Map<string, number>());
  const reasons = useRef(new Map<string, "initial" | "change">());

  const responseRef = useRef(onResponse);

  useEffect(() => {
    settledRef.current = onSettled;
    responseRef.current = onResponse;
  }, [onSettled, onResponse]);

  const patch = useCallback((id: string, change: Partial<TimelineItem>) => {
    if (!mounted.current) return;
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...change } : it)));
  }, []);

  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      let id = queue.current.shift();
      while (id && mounted.current) {
        const blob = blobs.current.get(id);
        const takenAtMs = Number(id.split(":")[0]);
        if (blob) {
          patch(id, { status: "sending" });
          try {
            const jpeg = await downscale(blob);
            const tMs = Math.max(0, takenAtMs - (startedAt.current ?? takenAtMs));
            const res = await sendFrame(sessionId, tMs, jpeg);
            const tries = (attempts.current.get(id) ?? 0) + 1;
            attempts.current.set(id, tries);
            if (res.skipped && reasons.current.get(id) === "initial" && TRANSIENT.has(res.skipped) && tries <= INITIAL_RETRIES) {
              // Keep the image and go again from the front of the queue.
              patch(id, { status: "queued", note: `The model was ${res.skipped === "timeout" ? "slow" : "busy"}, retrying the first look (${tries}/${INITIAL_RETRIES})…` });
              queue.current.unshift(id);
            } else if (res.skipped) {
              blobs.current.delete(id);
              patch(id, { status: "skipped", latencyMs: res.latency_ms, note: `Not analysed (${res.skipped.replace("_", " ")}), the next frame will catch up.` });
            } else {
              blobs.current.delete(id);
              patch(id, { status: "analyzed", latencyMs: res.latency_ms, events: res.events, summary: res.screen_summary, note: "" });
              try {
                responseRef.current?.(res);
              } catch {
                /* a listener must never break the stream */
              }
            }
          } catch (err) {
            blobs.current.delete(id);
            // A 401 signs the user out inside the API client; anything else is shown on the frame.
            if (!(err instanceof ApiError && err.status === 401)) {
              patch(id, { status: "failed", note: err instanceof Error ? err.message : "Could not send the frame." });
            }
          }
          settledRef.current?.();
        }
        id = queue.current.shift();
      }
    } finally {
      busy.current = false;
    }
  }, [patch, sessionId]);

  const push = useCallback(
    (payload: CapturedFramePayload) => {
      const takenAt = new Date(payload.capturedAt);
      const ms = takenAt.getTime();
      if (startedAt.current === null) startedAt.current = ms;
      const id = `${ms}:${Math.random().toString(36).slice(2, 8)}`;
      const thumbUrl = URL.createObjectURL(payload.blob);
      urls.current.add(thumbUrl);
      blobs.current.set(id, payload.blob);
      reasons.current.set(id, payload.reason ?? "change");
      queue.current.push(id);

      const item: TimelineItem = {
        id, takenAt, tMs: Math.max(0, ms - startedAt.current), reason: payload.reason ?? "change",
        changedPercent: payload.changedPixelRatio * 100, region: payload.region ?? null,
        thumbUrl, width: payload.width, height: payload.height, bytes: payload.blob.size,
        status: "queued", latencyMs: null, events: [], summary: "", note: "",
      };

      // Buffer full: the oldest waiting frames are dropped, the newest ones matter most.
      const dropped: string[] = [];
      while (queue.current.length > maxBuffered) {
        const old = queue.current.shift();
        if (old) {
          dropped.push(old);
          blobs.current.delete(old);
        }
      }

      setItems((prev) => {
        let next = prev.map((it) => (dropped.includes(it.id) ? { ...it, status: "dropped" as const, note: "Buffer was full, a newer frame replaced it." } : it));
        next = [...next, item];
        // Cap the timeline: forget the oldest frames that are finished.
        while (next.length > maxItems) {
          const idx = next.findIndex((it) => it.status !== "queued" && it.status !== "sending");
          if (idx === -1) break;
          URL.revokeObjectURL(next[idx].thumbUrl);
          urls.current.delete(next[idx].thumbUrl);
          next = next.filter((_, i) => i !== idx);
        }
        return next;
      });
      void pump();
    },
    [maxBuffered, maxItems, pump],
  );

  useEffect(() => {
    mounted.current = true;
    const knownUrls = urls.current;
    return () => {
      mounted.current = false;
      knownUrls.forEach((u) => URL.revokeObjectURL(u));
      knownUrls.clear();
    };
  }, []);

  const counts = {
    captured: items.length,
    queued: items.filter((i) => i.status === "queued" || i.status === "sending").length,
    analyzed: items.filter((i) => i.status === "analyzed").length,
    skipped: items.filter((i) => i.status === "skipped").length,
    failed: items.filter((i) => i.status === "failed").length,
    dropped: items.filter((i) => i.status === "dropped").length,
  };
  const latencies = items.filter((i) => i.latencyMs !== null).map((i) => i.latencyMs as number);
  const lastLatency = latencies.length ? latencies[latencies.length - 1] : null;

  /** ms epoch of the first frame (the session clock starts there), or null before it. */
  const startedAtMs = useCallback(() => startedAt.current, []);

  return { items, push, counts, lastLatency, startedAtMs };
}
