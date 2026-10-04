export const PADAWAN_CAPTURE_HANDLE = "padawan-web-app";

export const SELF_CAPTURE_ERROR =
  "The Padawan tab cannot be shared. Choose the work tab, app window, or screen instead.";

type DisplayMediaOptionsWithCaptureHints = Omit<DisplayMediaStreamOptions, "video"> & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  // `cursor` is part of the screen-capture spec but is absent from some DOM typings.
  video: MediaTrackConstraints & { cursor?: "always" | "motion" | "never" };
};

type CaptureHandle = {
  handle: string;
  origin: string;
};

type CaptureHandleTrack = MediaStreamTrack & {
  getCaptureHandle?: () => CaptureHandle | null;
};

type CaptureHandleMediaDevices = MediaDevices & {
  setCaptureHandleConfig?: (config: {
    exposeOrigin: boolean;
    handle: string;
    permittedOrigins: string[];
  }) => void;
};

export class SelfCaptureError extends Error {
  constructor() {
    super(SELF_CAPTURE_ERROR);
    this.name = "SelfCaptureError";
  }
}

/** Browser picker hints that make choosing the Padawan tab less likely. */
export function screenShareOptions(): DisplayMediaOptionsWithCaptureHints {
  return {
    video: { frameRate: { ideal: 15, max: 30 }, cursor: "never" },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    // Do not let an accepted share silently switch back to the Padawan tab later.
    surfaceSwitching: "exclude",
  };
}

/**
 * Marks every Padawan page so a Padawan capture client can recognize that the
 * selected browser tab is the app itself. Unsupported browsers still benefit
 * from the picker hints above.
 */
export function registerPadawanCaptureHandle() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return;

  try {
    (navigator.mediaDevices as CaptureHandleMediaDevices | undefined)?.setCaptureHandleConfig?.({
      exposeOrigin: false,
      handle: PADAWAN_CAPTURE_HANDLE,
      permittedOrigins: [window.location.origin],
    });
  } catch {
    // Capture Handle is defense in depth. It is not available in every browser.
  }
}

export function isPadawanSelfCapture(track: MediaStreamTrack | undefined): boolean {
  if (!track) return false;

  try {
    return (track as CaptureHandleTrack).getCaptureHandle?.()?.handle === PADAWAN_CAPTURE_HANDLE;
  } catch {
    return false;
  }
}

/** Stops and rejects a selected Padawan tab before any frame can leave the browser. */
export function assertNotPadawanSelfCapture(stream: MediaStream) {
  if (!isPadawanSelfCapture(stream.getVideoTracks()[0])) return;

  stream.getTracks().forEach((track) => track.stop());
  throw new SelfCaptureError();
}
