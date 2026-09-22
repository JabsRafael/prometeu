import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { use } from "./i18n";
import { updater, view, type Found, type Io, type View } from "./update";

// Keep view-state assertions independent of the host language.
use("en");

/// A controlled update emits download progress and finishes when the test allows it.
function found(version = "0.2.0"): Found & { finish: () => void; fail: (why: string) => void; downloads: number } {
  let done!: (v: void) => void;
  let broke!: (e: Error) => void;
  const it = {
    version,
    body: "notes",
    downloads: 0,
    finish: () => done(),
    fail: (why: string) => broke(new Error(why)),
    downloadAndInstall: vi.fn(async (onEvent?: (e: any) => void) => {
      it.downloads++;
      onEvent?.({ event: "Started", data: { contentLength: 200 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 50 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 50 } });
      await new Promise<void>((resolve, reject) => {
        done = resolve;
        broke = reject;
      });
    }),
  };
  return it;
}

function world(update: Found | null) {
  const faces: View[] = [];
  const said: string[] = [];
  const io: Io = {
    check: vi.fn(async () => update),
    relaunch: vi.fn(async () => {}),
    clock: () => "13:48",
    show: (f) => faces.push(f),
    say: (t) => said.push(t),
  };
  return { io, faces, said, last: () => faces[faces.length - 1] };
}

/// Flush download promises with fake timers instead of using setTimeout.
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("view", () => {
  it("maps each phase to its view state and marks only ready updates as filled", () => {
    const update = found("0.2.0");
    expect(view({ at: "quiet" })).toMatchObject({ text: "Check for updates", disabled: false });
    expect(view({ at: "checking" })).toMatchObject({ text: "Checking…", disabled: true });
    expect(view({ at: "found", update })).toMatchObject({ text: "Update to 0.2.0", title: "notes", ready: false });
    expect(view({ at: "downloading", update, got: 0, total: 0 })).toMatchObject({ text: "Downloading…", disabled: true });
    expect(view({ at: "downloading", update, got: 50, total: 200 })).toMatchObject({ text: "Downloading 25%" });
    expect(view({ at: "ready", version: "0.2.0" })).toMatchObject({ text: "Restart to update", ready: true, disabled: false });
    expect(view({ at: "restarting", version: "0.2.0" })).toMatchObject({ text: "Restarting…", ready: true, disabled: true });
  });

  it("shows the footer button only when an action is available", () => {
    const update = found("0.2.0");
    expect(view({ at: "quiet" }).footer).toBe(false);
    expect(view({ at: "checking" }).footer).toBe(false);
    expect(view({ at: "fresh", when: "13:48" }).footer).toBe(false);
    expect(view({ at: "failed", why: "offline" }).footer).toBe(false);
    expect(view({ at: "found", update }).footer).toBe(true);
    expect(view({ at: "ready", version: "0.2.0" }).footer).toBe(true);
  });

  it("exposes release notes only while the found update is being reviewed", () => {
    const update = found("0.2.0");
    expect(view({ at: "found", update }).notes).toEqual({ version: "0.2.0", body: "notes" });
    // Release-note review ends once downloading starts or the update is ready.
    expect(view({ at: "downloading", update, got: 0, total: 0 }).notes).toBeUndefined();
    expect(view({ at: "ready", version: "0.2.0" }).notes).toBeUndefined();
    // A release without notes must not open an empty dialog.
    expect(view({ at: "found", update: { ...update, body: "  " } }).notes).toBeUndefined();
  });

  it("shows the last check time and failure reason in settings", () => {
    expect(view({ at: "fresh", when: "13:48" })).toMatchObject({
      text: "Check for updates",
      note: "Nothing new — checked at 13:48",
      tone: "plain",
    });
    expect(view({ at: "failed", why: "Error: offline" })).toMatchObject({
      text: "Check for updates",
      note: "Could not check: Error: offline",
      tone: "bad",
    });
  });
});

