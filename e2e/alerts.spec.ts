import { expect, test, type Page } from "@playwright/test";
import type { Board } from "../src/types";

type AlertWindow = Window & {
  sounds: number;
  focused: boolean;
  mock: { line: (tab: string, event: unknown) => void };
  __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};
const emit = (page: Page, tab: string, event: Record<string, unknown>) => page.evaluate(({ tab, event }) => {
  (window as AlertWindow).mock.line(tab, event);
}, { tab, event });
const done = (page: Page, tab = "t1") => emit(page, tab, {
  v: 1, at: 1, type: "turn.completed", outcome: "ok", message: "", durationMs: 100, costUsd: null,
});
const send = (page: Page, text: string, tab = "t1") => page.evaluate(async ({ text, tab }) => {
  await (window as AlertWindow).__TAURI_INTERNALS__.invoke("chat_send", { session: tab, text });
}, { text, tab });
const sounds = (page: Page) => page.evaluate(() => (window as AlertWindow).sounds / 2);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as AlertWindow;
    w.sounds = 0;
    w.focused = true;
    Object.defineProperty(document, "hasFocus", { value: () => w.focused });
    const node = () => ({
      gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      frequency: { value: 0 },
      connect() { return this; }, start() { w.sounds++; }, stop() {},
    });
    Object.defineProperty(window, "AudioContext", { value: class {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain = node;
      createOscillator = node;
    } });
  });
  await page.goto("/");
  await expect(page.locator('#tiles .tile[data-tab="t1"]')).toBeVisible();
  await page.clock.install();
});

test("a mesa e o workspace avisam uma vez por execução, sem rearmar por navegação", async ({ page }) => {
  const tile = page.locator('#tiles .tile[data-tab="t1"]');
  await send(page, "olá");
  await page.clock.runFor(5_000);
  expect(await sounds(page)).toBe(0);

  await page.locator('#deskbar [data-tab="t1"]').click();
  await expect(tile).toBeHidden();
  await done(page);
  await page.clock.runFor(1_000);
  expect(await sounds(page)).toBe(0);
  await send(page, "continue");
  await page.clock.runFor(5_000);
  expect(await sounds(page)).toBe(1);

  // Board status and transcript replay never create another execution.
  await page.evaluate(async () => {
    const { invoke } = (window as AlertWindow).__TAURI_INTERNALS__;
    const board = await invoke("load_board") as Board;
    const workspace = board.workspaces.find((w) => w.tabs.some((t) => t.id === "t1"))!;
    for (let i = 0; i < 10; i++) {
      workspace.tabs[0].status = i % 2 ? "pronta" : "rodando";
      await invoke("set_stage", { id: workspace.id, stage: workspace.stage });
    }
  });
  await page.locator('#deskbar [data-tab="t1"]').click();
  await expect(tile).toBeVisible();
  await page.evaluate(() => { (window as AlertWindow).focused = false; });
  await done(page);
  await done(page);
  await page.clock.runFor(1_000);
  expect(await sounds(page)).toBe(1);
  await send(page, "outra tarefa");
  await page.clock.runFor(5_000);
  expect(await sounds(page)).toBe(2);
  await page.evaluate(() => {
    (window as AlertWindow).focused = true;
    window.dispatchEvent(new Event("focus"));
  });

  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  await expect(page.locator("#wsView")).toBeVisible();
  await page.locator('#tabbar [data-tab="t1"]').click();
  await send(page, "pergunta", "t2");
  await page.clock.runFor(5_000);
  expect(await sounds(page)).toBe(2);
  await page.evaluate(async () => {
    const { invoke } = (window as AlertWindow).__TAURI_INTERNALS__;
    const snapshot = await invoke("chat_snapshot", { session: "t2" }) as { text: string };
    const request = snapshot.text.trim().split("\n").map((line) => JSON.parse(line))
      .findLast((event) => event.type === "request.opened");
    await invoke("chat_control", { session: "t2", frame: {
      v: 1, type: "request.respond", requestId: request.requestId,
      response: { outcome: "answer", answers: {} },
    } });
  });
  await page.clock.runFor(1_000);
  expect(await sounds(page)).toBe(3);
});

test("a mesa fica silenciosa entre resultados enquanto subagentes continuam", async ({ page }) => {
  await page.locator('#deskbar [data-tab="t1"]').click();
  await send(page, "background");
  await page.clock.runFor(4_000);
  expect(await sounds(page)).toBe(0);
  await page.locator('#deskbar [data-tab="t1"]').click();
  await page.evaluate(() => { (window as AlertWindow).focused = false; });
  await page.clock.runFor(4_000);
  expect(await sounds(page)).toBe(0);
  await page.clock.runFor(5_000);
  expect(await sounds(page)).toBe(1);
  await done(page);
  await page.clock.runFor(1_000);
  expect(await sounds(page)).toBe(1);
});
