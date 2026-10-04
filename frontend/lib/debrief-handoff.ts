import type { FinishResult } from "./pipeline-types";

const key = (sessionId: string) => `padawan_debrief_${sessionId}`;

/** Keeps the result of POST /finish for the debrief page (calling finish again would recompute the gaps). */
export function saveDebrief(sessionId: string, result: FinishResult): void {
  try {
    window.sessionStorage.setItem(key(sessionId), JSON.stringify(result));
  } catch {
    /* storage blocked: the debrief page calls finish itself */
  }
}

export function loadDebrief(sessionId: string): FinishResult | null {
  try {
    const raw = window.sessionStorage.getItem(key(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FinishResult;
    return parsed && Array.isArray(parsed.steps) && Array.isArray(parsed.gaps) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearDebrief(sessionId: string): void {
  try {
    window.sessionStorage.removeItem(key(sessionId));
  } catch {
    /* nothing to clear */
  }
}
