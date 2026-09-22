import { expect, test, type Locator } from "@playwright/test";
import type { Board, Choice } from "../src/types";

type ComposerWindow = Window & {
  mock: { line: (tab: string, event: unknown) => void };
  controls: unknown[];
  __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

async function fits(composer: Locator) {
  await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(await composer.evaluate(root => {
    const outer = root.getBoundingClientRect();
    const controls = [...root.querySelectorAll("button")]
      .filter(button => button.getClientRects().length)
      .map(button => button.getBoundingClientRect());
    return root.scrollWidth <= root.clientWidth && controls.every((box, i) =>
      box.left >= outer.left && box.right <= outer.right && box.bottom <= outer.bottom &&
      controls.slice(i + 1).every(other => box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top));
  })).toBe(true);
  const send = await composer.locator(".send").boundingBox();
  expect(send!.width).toBe(28);
  expect(send!.height).toBe(28);
}

test("conversation footer keeps controls accessible without overlap", { tag: "@webkit" }, async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("mock:cloud", JSON.stringify({ user: { id: "user1", name: "Alice", email: "alice@example.com" }, origin: "https://app.prometeu.co", offline: false }));
    localStorage.setItem("mock:organizations", JSON.stringify([
      { id: "organization1", slug: "one", name: "One", member: "membership1", role: "owner" },
    ]));
  });
  await page.goto("/");
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  // Cloud discovery can rebuild the sidebar between pointer down and click; desk tiles stay mounted.
  await page.locator('#tiles .tile[data-tab="t1"] .topen').click();
  // Wait for the initial snapshot before emitting live state, or its ready state can overwrite busy.
  await expect(page.locator("#chatwrap .feed .turn").first()).toBeVisible();
  await page.evaluate(async choice => {
    const w = window as ComposerWindow;
    const { invoke } = w.__TAURI_INTERNALS__;
    const board = await invoke("load_board") as Board;
    const workspace = board.workspaces[0];
    workspace.tabs[0].choice = choice;
    workspace.tabs[0].status = "rodando";
    workspace.mcp = { base: "none", add: ["capim-ds"], remove: [] };
    workspace.plugins = { base: "none", add: ["caveman", "ponytail"], remove: [] };
    await invoke("set_stage", { id: workspace.id, stage: workspace.stage });
    w.mock.line("t1", { v: 1, at: 1, type: "session.state", state: "busy" });
    w.controls = [];
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "chat_control") w.controls.push(args);
      return invoke(command, args);
    };
  }, { agent: "codex", model: "gpt-5.6-sol", effort: "xhigh" } satisfies Choice);

  const composer = page.locator("#chatwrap .composer");
  const remote = composer.getByRole("button", { name: "Remote control", exact: true });
  await expect(composer.getByRole("status")).toHaveText("Working…");
  await expect(remote).toHaveAttribute("aria-pressed", "false");
  await remote.focus();
  await remote.press("Space");
  await expect(remote).toHaveAttribute("aria-pressed", "true");
  await expect(remote).not.toHaveCSS("box-shadow", "none");

  for (const width of [860, 600, 440, 320]) {
    await composer.evaluate((root, width) => { root.style.width = `${width}px`; }, width);
    await fits(composer);
  }
  await expect(remote.locator("span")).toBeHidden();
  await remote.press("Enter");
  await expect(remote).toHaveAttribute("aria-pressed", "false");
  await expect(remote).toHaveCSS("box-shadow", "none");
  await composer.getByRole("button", { name: "Stop", exact: true }).click();
  expect(await page.evaluate(() => (window as ComposerWindow).controls)).toEqual([
    { session: "t1", frame: { v: 1, type: "turn.interrupt" } },
  ]);

  await composer.locator("textarea").fill("Message from the footer");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("#chatwrap .feed")).toContainText("Understood: Message from the footer");

  await page.locator("#railbody .navitem", { hasText: "Desk" }).click();
  const tile = page.locator('#tiles .tile[data-tab="t1"]');
  await tile.evaluate(root => { root.style.width = "320px"; });
  await fits(tile.locator(".composer"));
  await expect(tile.getByRole("button", { name: "Remote control", exact: true })).toBeVisible();
});
