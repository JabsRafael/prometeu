import { describe, expect, it, vi } from "vitest";
import { AttachLifecycle } from "./attach-lifecycle";

describe("remote attachment lifecycle", () => {
  it("detach resolves the wait immediately and invalidates its continuation", async () => {
    vi.useFakeTimers();
    const life = new AttachLifecycle();
    const old = life.start("old-ws", "old-tab", 10_000);
    let resumed = false;
    void old.wait.then(() => (resumed = true));

    life.cancel();
    await Promise.resolve();

    expect(resumed).toBe(true);
    expect(life.current(old)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("a late snapshot from another tab does not release the current wait", async () => {
    vi.useFakeTimers();
    const life = new AttachLifecycle();
    const current = life.start("ws", "new-tab", 10_000);
    let resumed = false;
    void current.wait.then(() => (resumed = true));

    expect(life.completeTab("old-tab")).toBe(false);
    await Promise.resolve();
    expect(resumed).toBe(false);

    expect(life.completeTab("new-tab")).toBe(true);
    await current.wait;
    expect(life.current(current)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("starting another attachment cancels the first without waiting for the timeout", async () => {
    vi.useFakeTimers();
    const life = new AttachLifecycle();
    const first = life.start("one", "a", 10_000);
    const second = life.start("two", "b", 10_000);

    await first.wait;
    expect(life.current(first)).toBe(false);
    expect(life.current(second)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    life.cancel();
    vi.useRealTimers();
  });
});
