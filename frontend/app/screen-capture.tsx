"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deliverCapturedFrame, type CapturedFramePayload } from "../lib/frame-delivery";
import "./screen-capture.css";

type CaptureStatus = "idle" | "requesting" | "sharing" | "stopped" | "error";

type DisplayMediaOptionsWithSelfExclusion = DisplayMediaStreamOptions & {
  selfBrowserSurface?: "include" | "exclude";
};

type MediaTrackSettingsWithSurface = MediaTrackSettings & {
  displaySurface?: "browser" | "window" | "monitor";
};

type Capture = {
  id: string;
  url: string;
  capturedAt: Date;
  changedRatio: number;
  width: number;
  height: number;
  bytes: number;
};

const COMPARISON_WIDTH = 320;
const COMPARISON_HEIGHT = 180;
const REQUIRED_STABLE_SAMPLES = 2;
const CAPTURE_COOLDOWN_MS = 1_000;

function formatBytes(bytes: number) {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function MonitorIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8.5 21h7M12 17v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function ActivityIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}

type ScreenCaptureProps = {
  /** Called with each changed frame. Defaults to deliverCapturedFrame (console log). */
  onFrame?: (payload: CapturedFramePayload) => Promise<void> | void;
  /** Hide the standalone header and hero (used when embedded in the dashboard). */
  embedded?: boolean;
};

