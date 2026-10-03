export type CapturedFramePayload = {
  blob: Blob;
  capturedAt: string;
  changedPixelRatio: number;
  width: number;
  height: number;
};

/**
 * Backend integration boundary. Replace this implementation with an upload
 * when the backend is available; the capture engine does not need to change.
 */
export async function deliverCapturedFrame(payload: CapturedFramePayload) {
  console.info("Frame ready for delivery", {
    capturedAt: payload.capturedAt,
    changedPixelRatio: payload.changedPixelRatio,
    width: payload.width,
    height: payload.height,
    bytes: payload.blob.size,
  });
}
