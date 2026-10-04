"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { deliverCapturedFrame, type CapturedFramePayload } from "../lib/frame-delivery";
import { ChangeDetector, type DetectorDecision, type FrameDiffResult } from "../lib/frame-diff";
import YodaFigure from "../components/yoda-figure";
import { btnGhost, btnPrimary, Chip, Label } from "../components/ui";

type CaptureStatus = "idle" | "requesting" | "sharing" | "stopped" | "error";

type DisplayMediaOptionsWithSelfExclusion = Omit<DisplayMediaStreamOptions, "video"> & {
  selfBrowserSurface?: "include" | "exclude";
  // `cursor` is part of the spec but missing from the DOM typings. "never" keeps the mouse pointer out of the
  // stream, so a moving cursor never looks like a change on the screen.
  video: MediaTrackConstraints & { cursor?: "always" | "motion" | "never" };
};

type MediaTrackSettingsWithSurface = MediaTrackSettings & {
  displaySurface?: "browser" | "window" | "monitor";
};

type Capture = {
  id: string;
  url: string;
  capturedAt: Date;
  changedPercent: number;
  reason: "initial" | "change";
  width: number;
  height: number;
  bytes: number;
};

// The screen is compared on a small copy. 640x360 is big enough to see a changed field value on a 1080p
// screen and small enough to compare a few times a second (a 32x18 grid of 20 px blocks).
const COMPARISON_WIDTH = 640;
const COMPARISON_HEIGHT = 360;
const COMPARISON_BLOCK = 20;

