import { afterEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ linux: false }));
const button = vi.hoisted(() => ({
  textContent: "", title: "", disabled: false, hidden: true,
  classList: { toggle: vi.fn() }, addEventListener: vi.fn(),
}));
vi.mock("./platform", async (original) => ({ ...await original<object>(), get linux() { return host.linux; } }));
vi.mock("./util", async (original) => ({ ...await original<object>(), $: () => button }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.13.0", getBundleType: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));

import { getBundleType } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { init } from "./update";

afterEach(() => {
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([
  [false, null, true],
  [true, "appimage", true],
  [true, "deb", false],
  [true, "rpm", false],
  [true, null, false],
  [true, "error", false],
])("starts updater only for supported installations (linux=%s, bundle=%s)", async (linux, bundle, enabled) => {
  vi.useFakeTimers();
  vi.mocked(getBundleType).mockReset();
  host.linux = linux;
  if (bundle === "error") vi.mocked(getBundleType).mockRejectedValueOnce(new Error("Unavailable"));
  else vi.mocked(getBundleType).mockResolvedValueOnce(bundle as Awaited<ReturnType<typeof getBundleType>>);

  await init(vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(enabled ? 1 : 0);
  expect(getBundleType).toHaveBeenCalledTimes(linux ? 1 : 0);
  expect(button.disabled).toBe(!enabled);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(check).toHaveBeenCalledTimes(enabled ? 2 : 0);
});
