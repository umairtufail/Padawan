"use client";

import { useEffect, useRef } from "react";
import type { Caption } from "../lib/use-agent-conversation";
import type { AgentStatus } from "../lib/use-agent-conversation";
import { btnGhost, btnPrimary, Chip, ErrorBox, Label } from "./ui";
import YodaPresence, { type PresenceState } from "./yoda-presence";

type Props = {
  status: AgentStatus;
  error: string;
  captions: Caption[];
  agentSpeaking: boolean;
  awaitingAnswer: boolean;
  micOn: boolean;
  expertSpeaking: boolean;
  offRecord: boolean;
  waitingQuestions: number;
  mock: boolean;
  onStart: () => void;
  onStop: () => void;
  onMic: (on: boolean) => void;
  onAskYoda: () => void;
  onSimulateSpeech: () => void;
};

function presenceOf(p: Pick<Props, "status" | "agentSpeaking" | "awaitingAnswer" | "micOn" | "expertSpeaking">): PresenceState {
  if (p.status !== "connected") return "off";
  if (p.agentSpeaking) return "speaking";
  if (p.awaitingAnswer) return "waiting";
  if (p.micOn || p.expertSpeaking) return "listening";
  return "idle";
}

const STATUS_TEXT: Record<AgentStatus, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Connection failed",
};

export default function YodaVoicePanel(p: Props) {
  const state = presenceOf(p);
  const connected = p.status === "connected";
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.captions.length]);

  return (
    <section aria-labelledby="yoda-voice" className="rounded-2xl border border-jade/30 bg-surface/90 p-5" data-testid="yoda-voice-panel">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
        <YodaPresence state={state} />
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="!text-jade">Yoda</Label>
            <h2 id="yoda-voice" className="sr-only">Yoda voice conversation</h2>
            <Chip tone={connected ? "jade" : p.status === "error" ? "danger" : "muted"}>{STATUS_TEXT[p.status]}</Chip>
            {p.mock && <Chip tone="gold">mock voice</Chip>}
            {p.offRecord && <Chip tone="danger">off the record</Chip>}
            {p.waitingQuestions > 0 && <Chip tone="info">{p.waitingQuestions} question{p.waitingQuestions > 1 ? "s" : ""} waiting</Chip>}
          </div>
          <p className="mt-2 text-sm text-muted">
            {!connected && "Yoda stays silent while you work. Connect him, and he asks one short question at a natural pause."}
            {connected && !p.micOn && !p.awaitingAnswer && "Your microphone is muted to Yoda. It opens when he asks, so you can answer."}
            {connected && p.micOn && !p.awaitingAnswer && "Your microphone is on: Yoda hears you."}
            {connected && p.awaitingAnswer && "Yoda asked. Answer in your own words, he is listening."}
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
                <button type="button" className={btnPrimary} onClick={p.onAskYoda} disabled={p.agentSpeaking || p.awaitingAnswer}>
                  Ask Yoda
                </button>
                <button type="button" className={btnGhost} onClick={p.onStop}>Send Yoda away</button>
              </>
            )}
            {p.mock && connected && (
              <button type="button" className={btnGhost} onClick={p.onSimulateSpeech}>Simulate Master talking (4 s)</button>
            )}
          </div>
        </div>
      </div>

      {p.error && <div className="mt-4"><ErrorBox>{p.error}</ErrorBox></div>}

      <div className="mt-5">
        <Label>Captions</Label>
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
                {c.who === "yoda" ? "Yoda" : "Master"}
              </span>
              <span className="text-fg">{c.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