function formatBytes(bytes: number) {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatElapsed(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

const REASON_TEXT: Record<FrameDiffResult["reason"], string> = {
  none: "no change",
  "large-area": "large area changed",
  "local-cluster": "local edit",
  scattered: "several spots changed",
  "strong-block": "strong local change",
};

function MonitorIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true" width="18" height="18">
      <rect x="3" y="4" width="18" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8.5 21h7M12 17v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" width="16" height="16">
      <rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}

type ScreenCaptureProps = {
  /** Called with each changed frame. Defaults to deliverCapturedFrame (console log). */
  onFrame?: (payload: CapturedFramePayload) => Promise<void> | void;
  /**
   * A screen share that is already running (started by the "Start" button on the previous page).
   * Recording begins immediately with it, no second permission prompt.
   */
  initialStream?: MediaStream | null;
  /** Compact spacing and collapsed settings, for when it sits inside the session page. */
  embedded?: boolean;
  /** Extra chips in the header (frame counters, latency). */
  stats?: ReactNode;
  /** Show the strip of captured thumbnails under the recorder. The session page shows a richer timeline instead. */
  showCaptures?: boolean;
  /** Called when the person stops recording (button) or the browser ends the share. Not called when the page unmounts. */
  onStopped?: () => void;
};

export default function ScreenCapture({ onFrame, initialStream = null, embedded = false, stats, showCaptures = true, onStopped }: ScreenCaptureProps = {}) {
  const onFrameRef = useRef(onFrame);
  const onStoppedRef = useRef(onStopped);
  useEffect(() => {
    onFrameRef.current = onFrame;
    onStoppedRef.current = onStopped;
  }, [onFrame, onStopped]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const comparisonCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<ChangeDetector | null>(null);
  const captureInFlightRef = useRef(false);
  const objectUrlsRef = useRef<string[]>([]);
  const attachedRef = useRef(false);
  const stopTimerRef = useRef<number | null>(null);

  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [sourceName, setSourceName] = useState("No source selected");
  const [frameThreshold, setFrameThreshold] = useState(3);
  const [pixelThreshold, setPixelThreshold] = useState(25);
  const [sampleRate, setSampleRate] = useState(2);
  const [smallEdits, setSmallEdits] = useState(true);
  const [diff, setDiff] = useState<FrameDiffResult | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [baselineReady, setBaselineReady] = useState(false);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [captureSafeMode, setCaptureSafeMode] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // The sliders can change while recording; the detector reads the latest values on every sample.
  const optionsRef = useRef({ pixelThreshold, frameThreshold, smallEdits });
  useEffect(() => {
    optionsRef.current = { pixelThreshold, frameThreshold, smallEdits };
  }, [pixelThreshold, frameThreshold, smallEdits]);

  const stopSharing = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());

    if (videoRef.current) videoRef.current.srcObject = null;
    detectorRef.current?.reset();
    captureInFlightRef.current = false;
    setBaselineReady(false);
    setDiff(null);
    setWaiting(false);
    setElapsed(0);
    setSourceName("No source selected");
    setCaptureSafeMode(false);
    setStatus("stopped");
    onStoppedRef.current?.();
  }, []);

  /** Starts monitoring a stream (from the picker below, or handed over by the Start button). */
  const attachStream = useCallback(
    async (stream: MediaStream) => {
      const videoTrack = stream.getVideoTracks()[0];
      const displaySurface = (videoTrack?.getSettings() as MediaTrackSettingsWithSurface | undefined)?.displaySurface;

      // Unknown surface types use the safe fallback. The browser may ignore the
      // selfBrowserSurface hint, so only a confirmed browser-tab capture shows
      // its live preview and capture gallery while monitoring.
      setCaptureSafeMode(displaySurface !== "browser");

      streamRef.current = stream;
      detectorRef.current = new ChangeDetector({
        width: COMPARISON_WIDTH,
        height: COMPARISON_HEIGHT,
        blockSize: COMPARISON_BLOCK,
        pixelTolerance: optionsRef.current.pixelThreshold,
        areaThresholdPercent: optionsRef.current.frameThreshold,
        detectSmallEdits: optionsRef.current.smallEdits,
      });
      captureInFlightRef.current = false;
      setBaselineReady(false);
      setDiff(null);
      setWaiting(false);
      setElapsed(0);
      // Chrome labels a shared tab with an internal id ("web-contents-media-stream://..."): show something readable.
      const rawLabel = videoTrack?.label ?? "";
      const readable = rawLabel && !rawLabel.startsWith("web-contents-media-stream") ? rawLabel : "";
      setSourceName(
        readable ||
          (displaySurface === "browser" ? "A browser tab" : displaySurface === "window" ? "An app window" : displaySurface === "monitor" ? "Your screen" : "Shared screen"),
      );

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      videoTrack?.addEventListener("ended", stopSharing, { once: true });
      setStatus("sharing");
    },
    [stopSharing],
  );

  const startSharing = useCallback(async () => {
    setErrorMessage("");

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus("error");
      setErrorMessage("Screen sharing is not supported in this browser.");
      return;
    }

    setStatus("requesting");

    try {
      const displayMediaOptions: DisplayMediaOptionsWithSelfExclusion = {
        video: { frameRate: { ideal: 15, max: 30 }, cursor: "never" },
        audio: false,
        selfBrowserSurface: "exclude",
      };
      const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
      await attachStream(stream);
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCaptureSafeMode(false);
      const wasCancelled = error instanceof DOMException && error.name === "NotAllowedError";
      setStatus(wasCancelled ? "idle" : "error");
      if (!wasCancelled) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to start screen sharing.");
      }
    }
  }, [attachStream]);

  // A stream handed over by the Start button: begin recording at once.
  useEffect(() => {
    if (stopTimerRef.current !== null) {
      // React strict mode unmounts and remounts once in development: keep the stream alive across it.
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (!initialStream || attachedRef.current) return;
    attachedRef.current = true;
    if (!initialStream.active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reporting that the handed-over share already ended
      setErrorMessage("The screen share ended before the session opened. Press start to share again.");
      return;
    }
    attachStream(initialStream).catch((error: unknown) => {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Unable to start screen sharing.");
    });
  }, [initialStream, attachStream]);

  const captureFrame = useCallback(async (decision: DetectorDecision) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight || captureInFlightRef.current) return;

    captureInFlightRef.current = true;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The browser could not prepare a capture canvas.");

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("The frame could not be encoded."))),
          "image/jpeg",
          0.88,
        );
      });

      const capturedAt = new Date();
      const reason = decision.reason ?? "change";
      const changedPercent = decision.diff?.changedPercent ?? 0;
      const box = decision.diff?.bbox ?? null;

      if (showCaptures) {
        const url = URL.createObjectURL(blob);
        objectUrlsRef.current.push(url);
        const capture: Capture = {
          id: crypto.randomUUID(), url, capturedAt, changedPercent, reason,
          width: canvas.width, height: canvas.height, bytes: blob.size,
        };
        setCaptures((current) => [capture, ...current]);
      }

      await (onFrameRef.current ?? deliverCapturedFrame)({
        blob,
        capturedAt: capturedAt.toISOString(),
        changedPixelRatio: changedPercent / 100,
        width: canvas.width,
        height: canvas.height,
        reason,
        region: box
          ? { x: box.x / COMPARISON_WIDTH, y: box.y / COMPARISON_HEIGHT, w: box.w / COMPARISON_WIDTH, h: box.h / COMPARISON_HEIGHT }
          : null,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to capture the changed frame.");
    } finally {
      captureInFlightRef.current = false;
    }
  }, [showCaptures]);

  // The comparison loop: look at a small copy of the screen a few times a second and let the detector decide.
  useEffect(() => {
    if (status !== "sharing") return;

    const compareFrame = () => {
      const video = videoRef.current;
      const canvas = comparisonCanvasRef.current;
      const detector = detectorRef.current;
      if (!video || !canvas || !detector || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;

      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;

      context.drawImage(video, 0, 0, COMPARISON_WIDTH, COMPARISON_HEIGHT);
      const pixels = context.getImageData(0, 0, COMPARISON_WIDTH, COMPARISON_HEIGHT).data;

      const { pixelThreshold: tolerance, frameThreshold: area, smallEdits: small } = optionsRef.current;
      detector.setOptions({ pixelTolerance: tolerance, areaThresholdPercent: area, detectSmallEdits: small });
      const decision = detector.sample(pixels, performance.now());

      setBaselineReady(true);
      setDiff(decision.diff);
      setWaiting(decision.action === "waiting");
      if (decision.action === "capture") void captureFrame(decision);
    };

    const timer = window.setInterval(compareFrame, 1_000 / sampleRate);
    compareFrame();
    return () => window.clearInterval(timer);
  }, [captureFrame, sampleRate, status]);

  // Recording clock.
  useEffect(() => {
    if (status !== "sharing") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    const urls = objectUrlsRef;
    return () => {
      // Delayed so a strict-mode remount can cancel it (see the handover effect above).
      stopTimerRef.current = window.setTimeout(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        urls.current.forEach((url) => URL.revokeObjectURL(url));
      }, 0);
    };
  }, []);

  const clearCaptures = () => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];
    setCaptures([]);
  };

  const isSharing = status === "sharing";
  const changedPercent = diff?.changedPercent ?? 0;
  const headline = status === "requesting"
    ? "Choose what to share"
    : isSharing
      ? baselineReady ? "Recording: Yoda is watching" : "Recording: taking the first look"
      : status === "stopped" ? "Recording stopped" : status === "error" ? "Needs attention" : "Ready to record";
  const subline = isSharing
    ? waiting
      ? "Change detected, waiting for the screen to settle…"
      : `${sourceName} · ${sampleRate} comparisons per second`
    : status === "requesting"
      ? "Pick a tab, window or display in your browser's dialog."
      : "Press start: your browser asks which screen to share, then Yoda starts watching.";

  return (
    <section aria-label="Screen recorder" className="overflow-hidden rounded-2xl border border-line bg-surface/90">
      {/* header: state, clock, counters, the one button that matters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line px-5 py-4">
        <span
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 rounded-full ${isSharing ? "animate-pulse bg-danger shadow-[0_0_12px_2px_rgba(255,84,104,0.6)]" : status === "requesting" ? "bg-gold" : "bg-muted/50"}`}
        />
        <div className="min-w-0 flex-1" role="status">
          <p className="font-heading text-base font-bold text-fg">{headline}</p>
          <p className="truncate text-sm text-muted" title={subline}>{subline}</p>
        </div>
        {isSharing && <span className="font-mono text-lg font-semibold tabular-nums text-fg" aria-label="Recording time">{formatElapsed(elapsed)}</span>}
        {stats && <div className="flex flex-wrap items-center gap-2">{stats}</div>}
        {isSharing ? (
          <button type="button" onClick={stopSharing} className={`${btnGhost} !border-danger/60 !text-danger hover:!bg-danger/10`}>
            <StopIcon /> Stop recording
          </button>
        ) : (
          <button type="button" onClick={startSharing} disabled={status === "requesting"} className={btnPrimary}>
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-danger" />
            {status === "requesting" ? "Choose a source…" : status === "stopped" ? "Record again" : "Start recording"}
          </button>
        )}
      </div>

      <div className={`grid gap-5 ${embedded ? "p-4" : "p-5"} lg:grid-cols-[minmax(0,1fr)_320px]`}>
        {/* the live view */}
        <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            className={`absolute inset-0 h-full w-full object-contain ${isSharing && !captureSafeMode ? "opacity-100" : "pointer-events-none opacity-0"}`}
          />
          {!isSharing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <YodaFigure size={96} label="" />
              <p className="font-heading text-lg font-bold text-fg">Your shared screen appears here</p>
              <p className="max-w-sm text-sm text-muted">The Padawan tab is left out where the browser supports it. Choose another tab, window or display.</p>
            </div>
          )}
          {isSharing && captureSafeMode && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
              <MonitorIcon className="text-jade" />
              <p className="font-heading text-lg font-bold text-fg">Preview hidden while recording</p>
              <p className="max-w-md text-sm text-muted">Yoda is still watching your source. Showing it here would make a screen inside a screen.</p>
              <Chip tone="jade">capture-safe mode</Chip>
            </div>
          )}
          {isSharing && !captureSafeMode && (
            <span className="absolute left-3 top-3 inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 font-mono text-xs text-fg">
              <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-danger" /> LIVE
            </span>
          )}
        </div>

        {/* detection: the meter stays visible, the knobs fold away */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-line bg-surface-2/60 p-4">
            <div className="flex items-baseline justify-between">
              <Label>{captureSafeMode ? "Live meter hidden" : "Change vs last frame"}</Label>
              <strong className="font-heading text-xl font-black text-fg">{captureSafeMode ? "safe" : `${changedPercent.toFixed(1)}%`}</strong>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <span className={`block h-full rounded-full transition-all ${waiting ? "bg-gold" : "bg-jade"}`} style={{ width: captureSafeMode ? "0%" : `${Math.min(changedPercent * 4, 100)}%` }} />
            </div>
            <p className="mt-3 text-xs text-muted">
              {captureSafeMode
                ? "Comparison continues without changing this screen."
                : diff?.significant
                  ? `Detected: ${REASON_TEXT[diff.reason]}.`
                  : "Only real changes are sent: cursor moves, a blinking caret and video noise are ignored."}
            </p>
          </div>

          <details open={!embedded} className="group rounded-xl border border-line bg-surface-2/60">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-fg">
              Detection settings
              <span className="font-mono text-xs text-muted group-open:hidden">show</span>
              <span className="hidden font-mono text-xs text-muted group-open:inline">hide</span>
            </summary>
            <div className="space-y-5 border-t border-line px-4 py-4">
              <label className="block">
                <span className="flex items-center justify-between text-sm text-fg"><span>Changed area</span><output className="font-mono text-xs text-jade">{frameThreshold}%</output></span>
                <span className="mt-1 block text-xs text-muted">Send when this much of the whole screen changes.</span>
                <input type="range" min="1" max="20" step="1" value={frameThreshold} onChange={(event) => setFrameThreshold(Number(event.target.value))} className="mt-2 w-full accent-jade" />
                <span className="flex justify-between font-mono text-[10px] text-muted"><span>Subtle</span><span>Major</span></span>
              </label>

              <label className="block">
                <span className="flex items-center justify-between text-sm text-fg"><span>Pixel tolerance</span><output className="font-mono text-xs text-jade">{pixelThreshold}</output></span>
                <span className="mt-1 block text-xs text-muted">Ignore small color changes and visual noise.</span>
                <input type="range" min="5" max="80" step="5" value={pixelThreshold} onChange={(event) => setPixelThreshold(Number(event.target.value))} className="mt-2 w-full accent-jade" />
                <span className="flex justify-between font-mono text-[10px] text-muted"><span>Sensitive</span><span>Tolerant</span></span>
              </label>

              <label className="flex items-start gap-3">
                <input type="checkbox" checked={smallEdits} onChange={(event) => setSmallEdits(event.target.checked)} className="mt-1 h-4 w-4 accent-jade" />
                <span>
                  <span className="block text-sm text-fg">Detect small edits</span>
                  <span className="block text-xs text-muted">Catch a changed field or a few typed characters, not only big changes.</span>
                </span>
              </label>

              <label className="flex items-center justify-between gap-3">
                <span>
                  <span className="block text-sm text-fg">Comparison rate</span>
                  <span className="block text-xs text-muted">Lower rates use less CPU.</span>
                </span>
                <select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))} className="rounded-lg border border-line bg-bg px-3 py-1.5 text-sm text-fg">
                  <option value="1">1 fps</option><option value="2">2 fps</option><option value="4">4 fps</option>
                </select>
              </label>

              <p className="rounded-lg border border-jade/30 bg-jade/5 p-3 text-xs leading-relaxed text-muted">
                <strong className="text-jade">Settles before sending.</strong> After a change the recorder waits for the screen to stop moving, so Yoda sees the finished state, not the animation.
              </p>
            </div>
          </details>
        </aside>
      </div>

      {errorMessage && (
        <div className="mx-5 mb-5 rounded-lg border border-danger/50 bg-danger/10 px-4 py-3 text-sm text-fg" role="alert">
          <span className="font-mono text-xs uppercase tracking-widest text-danger">Capture issue </span>{errorMessage}
        </div>
      )}

      {showCaptures && (
        <div className="border-t border-line p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-lg font-black text-gold">Captured changes</h2>
            {!captureSafeMode && captures.length > 0 && (
              <button type="button" onClick={clearCaptures} className="font-mono text-xs text-info underline underline-offset-4 hover:text-fg">Clear all</button>
            )}
          </div>
          {captureSafeMode ? (
            <p className="mt-3 text-sm text-muted">Snapshots are hidden while this source is recorded and appear when you stop.</p>
          ) : captures.length === 0 ? (
            <p className="mt-3 text-sm text-muted">The first snapshot is taken the moment recording starts, then one for every real change.</p>
          ) : (
            <ul className="mt-4 flex gap-3 overflow-x-auto pb-2">
              {captures.map((capture) => (
                <li key={capture.id} className="w-56 shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2/60">
                  {/* The image only exists as a local browser blob during this session. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={capture.url} alt={`Screen capture from ${capture.capturedAt.toLocaleTimeString()}`} className="aspect-video w-full object-cover" />
                  <div className="p-3">
                    <p className="text-sm font-semibold text-fg">{capture.reason === "initial" ? "First look" : `${capture.changedPercent.toFixed(1)}% changed`}</p>
                    <p className="font-mono text-xs text-muted">{capture.capturedAt.toLocaleTimeString()} · {capture.width}×{capture.height} · {formatBytes(capture.bytes)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <canvas ref={comparisonCanvasRef} width={COMPARISON_WIDTH} height={COMPARISON_HEIGHT} className="hidden" aria-hidden="true" />
    </section>
  );
}
