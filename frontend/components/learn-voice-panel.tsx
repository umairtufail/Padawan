"use client";

import { useEffect, useRef } from "react";
import type { AgentStatus, Caption } from "../lib/use-agent-conversation";
import { btnGhost, btnPrimary, Chip, ErrorBox, Label } from "./ui";
import YodaPresence, { type PresenceState } from "./yoda-presence";

type Props = {
  status: AgentStatus;
  error: string;
  captions: Caption[];
  agentSpeaking: boolean;
  micOn: boolean;
  mock: boolean;
  onStart: () => void;
  onStop: () => void;
  onMic: (on: boolean) => void;
};

function presenceOf(p: Pick<Props, "status" | "agentSpeaking" | "micOn">): PresenceState {
  if (p.status !== "connected") return "off";
  if (p.agentSpeaking) return "speaking";
  return p.micOn ? "listening" : "idle";
}

/**
 * Yoda the tutor. He speaks every instruction and question aloud; the captions only show what was said (they are
 * an accessibility aid, never a replacement for the voice).
 */
export default function LearnVoicePanel(p: Props) {
  const connected = p.status === "connected";
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.captions.length]);

  return (
    <section aria-labelledby="learn-yoda" className="rounded-2xl border border-jade/30 bg-surface/90 p-5" data-testid="learn-voice-panel">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
        <YodaPresence state={presenceOf(p)} size={96} />
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="!text-jade">Yoda, your tutor</Label>
            <h2 id="learn-yoda" className="sr-only">Yoda voice conversation</h2>
            <Chip tone={connected ? "jade" : p.status === "error" ? "danger" : "muted"}>
              {p.status === "connecting" ? "Connecting…" : connected ? (p.agentSpeaking ? "Speaking" : "Listening") : p.status === "error" ? "Connection failed" : "Not connected"}
            </Chip>
            {p.mock && <Chip tone="gold">mock voice</Chip>}
          </div>
          <p className="mt-2 text-sm text-muted">
            {connected
              ? "Yoda speaks to you. Answer him aloud when he asks what you expect. Headphones keep the room quiet."
              : "Yoda speaks every instruction aloud. Wake him to hear the lesson."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!connected ? (
              <button type="button" className={btnPrimary} onClick={p.onStart} disabled={p.status === "connecting"}>
                {p.status === "connecting" ? "Connecting…" : "Wake Yoda"}
              </button>
            ) : (
              <>
                <button type="button" className={btnGhost} onClick={() => p.onMic(!p.micOn)} aria-pressed={p.micOn}>
                  {p.micOn ? "Mic on · mute" : "Mic off · unmute"}
                </button>
                <button type="button" className={btnGhost} onClick={p.onStop}>Send Yoda away</button>
              </>
            )}
          </div>
        </div>
      </div>

      {p.error && <div className="mt-4"><ErrorBox>{p.error}</ErrorBox></div>}

      <div className="mt-5">
        <Label>Captions of what Yoda says</Label>
        <ol
          ref={logRef}
          aria-live="polite"
          aria-label="Captions of the conversation"
          className="mt-2 max-h-56 space-y-2 overflow-y-auto rounded-xl border border-line bg-surface-2/60 p-3"
        >
          {p.captions.length === 0 && <li className="text-sm text-muted">Nothing said yet.</li>}
          {p.captions.map((c) => (
            <li key={c.id} className="text-sm" data-who={c.who}>
              <span className={`mr-2 font-mono text-xs uppercase tracking-widest ${c.who === "yoda" ? "text-jade" : "text-gold"}`}>
                {c.who === "yoda" ? "Yoda" : "You"}
              </span>
              <span className="text-fg">{c.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
