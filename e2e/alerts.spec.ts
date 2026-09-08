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
  type: "result", subtype: "success", is_error: false, duration_ms: 100,
});
const sounds = (page: Page) => page.evaluate(() => (window as AlertWindow).sounds / 2);

test("a mesa e o workspace só avisam conclusão fora da conversa visível, uma vez", async ({ page }) => {
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
  const tile = page.locator('#tiles .tile[data-tab="t1"]');
  await expect(tile).toBeVisible();
  await done(page);
  await done(page, "t2");
  expect(await sounds(page)).toBe(0);

  await page.locator('#deskbar [data-tab="t1"]').click();
  await expect(tile).toBeHidden();
  await done(page);
  await done(page);
  expect(await sounds(page)).toBe(1);

  // A repeated or stale snapshot is not a completion event.
  await page.evaluate(async () => {
    const { invoke } = (window as AlertWindow).__TAURI_INTERNALS__;
    const board = await invoke("load_board") as Board;
    const workspace = board.workspaces.find((w) => w.tabs.some((t) => t.id === "t1"))!;
    for (let i = 0; i < 10; i++) {
      workspace.tabs[0].status = i % 2 ? "pronta" : "rodando";
      await invoke("set_stage", { id: workspace.id, stage: workspace.stage });
    }
  });
  expect(await sounds(page)).toBe(1);

  // Reopening acknowledges the alert; replaying the same completion stays silent.
  await page.locator('#deskbar [data-tab="t1"]').click();
  await expect(tile).toBeVisible();
  expect(await sounds(page)).toBe(1);
  await page.evaluate(() => { (window as AlertWindow).focused = false; });
  await done(page);
  await done(page);
  expect(await sounds(page)).toBe(2);
  await page.evaluate(() => {
    (window as AlertWindow).focused = true;
    window.dispatchEvent(new Event("focus"));
  });

  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  await expect(page.locator("#wsView")).toBeVisible();
  await page.locator('#tabbar [data-tab="t1"]').click();
  await done(page);
  expect(await sounds(page)).toBe(2);
  await emit(page, "t2", {
    type: "control_request", request_id: "q-alert",
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion",
      input: { questions: [{ question: "Continuar?", options: [] }] } },
  });
  expect(await sounds(page)).toBe(3);
  await page.locator('#tabbar [data-tab="t2"]').click();
  await page.locator('#tabbar [data-tab="t1"]').click();
  await done(page, "t2");
  expect(await sounds(page)).toBe(4);
});
