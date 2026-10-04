"use client";

import { useRef, useState } from "react";
import type { CapturedFramePayload } from "../lib/frame-delivery";
import { btnGhost } from "./ui";

/** Mock mode only: there is no screen to share, so this button feeds a generated frame into the recorder. */
export default function MockScreenButton({ onFrame }: { onFrame: (p: CapturedFramePayload) => void }) {
  const n = useRef(0);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      const w = 640;
      const h = 360;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      n.current += 1;
      ctx.fillStyle = "#0b1020";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#e8e6d9";
      ctx.font = "28px monospace";
      ctx.fillText(`Mock screen ${n.current}`, 40, 120);
      ctx.fillStyle = "#ffd24a";
      ctx.fillRect(40, 160, 200 + (n.current % 4) * 60, 24);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (!blob) return;
      onFrame({
        blob, capturedAt: new Date().toISOString(), changedPixelRatio: 0.2, width: w, height: h,
        reason: n.current === 1 ? "initial" : "change", region: null,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className={btnGhost} onClick={() => void send()} disabled={busy}>
      Send a mock screen change
    </button>
  );
}
