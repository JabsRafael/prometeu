import { expect, test, type Page } from "@playwright/test";
import type { Board } from "../src/types";

const picker = (page: Page) => page.locator(".ui-search-picker");
const choices = (page: Page) => picker(page).locator(".ui-search-picker-choice");
async function launcher(page: Page) {
  await page.goto("/");
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
  await page.locator("#railbody").getByRole("button", { name: "Create", exact: true }).click();
  await page.locator("#d-model").click();
}
async function board(page: Page) {
  return page.evaluate(async () => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<Board> } }).__TAURI_INTERNALS__;
    return invoke("load_board");
  });
}

test("model picker searches a large native catalog and explicitly selects an additional model", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:modelCatalog:codex", JSON.stringify(
    Array.from({ length: 100 }, (_, n) => ({ id: `native-${n}`, label: `Native model ${n}`, efforts: ["low", "high"], additional: n === 99 })),
  )));
  await launcher(page);
  await picker(page).getByRole("searchbox").fill("native-99");
  await expect(choices(page)).toHaveCount(0);
  await picker(page).getByRole("checkbox", { name: "Show additional models" }).check();
  await expect(choices(page)).toHaveCount(1);
  await expect(choices(page)).toContainText("Native model 99");
  await picker(page).getByRole("searchbox").fill("Codex");
  await expect(choices(page)).toHaveCount(101);
  await picker(page).getByRole("searchbox").fill("native-99");
  await choices(page).click();
  await expect(page.locator("#d-model")).toContainText("Native model 99");
  // Workspace tools remain available when choosing a Codex model.
  await expect(page.locator("#d-plugins")).toBeVisible();
  await expect(page.locator("#d-mcp")).toBeVisible();
  await page.locator("#d-effort").click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Agent default", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { name: "High", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { name: "Max", exact: true })).toHaveCount(0);
});

test("model picker wraps descriptions and keeps favorites inside their rows", { tag: "@webkit" }, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:modelCatalog:codex", JSON.stringify([
    { id: "native-model-with-a-long-identifier-for-the-provider", label: "Native model with a long name and an extended context window", efforts: [] },
    { id: "short", label: "Short model", efforts: [] },
  ])));
  await launcher(page);
  await picker(page).getByRole("searchbox").fill("Codex");
  await picker(page).getByRole("button", { name: /^Favorite Native model/ }).click();
  await expect(picker(page).getByRole("button", { name: /^Unfavorite Native model/ }).first()).toHaveAttribute("aria-pressed", "true");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await picker(page).locator(".ui-search-picker-list").evaluate(list => {
      const bounds = list.getBoundingClientRect();
      return list.scrollWidth <= list.clientWidth && [...list.querySelectorAll(".ui-search-picker-row")].every(row => {
        const area = row.getBoundingClientRect();
        return [...row.querySelectorAll(".ui-search-picker-text, .ui-search-picker-secondary")].every(control => {
          const box = control.getBoundingClientRect();
          return box.top >= area.top && box.bottom <= area.bottom && box.left >= bounds.left && box.right <= bounds.right
            && control.scrollWidth <= control.clientWidth;
        });
      });
    })).toBe(true);
    const star = picker(page).getByRole("button", { name: /^Unfavorite Native model/ }).first();
    await picker(page).getByRole("searchbox").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(star).toBeFocused();
    await expect(star).toHaveCSS("outline-style", "solid");
    const size = (await star.boundingBox())!;
    expect(size.width).toBe(size.height);
  }
});

test("model picker failed refresh preserves stale catalog and conversation state", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
  await page.locator("#railbody .navitem.sub .lbl").getByText("Hello", { exact: true }).click();
  const before = (await board(page)).workspaces[0];
  await page.locator("#chatwrap .composer .mdl").click();
  await expect(choices(page).filter({ hasText: "Sonnet" }).first()).toBeVisible();
  await page.evaluate(() => localStorage.setItem("mock:catalogError:claude", "err.modelsCatalog.timeout"));
  await picker(page).getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(picker(page)).toContainText("Showing the last known list");
  await expect(choices(page).filter({ hasText: "Sonnet" }).first()).toBeVisible();
  const after = (await board(page)).workspaces[0];
  expect(after.model).toBe(before.model);
  expect(after.effort).toBe(before.effort);
  expect(after.tabs).toEqual(before.tabs);
  await page.evaluate(() => localStorage.removeItem("mock:catalogError:claude"));
  await picker(page).getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(picker(page)).not.toContainText("Showing the last known list");
});

