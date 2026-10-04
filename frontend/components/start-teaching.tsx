"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, createTeachSession, MOCK } from "../lib/api";
import { stashStream } from "../lib/capture-handoff";
import { btnPrimary, ErrorBox } from "./ui";

type DisplayMediaOptionsWithSelfExclusion = Omit<DisplayMediaStreamOptions, "video"> & {
  selfBrowserSurface?: "include" | "exclude";
  // "never" keeps the mouse pointer out of the stream (see app/screen-capture.tsx).
  video: MediaTrackConstraints & { cursor?: "always" | "motion" | "never" };
};

type Props = {
  /** Name of the new session. */
  title?: string;
  label?: string;
  className?: string;
};

/**
 * Starts teaching in one click: the browser asks which screen to share right away, the session is created,
 * and the page that opens is already recording (the live stream is handed over, see lib/capture-handoff.ts).
 */
export default function StartTeaching({ title = "New task", label = "Start teaching", className = "" }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "choosing" | "creating">("idle");
  const [error, setError] = useState("");

  async function start() {
    setError("");
    if (MOCK) {
      // Mock mode: no screen to share. The session page has a button that feeds scripted frames instead.
      setPhase("creating");
      try {
        const session = await createTeachSession(title.trim() || "New task");
        router.push(`/dashboard/teach/${session.session_id}`);
      } catch (err) {
        setPhase("idle");
        if (!(err instanceof ApiError && err.status === 401)) {
          setError(err instanceof Error ? err.message : "Could not create a session.");
        }
      }
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen sharing is not supported in this browser.");
      return;
    }

    setPhase("choosing");
    let stream: MediaStream;
    try {
      const options: DisplayMediaOptionsWithSelfExclusion = {
        video: { frameRate: { ideal: 15, max: 30 }, cursor: "never" },
        audio: false,
        selfBrowserSurface: "exclude",
      };
      stream = await navigator.mediaDevices.getDisplayMedia(options);
    } catch (err) {
      setPhase("idle");
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Screen sharing was cancelled. Press the button again when you are ready.");
      } else {
        setError(err instanceof Error ? err.message : "Could not start screen sharing.");
      }
      return;
    }

    setPhase("creating");
    try {
      const session = await createTeachSession(title.trim() || "New task");
      stashStream(session.session_id, stream);
      router.push(`/dashboard/teach/${session.session_id}`);
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop());
      setPhase("idle");
      if (!(err instanceof ApiError && err.status === 401)) {
        setError(err instanceof Error ? err.message : "Could not create a session.");
      }
    }
  }

  const text = phase === "choosing" ? "Choose what to share…" : phase === "creating" ? "Starting…" : label;

  return (
    <div className={className}>
      {error && <div className="mb-4"><ErrorBox>{error}</ErrorBox></div>}
      <button type="button" onClick={start} disabled={phase !== "idle"} className={btnPrimary}>
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-danger" />
        {text}
      </button>
    </div>
  );
}