export default function ScreenCapture({ onFrame, embedded = false }: ScreenCaptureProps = {}) {
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const comparisonCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const baselineRef = useRef<Uint8ClampedArray | null>(null);
  const stableSamplesRef = useRef(0);
  const captureInFlightRef = useRef(false);
  const lastCaptureAtRef = useRef(0);
  const objectUrlsRef = useRef<string[]>([]);

  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [sourceName, setSourceName] = useState("No source selected");
  const [frameThreshold, setFrameThreshold] = useState(3);
  const [pixelThreshold, setPixelThreshold] = useState(25);
  const [sampleRate, setSampleRate] = useState(2);
  const [changedRatio, setChangedRatio] = useState(0);
  const [baselineReady, setBaselineReady] = useState(false);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [captureSafeMode, setCaptureSafeMode] = useState(false);

  const stopSharing = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());

    if (videoRef.current) videoRef.current.srcObject = null;
    baselineRef.current = null;
    stableSamplesRef.current = 0;
    captureInFlightRef.current = false;
    setBaselineReady(false);
    setChangedRatio(0);
    setSourceName("No source selected");
    setCaptureSafeMode(false);
    setStatus("stopped");
  }, []);

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
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
        selfBrowserSurface: "exclude",
      };
      const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
      const videoTrack = stream.getVideoTracks()[0];
      const displaySurface = (videoTrack?.getSettings() as MediaTrackSettingsWithSurface | undefined)?.displaySurface;

      // Unknown surface types use the safe fallback. The browser may ignore the
      // selfBrowserSurface hint, so only a confirmed browser-tab capture shows
      // its live preview and capture gallery while monitoring.
      setCaptureSafeMode(displaySurface !== "browser");

      streamRef.current = stream;
      baselineRef.current = null;
      stableSamplesRef.current = 0;
      lastCaptureAtRef.current = 0;
      setBaselineReady(false);
      setChangedRatio(0);
      setSourceName(videoTrack?.label || "Shared screen");

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      videoTrack?.addEventListener("ended", stopSharing, { once: true });
      setStatus("sharing");
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
  }, [stopSharing]);

  const captureFrame = useCallback(async (ratio: number, baseline: Uint8ClampedArray) => {
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
      const url = URL.createObjectURL(blob);
      objectUrlsRef.current.push(url);
      const capture: Capture = {
        id: crypto.randomUUID(),
        url,
        capturedAt,
        changedRatio: ratio,
        width: canvas.width,
        height: canvas.height,
        bytes: blob.size,
      };

      setCaptures((current) => [capture, ...current]);
      baselineRef.current = new Uint8ClampedArray(baseline);
      lastCaptureAtRef.current = Date.now();

      await (onFrameRef.current ?? deliverCapturedFrame)({
        blob,
        capturedAt: capturedAt.toISOString(),
        changedPixelRatio: ratio / 100,
        width: canvas.width,
        height: canvas.height,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to capture the changed frame.");
    } finally {
      captureInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (status !== "sharing") return;

    const compareFrame = () => {
      const video = videoRef.current;
      const canvas = comparisonCanvasRef.current;
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;

      context.drawImage(video, 0, 0, COMPARISON_WIDTH, COMPARISON_HEIGHT);
      const currentPixels = context.getImageData(0, 0, COMPARISON_WIDTH, COMPARISON_HEIGHT).data;

      if (!baselineRef.current) {
        baselineRef.current = new Uint8ClampedArray(currentPixels);
        setBaselineReady(true);
        return;
      }

      const baseline = baselineRef.current;
      let changedPixels = 0;

      for (let index = 0; index < currentPixels.length; index += 4) {
        const redDifference = Math.abs(currentPixels[index] - baseline[index]);
        const greenDifference = Math.abs(currentPixels[index + 1] - baseline[index + 1]);
        const blueDifference = Math.abs(currentPixels[index + 2] - baseline[index + 2]);

        if (Math.max(redDifference, greenDifference, blueDifference) >= pixelThreshold) {
          changedPixels += 1;
        }
      }

      const ratio = (changedPixels / (COMPARISON_WIDTH * COMPARISON_HEIGHT)) * 100;
      setChangedRatio(ratio);

      const isPastCooldown = Date.now() - lastCaptureAtRef.current >= CAPTURE_COOLDOWN_MS;
      if (ratio >= frameThreshold && isPastCooldown) {
        stableSamplesRef.current += 1;
        if (stableSamplesRef.current >= REQUIRED_STABLE_SAMPLES) {
          stableSamplesRef.current = 0;
          void captureFrame(ratio, currentPixels);
        }
      } else {
        stableSamplesRef.current = 0;
      }
    };

    const timer = window.setInterval(compareFrame, 1_000 / sampleRate);
    compareFrame();
    return () => window.clearInterval(timer);
  }, [captureFrame, frameThreshold, pixelThreshold, sampleRate, status]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const clearCaptures = () => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];
    setCaptures([]);
  };

  const isSharing = status === "sharing";
  const statusLabel = status === "requesting"
    ? "Waiting for permission"
    : isSharing
      ? baselineReady ? "Monitoring changes" : "Preparing baseline"
      : status === "error" ? "Needs attention" : "Ready to monitor";

  return (
    <main className="app-shell" style={embedded ? { minHeight: 0, paddingBottom: 24, borderRadius: 18, paddingTop: 20 } : undefined}>
      {!embedded && <header className="topbar">
        <a className="brand" href="#top" aria-label="FrameSignal home">
          <span className="brand-mark"><ActivityIcon /></span>
          <span>FrameSignal</span>
        </a>
        <div className="privacy-pill"><span className="privacy-dot" />Processing stays in your browser</div>
      </header>}

      {!embedded && <section className="hero" id="top">
        <div className="eyebrow"><span /> Browser screen monitor</div>
        <h1>Capture only what <em>changes.</em></h1>
        <p>Share a screen or window. FrameSignal watches locally and saves a snapshot only when the visual change crosses your threshold.</p>
      </section>}

      <section className="workspace" aria-label="Screen monitoring workspace">
        <div className="preview-card">
          <div className="panel-heading">
            <div><span className={`live-indicator ${isSharing ? "is-live" : ""}`} /><strong>{isSharing ? "Live source" : "Screen source"}</strong></div>
            <span className="source-name" title={sourceName}>{sourceName}</span>
          </div>

          <div className={`video-stage ${isSharing && !captureSafeMode ? "has-video" : ""} ${captureSafeMode ? "capture-safe" : ""}`}>
            <video ref={videoRef} muted playsInline />
            {!isSharing && (
              <div className="empty-preview">
                <span className="monitor-illustration"><MonitorIcon /></span>
                <h2>Your shared screen will appear here</h2>
                <p>FrameSignal is excluded where supported. Choose another tab, window, or display.</p>
              </div>
            )}
            {isSharing && captureSafeMode && (
              <div className="safe-preview">
                <span className="safe-preview-icon"><MonitorIcon /></span>
                <h2>Preview hidden while monitoring</h2>
                <p>Your source is still being compared. Hiding it here prevents a screen-within-a-screen loop.</p>
                <span className="safe-mode-pill">Capture-safe mode</span>
              </div>
            )}
            {isSharing && !captureSafeMode && <div className="video-badge"><span /> Live preview</div>}
          </div>

          <div className="preview-footer">
            <div className="status-copy">
              <span className={`status-icon ${isSharing ? "active" : ""}`}><ActivityIcon /></span>
              <div><strong>{statusLabel}</strong><small>{isSharing && captureSafeMode ? "Preview and snapshots are hidden until sharing stops" : isSharing ? `${sampleRate} comparisons per second` : "Start sharing when you are ready"}</small></div>
            </div>
            {isSharing ? (
              <button className="button button-stop" onClick={stopSharing}><StopIcon /> Stop sharing</button>
            ) : (
              <button className="button button-primary" onClick={startSharing} disabled={status === "requesting"}>
                <MonitorIcon /> {status === "requesting" ? "Choose a source…" : "Share your screen"}
              </button>
            )}
          </div>
        </div>

        <aside className="controls-card">
          <div className="controls-heading"><span>Detection settings</span><small>Adjust anytime</small></div>

          <label className="setting">
            <span className="setting-title"><span>Changed area</span><output>{frameThreshold}%</output></span>
            <span className="setting-help">Capture when this much of the screen changes.</span>
            <input type="range" min="1" max="20" step="1" value={frameThreshold} onChange={(event) => setFrameThreshold(Number(event.target.value))} />
            <span className="range-labels"><span>Subtle</span><span>Major</span></span>
          </label>

          <label className="setting">
            <span className="setting-title"><span>Pixel tolerance</span><output>{pixelThreshold}</output></span>
            <span className="setting-help">Ignore small color changes and visual noise.</span>
            <input type="range" min="5" max="80" step="5" value={pixelThreshold} onChange={(event) => setPixelThreshold(Number(event.target.value))} />
            <span className="range-labels"><span>Sensitive</span><span>Tolerant</span></span>
          </label>

          <label className="select-setting">
            <span><strong>Comparison rate</strong><small>Lower rates use less CPU.</small></span>
            <select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))}>
              <option value="1">1 fps</option><option value="2">2 fps</option><option value="4">4 fps</option>
            </select>
          </label>

          {captureSafeMode ? (
            <div className="change-meter safe-meter">
              <div className="meter-copy"><span>Live meter hidden</span><strong>Safe</strong></div>
              <div className="meter-track"><span /></div>
              <small>Comparison continues without changing this screen.</small>
            </div>
          ) : (
            <div className="change-meter">
              <div className="meter-copy"><span>Current change</span><strong>{changedRatio.toFixed(1)}%</strong></div>
              <div className="meter-track"><span style={{ width: `${Math.min(changedRatio, 100)}%` }} /></div>
              <small>Trigger set at {frameThreshold}%</small>
            </div>
          )}

          <div className="logic-note">
            <span className="logic-icon">✓</span>
            <p><strong>Noise protection is on</strong>Changes must persist across two checks before a snapshot is saved.</p>
          </div>
        </aside>
      </section>

      {errorMessage && <div className="error-banner" role="alert"><strong>Capture issue</strong><span>{errorMessage}</span></div>}

      <section className="captures-section">
        <div className="section-heading">
          <div><span className="section-icon"><MonitorIcon /></span><div><h2>Captured changes</h2><p>{captureSafeMode ? "Snapshots will appear after sharing stops." : "Full-resolution snapshots waiting for your future backend."}</p></div></div>
          {!captureSafeMode && captures.length > 0 && <button className="text-button" onClick={clearCaptures}>Clear all</button>}
        </div>

        {captureSafeMode ? (
          <div className="captures-empty safe-captures">
            <span className="empty-rings"><ActivityIcon /></span>
            <h3>Captures are hidden during monitoring</h3>
            <p>They are being saved locally and will appear when screen sharing stops.</p>
          </div>
        ) : captures.length === 0 ? (
          <div className="captures-empty">
            <span className="empty-rings"><ActivityIcon /></span>
            <h3>No changes captured yet</h3>
            <p>Once monitoring starts, snapshots that cross your threshold will appear here.</p>
          </div>
        ) : (
          <div className="capture-grid">
            {captures.map((capture) => (
              <article className="capture-item" key={capture.id}>
                {/* The image only exists as a local browser blob during this session. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={capture.url} alt={`Screen capture from ${capture.capturedAt.toLocaleTimeString()}`} />
                <div className="capture-meta">
                  <div><strong>{capture.changedRatio.toFixed(1)}% changed</strong><span>{capture.capturedAt.toLocaleTimeString()}</span></div>
                  <small>{capture.width} × {capture.height} · {formatBytes(capture.bytes)}</small>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <canvas ref={comparisonCanvasRef} width={COMPARISON_WIDTH} height={COMPARISON_HEIGHT} className="comparison-canvas" aria-hidden="true" />
    </main>
  );
}