describe("updater", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("finds and downloads an update, then restarts on the second click", async () => {
    const update = found();
    const w = world(update);
    const up = updater(w.io);

    await up.look();
    expect(w.last()?.text).toBe("Update to 0.2.0");

    const first = up.click();
    await tick();
    expect(w.last()?.text).toBe("Downloading 50%");
    update.finish();
    await first;
    expect(w.last()).toMatchObject({ text: "Restart to update", ready: true });

    // Regression: the restart button previously did nothing.
    void up.click();
    await tick();
    expect(w.io.relaunch).toHaveBeenCalledTimes(1);
    expect(w.last()).toMatchObject({ text: "Restarting…", disabled: true });
  });

  it("does not start a second download while downloading", async () => {
    const update = found();
    const w = world(update);
    const up = updater(w.io);
    await up.look();
    const first = up.click();
    await tick();
    await up.click();
    expect(update.downloads).toBe(1);
    update.finish();
    await first;
  });

  it("returns to the update action and reports failed downloads", async () => {
    const update = found();
    const w = world(update);
    const up = updater(w.io);
    await up.look();
    const first = up.click();
    await tick();
    update.fail("offline");
    await first;
    expect(w.last()?.text).toBe("Update to 0.2.0");
    expect(w.said[0]).toMatch(/could not update.*offline/);
  });

  it("asks the user to reopen when restarting does not complete", async () => {
    const update = found();
    const w = world(update);
    const up = updater(w.io);
    await up.look();
    const first = up.click();
    await tick();
    update.finish();
    await first;

    const second = up.click();
    await vi.advanceTimersByTimeAsync(9_000);
    await second;
    expect(w.last()).toMatchObject({ text: "Restart to update", disabled: false });
    expect(w.said[w.said.length - 1]).toMatch(/quit and open Prometeu.*0\.2\.0/);
  });

  it("reports restart errors returned by the backend", async () => {
    const update = found();
    const w = world(update);
    w.io.relaunch = vi.fn(async () => {
      throw "process.restart not allowed";
    });
    const up = updater(w.io);
    await up.look();
    const first = up.click();
    await tick();
    update.finish();
    await first;
    await up.click();
    expect(w.last()?.text).toBe("Restart to update");
    expect(w.said[w.said.length - 1]).toMatch(/could not restart: process\.restart not allowed/);
  });

  it("replaces the offer with a newer version before downloading", async () => {
    const old = found("0.2.0");
    const latest = found("0.3.0");
    const w = world(old);
    const up = updater(w.io);
    await up.look();
    w.io.check = vi.fn(async () => latest);

    const download = up.click();
    await tick();
    expect(up.phase()).toMatchObject({ at: "downloading", update: { version: "0.3.0" } });
    expect(old.downloads).toBe(0);
    expect(latest.downloads).toBe(1);
    latest.finish();
    await download;
  });

  it("shows the check time when no update is available", async () => {
    const quiet = world(null);
    const q = updater(quiet.io);
    await q.look();
    expect(q.phase()).toEqual({ at: "fresh", when: "13:48" });
    expect(quiet.last()?.footer).toBe(false);
    expect(quiet.last()?.note).toMatch(/checked at 13:48/);
  });

  it("checks again when clicked without an available update", async () => {
    const w = world(null);
    const up = updater(w.io);
    await up.look();
    await up.click();
    expect(w.io.check).toHaveBeenCalledTimes(2);
    expect(up.phase().at).toBe("fresh");

    // Manual checks can discover updates before the scheduled check.
    w.io.check = vi.fn(async () => found("0.3.0"));
    await up.click();
    expect(w.last()?.text).toBe("Update to 0.3.0");
  });

  it("silences scheduled check errors and surfaces user-triggered errors", async () => {
    const w = world(null);
    const up = updater(w.io);
    await up.look();
    const quiet = w.faces.length;

    w.io.check = vi.fn(async () => {
      throw new Error("offline");
    });
    await up.look();
    // Retain the previous status during a background check.
    expect(up.phase()).toEqual({ at: "fresh", when: "13:48" });
    expect(w.said).toEqual([]);
    expect(w.faces.length).toBeGreaterThan(quiet); // Entered the checking state, then returned.

    await up.click();
    expect(up.phase()).toEqual({ at: "failed", why: "Error: offline" });
    expect(w.last()?.note).toMatch(/Could not check.*offline/);
    // Manual errors belong in Settings, not the sidebar footer.
    expect(w.last()?.footer).toBe(false);
    expect(w.said).toEqual([]);
  });

  it("does not check twice when clicked during a check", async () => {
    const w = world(null);
    let release!: (v: Found | null) => void;
    w.io.check = vi.fn(() => new Promise<Found | null>((r) => (release = r)));
    const up = updater(w.io);
    const first = up.look(true);
    await tick();
    expect(up.phase().at).toBe("checking");
    await up.click();
    expect(w.io.check).toHaveBeenCalledTimes(1);
    release(null);
    await first;
    expect(up.phase().at).toBe("fresh");
  });
});
