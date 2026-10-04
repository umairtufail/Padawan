"use client";

import { useEffect, useRef, useState } from "react";
import { MOCK, startVoiceReadiness } from "../lib/api";
import { classifyMicPeak, measureMicrophone } from "../lib/voice-readiness";
import { btnGhost, Chip, ErrorBox, Label } from "./ui";

type Result = "idle" | "checking" | "pass" | "fail";

export default function VoiceReadinessCheck() {
  const [running, setRunning] = useState(false);
  const [mic, setMic] = useState<Result>("idle");
  const [agent, setAgent] = useState<Result>("idle");
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState("Test your microphone and hear a short Yoda sample before teaching.");
  const [error, setError] = useState("");
  const conversationRef = useRef<{ endSession: () => Promise<void> } | null>(null);

  useEffect(() => () => {
    void conversationRef.current?.endSession().catch(() => undefined);
  }, []);

  async function testAgent() {
    setAgent("checking");
    setMessage("Connecting to Yoda…");
    const ready = await startVoiceReadiness();
    if (MOCK) {
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      setAgent("pass");
      return;
    }

    const { Conversation } = await import("@elevenlabs/client");
    let heardSpeech = false;
    let finish: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const conversation = await Conversation.startSession({
      signedUrl: ready.signed_url,
      dynamicVariables: ready.dynamic_variables,
      clientTools: {},
      onConversationCreated: (created) => {
        if ("setMicMuted" in created) created.setMicMuted(true);
      },
      onModeChange: ({ mode }) => {
        if (mode === "speaking") heardSpeech = true;
        if (mode === "listening" && heardSpeech) finish?.();
      },
      onError: (detail) => setError(typeof detail === "string" ? detail : "The Yoda sample failed."),
    });
    conversationRef.current = conversation;
    if ("setMicMuted" in conversation) conversation.setMicMuted(true);
    conversation.sendUserMessage("[READINESS]");

    let timeout = 0;
    try {
      await Promise.race([
        finished,
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error("Yoda connected but the sample did not play.")), 15_000);
        }),
      ]);
      setAgent("pass");
    } finally {
      window.clearTimeout(timeout);
      await conversation.endSession().catch(() => undefined);
      conversationRef.current = null;
    }
  }

  async function run() {
    if (running) return;
    setRunning(true);
    setMic("checking");
    setAgent("idle");
    setLevel(0);
    setError("");
    setMessage("Say: Ready, Yoda. Keep speaking for three seconds.");

    try {
      const peak = await measureMicrophone(setLevel);
      const quality = classifyMicPeak(peak);
      setMic(quality === "good" ? "pass" : "fail");
      if (quality === "quiet") setError("The microphone was too quiet. Check its input level or choose another microphone.");
    } catch (err) {
      setMic("fail");
      setError(err instanceof Error ? err.message : "The microphone test failed.");
    }

    try {
      await testAgent();
      setMessage("Readiness check complete.");
    } catch (err) {
      setAgent("fail");
      setError((current) => current || (err instanceof Error ? err.message : "Could not connect to Yoda."));
      setMessage("Readiness check complete with a problem.");
    } finally {
      setRunning(false);
      setLevel(0);
    }
  }

  const tone = (result: Result) => result === "pass" ? "jade" : result === "fail" ? "danger" : result === "checking" ? "info" : "muted";
  const text = (result: Result, name: string) => result === "pass" ? `${name} ready` : result === "fail" ? `${name} failed` : result === "checking" ? `${name} checking…` : `${name} not tested`;

  return (
    <section className="rounded-xl border border-line bg-surface/70 px-4 py-4" aria-labelledby="voice-readiness">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Label>Preflight</Label>
          <h2 id="voice-readiness" className="mt-1 font-heading text-lg font-bold text-fg">Mic and Yoda readiness</h2>
          <p className="mt-1 text-sm text-muted" role="status">{message}</p>
        </div>
        <button type="button" className={btnGhost} onClick={() => void run()} disabled={running}>
          {running ? "Testing…" : mic === "pass" && agent === "pass" ? "Test again" : "Test mic and Yoda"}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Chip tone={tone(mic)}>{text(mic, "Microphone")}</Chip>
        <Chip tone={tone(agent)}>{text(agent, "Yoda")}</Chip>
        {mic === "checking" && (
          <span className="h-2 w-28 overflow-hidden rounded-full bg-line" aria-label={`Microphone level ${Math.round(level * 100)} percent`}>
            <span className="block h-full rounded-full bg-jade transition-[width]" style={{ width: `${Math.max(2, level * 100)}%` }} />
          </span>
        )}
      </div>
      {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
    </section>
  );
}
