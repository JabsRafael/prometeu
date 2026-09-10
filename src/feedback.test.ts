import { afterEach, expect, it, vi } from "vitest";
import { captureScreen } from "./feedback-client";

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("browser capture releases screen access even when frame playback fails: %s", async failed => {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream) } });
  const drawImage = vi.fn();
  const video = { muted: false, srcObject: null, videoWidth: 800, videoHeight: 600,
    play: failed ? vi.fn().mockRejectedValue(new Error("play failed")) : vi.fn().mockResolvedValue(undefined) };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: (done: (blob: Blob) => void) => done(new Blob(["image"], { type: "image/png" })) };
  vi.stubGlobal("document", { createElement: (tag: string) => tag === "video" ? video : canvas });
  if (failed) await expect(captureScreen()).rejects.toThrow("play failed");
  else {
    const file = await captureScreen();
    expect(file?.type).toBe("image/png");
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0);
  }
  expect(stop).toHaveBeenCalledOnce();
});

it("cancelling browser capture leaves the attachment unchanged", async () => {
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(new DOMException("cancelled", "NotAllowedError")) } });
  await expect(captureScreen()).resolves.toBeUndefined();
});
