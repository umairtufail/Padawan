"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getSession, sendFrame, type PadawanEvent, type SessionDetail } from "../../../../lib/api";
import type { CapturedFramePayload } from "../../../../lib/frame-delivery";
import ScreenCapture from "../../../screen-capture";
import { Chip, ErrorBox, Label } from "../../../../components/ui";

const POLL_MS = 3000;
const MAX_WIDTH = 1024;
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
  const [sent, setSent] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState("");

  const inFlight = useRef(false);
  const startedAt = useRef<number | null>(null);

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const onFrame = useCallback(
    async (payload: CapturedFramePayload) => {
      // One request in flight: drop new frames while the previous one is analysed.
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const now = Date.now();
        if (startedAt.current === null) startedAt.current = now;
        const jpeg = await downscale(payload.blob);
        const res = await sendFrame(id, now - startedAt.current, jpeg);
        setSent((n) => n + 1);
        setLastLatency(res.latency_ms);
        // A skipped frame is normal (backend busy, slow model, ...): just carry on.
        if (res.skipped) setSkipped((n) => n + 1);
        setUploadError("");
        void refresh();
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) {
          setUploadError(err instanceof Error ? err.message : "Could not send the frame.");
        }
      } finally {
        inFlight.current = false;
      }
    },
    [id, refresh],
  );

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

      <section aria-labelledby="screen" className="rounded-2xl border border-jade/30 bg-surface/90 p-5">
        <Label className="!text-jade">What Yoda sees now</Label>
        <h2 id="screen" className="sr-only">Latest screen summary</h2>
        <p className="mt-2 text-lg text-fg">
          {session ? session.last_screen_summary || "Nothing yet. Share your screen to start teaching." : "…"}
        </p>
      </section>

      <section aria-labelledby="share">
        <h2 id="share" className="font-heading text-2xl font-black text-gold">Share your screen</h2>
        <p className="mt-1 text-sm text-muted">
          Frames are sent straight from your browser to the backend, only when the screen changes.
        </p>
        <div className="mt-3 flex flex-wrap gap-2" role="status">
          <Chip tone="info">frames sent: {sent}</Chip>
          <Chip tone="info">skipped by backend: {skipped}</Chip>
          {lastLatency !== null && <Chip tone="jade">last analysis: {lastLatency} ms</Chip>}
        </div>
        {uploadError && <div className="mt-3"><ErrorBox>{uploadError}</ErrorBox></div>}
        <div className="mt-4 overflow-hidden rounded-2xl">
          <ScreenCapture embedded onFrame={onFrame} />
        </div>
      </section>

      <section aria-labelledby="events">
        <h2 id="events" className="font-heading text-2xl font-black text-gold">Events</h2>
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
