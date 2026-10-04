import { describe, expect, it, vi } from "vitest";
import {
  assertNotPadawanSelfCapture,
  PADAWAN_CAPTURE_HANDLE,
  screenShareOptions,
  SelfCaptureError,
} from "./screen-share";

function fakeStream(handle?: string) {
  const stop = vi.fn();
  const videoTrack = {
    getCaptureHandle: handle === undefined ? undefined : () => ({ handle, origin: "" }),
    stop,
  } as unknown as MediaStreamTrack;
  const stream = {
    getVideoTracks: () => [videoTrack],
    getTracks: () => [videoTrack],
  } as unknown as MediaStream;
  return { stream, stop };
}

describe("screen sharing boundaries", () => {
  it("asks the browser not to offer or switch to the current tab", () => {
    expect(screenShareOptions()).toMatchObject({
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
    });
  });

  it("stops and rejects a Padawan tab capture", () => {
    const { stream, stop } = fakeStream(PADAWAN_CAPTURE_HANDLE);

    expect(() => assertNotPadawanSelfCapture(stream)).toThrow(SelfCaptureError);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("allows another tab and browsers without Capture Handle support", () => {
    const other = fakeStream("another-app");
    const unsupported = fakeStream();

    expect(() => assertNotPadawanSelfCapture(other.stream)).not.toThrow();
    expect(() => assertNotPadawanSelfCapture(unsupported.stream)).not.toThrow();
    expect(other.stop).not.toHaveBeenCalled();
    expect(unsupported.stop).not.toHaveBeenCalled();
  });
});
