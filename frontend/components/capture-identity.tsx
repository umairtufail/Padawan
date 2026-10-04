"use client";

import { useEffect } from "react";
import { registerPadawanCaptureHandle } from "../lib/screen-share";

/** Gives the Padawan tab a capture identity so the app can reject sharing itself. */
export default function CaptureIdentity() {
  useEffect(() => {
    registerPadawanCaptureHandle();
  }, []);

  return null;
}
