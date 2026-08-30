import { describe, expect, it, vi } from "vitest";
import { AttachLifecycle } from "./attach-lifecycle";

describe("ciclo de attach remoto", () => {
  it("detach resolve a espera imediatamente e invalida sua continuação", async () => {
    vi.useFakeTimers();
    const life = new AttachLifecycle();
    const old = life.start("ws-antigo", "tab-antiga", 10_000);
    let resumed = false;
    void old.wait.then(() => (resumed = true));

    life.cancel();
    await Promise.resolve();

    expect(resumed).toBe(true);
    expect(life.current(old)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("snapshot atrasado de outra aba não solta a espera atual", async () => {
    vi.useFakeTimers();
    const life = new AttachLifecycle();
    const current = life.start("ws", "tab-nova", 10_000);
    let resumed = false;
    void current.wait.then(() => (resumed = true));

    expect(life.completeTab("tab-antiga")).toBe(false);
    await Promise.resolve();
    expect(resumed).toBe(false);

    expect(life.completeTab("tab-nova")).toBe(true);
    await current.wait;
    expect(life.current(current)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("começar outro attach cancela o primeiro sem esperar o timeout", async () => {
    vi.useFakeTimers();
    const life = new AttachLifecycle();
    const first = life.start("um", "a", 10_000);
    const second = life.start("dois", "b", 10_000);

    await first.wait;
    expect(life.current(first)).toBe(false);
    expect(life.current(second)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    life.cancel();
    vi.useRealTimers();
  });
});
