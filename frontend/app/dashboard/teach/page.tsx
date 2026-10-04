"use client";

import { useState } from "react";
import StartTeaching from "../../../components/start-teaching";
import YodaFigure from "../../../components/yoda-figure";
import { Label } from "../../../components/ui";

/** /dashboard/teach: name the task, press start, pick a screen. Recording begins on the next page. */
export default function TeachIndex() {
  const [title, setTitle] = useState("");

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border border-jade/30 bg-surface/90 p-8">
        <div className="flex items-center gap-5">
          <YodaFigure size={96} label="" />
          <div>
            <Label className="!text-jade">For the Master</Label>
            <h1 className="mt-1 font-heading text-3xl font-black text-gold">Teach Yoda</h1>
          </div>
        </div>

        <p className="mt-5 leading-relaxed text-muted">
          Do your job as usual. When you press start, your browser asks which screen to share, and Yoda starts watching
          straight away: he notes every change that matters and, later, asks you why.
        </p>

        <label className="mt-6 block">
          <Label>What are you about to do?</Label>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            placeholder="e.g. Process supplier invoices"
            className="mt-2 w-full rounded-lg border border-line bg-bg px-4 py-3 text-fg placeholder:text-muted/70 focus:border-jade focus:outline-none"
          />
        </label>

        <StartTeaching title={title} label="Start recording" className="mt-6" />
        <p className="mt-4 text-xs text-muted">
          Only frames where the screen changes are sent, straight from your browser. Stop any time from the page or from your browser&apos;s sharing bar.
        </p>
      </div>
    </div>
  );
}
