/**
 * Hands a live screen-share stream from the page where the user pressed "Start" to the session page.
 *
 * getDisplayMedia() must be called inside a user click, so the start button asks for the screen first and
 * creates the session afterwards. The stream is kept here (module state survives client-side navigation)
 * until the session page picks it up. Keyed by session id.
 */
const pending = new Map<string, MediaStream>();

export function stashStream(sessionId: string, stream: MediaStream) {
  pending.set(sessionId, stream);
}

/** Does not remove the stream, so a double render (React strict mode) still finds it. */
export function peekStream(sessionId: string): MediaStream | null {
  return pending.get(sessionId) ?? null;
}

export function releaseStream(sessionId: string) {
  pending.delete(sessionId);
}
