/** Normalised (0..1) rectangle of the frame where the screen changed. */
export type ChangeRegion = { x: number; y: number; w: number; h: number };

export type CapturedFramePayload = {
  blob: Blob;
  capturedAt: string;
  changedPixelRatio: number;
  width: number;
  height: number;
  /** Why the frame was taken: the first look at the screen, or a detected change. */
  reason?: "initial" | "change";
  /** Where the screen changed (null for the initial frame). */
  region?: ChangeRegion | null;
};

/**
 * Backend integration boundary. The session page replaces this with the buffered upload
 * (lib/use-frame-buffer.ts); the capture engine does not need to change.
 */
export async function deliverCapturedFrame(payload: CapturedFramePayload) {
  console.info("Frame ready for delivery", {
    capturedAt: payload.capturedAt,
    reason: payload.reason,
    changedPixelRatio: payload.changedPixelRatio,
    width: payload.width,
    height: payload.height,
    bytes: payload.blob.size,
  });
}