test("model picker launcher resolves a unique legacy selection after delayed discovery", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("prometeu:model", "delayed-native");
    localStorage.setItem("mock:modelCatalog:codex", JSON.stringify([{ id: "delayed-native", label: "Delayed native", efforts: [] }]));
    localStorage.setItem("mock:catalogDelay:codex", "12345");
    // Hold only this mock query so the assertion does not depend on machine speed.
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 12345 && typeof handler === "function") {
        (window as unknown as { releaseModels: () => void }).releaseModels = () => handler(...args);
        return 0;
      }
      return schedule(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  });
  await page.goto("/");
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
  await page.locator("#railbody").getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator("#d-model")).toContainText("Choose model");
  await expect(page.locator("#d-go")).toBeDisabled();
  await page.evaluate(() => (window as unknown as { releaseModels: () => void }).releaseModels());
  await expect(page.locator("#d-model")).toContainText("Delayed native");
  await expect(page.locator("#d-go")).toBeEnabled();
});

test("model picker new tab keeps the terminal action and selects another provider", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
  await page.locator("#railbody .navitem.sub .lbl").getByText("Hello", { exact: true }).click();
  await page.locator("#tabbar .tabadd .caret").click();
  await expect(choices(page).filter({ hasText: "New terminal" })).toBeVisible();
  await picker(page).getByRole("searchbox").fill("GPT-5.6-Sol");
  await choices(page).click();
  await expect(page.locator("#chatwrap .composer .mdl")).toContainText("GPT-5.6-Sol");
  const workspace = (await board(page)).workspaces[0];
  expect(workspace.tabs.at(-1)?.choice?.agent).toBe("codex");
});

test("model picker launcher preserves the draft until an unavailable saved model is corrected", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("prometeu:model-choice", JSON.stringify({ agent: "claude", model: "removed-model" }));
    localStorage.setItem("prometeu:effort", "");
  });
  await launcher(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#d-go")).toBeDisabled();
  const before = (await board(page)).workspaces.length;
  await page.locator("#d-prompt").fill("Keep this draft");
  await page.locator("#d-prompt").press("Enter");
  expect((await board(page)).workspaces).toHaveLength(before);
  await expect(page.locator("#d-prompt")).toHaveValue("Keep this draft");
  await page.locator("#d-model").click();
  await choices(page).filter({ hasText: "Sonnet" }).click();
  await expect(page.locator("#d-go")).toBeEnabled();
});

test("model picker ignores stale model and effort callbacks after switching conversations", async ({ page }) => {
  await page.goto("/");
  await page.locator("#railbody .navitem.sub .lbl").getByText("Hello", { exact: true }).click();
  const stale = [];
  for (const control of ["model", "effort"] as const) {
    await page.locator(`#chatwrap .composer .${control === "model" ? "mdl" : "effort"}`).click();
    const option = control === "model" ? choices(page).filter({ hasText: "Sonnet" }) : page.getByRole("menuitemcheckbox", { name: "Low", exact: true });
    stale.push((await option.elementHandle())!);
    await page.keyboard.press("Escape");
  }
  await page.locator('#tabbar .tab[data-tab="t2"]').click();
  await expect(page.locator("#tabbar .tab.on")).toHaveAttribute("data-tab", "t2");
  const before = (await board(page)).workspaces[0].tabs;
  // Both controls have their own callback guard in ChatView.
  for (const option of stale) {
    await option.evaluate((node: HTMLElement) => node.click());
    expect((await board(page)).workspaces[0].tabs).toEqual(before);
  }
});
