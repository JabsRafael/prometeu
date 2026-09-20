import { expect, test, type Page } from "@playwright/test";
import type { Board } from "../src/types";

const picker = (page: Page) => page.locator(".ui-search-picker");
const choices = (page: Page) => picker(page).locator(".ui-search-picker-choice");
async function launcher(page: Page) {
  await page.goto("/");
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
  await page.locator("#railbody").getByRole("button", { name: "Criar", exact: true }).click();
  await page.locator("#d-model").click();
}
async function board(page: Page) {
  return page.evaluate(async () => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<Board> } }).__TAURI_INTERNALS__;
    return invoke("load_board");
  });
}

test("model picker searches a large native catalog by model and provider", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:modelCatalog:codex", JSON.stringify(
    Array.from({ length: 100 }, (_, n) => ({ id: `native-${n}`, label: `Native model ${n}`, efforts: ["low", "high"] })),
  )));
  await launcher(page);
  await picker(page).getByRole("searchbox").fill("native-99");
  await expect(choices(page)).toHaveCount(1);
  await expect(choices(page)).toContainText("Native model 99");
  await picker(page).getByRole("searchbox").fill("Codex");
  await expect(choices(page)).toHaveCount(101);
  await picker(page).getByRole("searchbox").fill("native-99");
  await choices(page).click();
  await expect(page.locator("#d-model")).toContainText("Native model 99");
  await page.locator("#d-effort").click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Padrão do agente", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { name: "Alto", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { name: "Máximo", exact: true })).toHaveCount(0);
});

test("model picker favorites preserve provider identity for duplicated model IDs", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mock:modelCatalog:claude", JSON.stringify([{ id: "shared", label: "Shared Claude", efforts: [] }]));
    localStorage.setItem("mock:modelCatalog:codex", JSON.stringify([{ id: "shared", label: "Shared Codex", efforts: [] }]));
    localStorage.setItem("prometeu:model", "shared");
  });
  await launcher(page);
  await picker(page).getByRole("searchbox").fill("shared");
  await expect(choices(page)).toHaveCount(2);
  await expect(page.locator("#d-go")).toBeDisabled();
  await picker(page).getByRole("button", { name: "Favoritar Shared Codex · Codex", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("prometeu:model-favorites")!))).toEqual([{ agent: "codex", model: "shared" }]);
  await choices(page).filter({ hasText: "Shared Codex" }).first().click();
  await expect(page.locator("#d-model")).toContainText("Shared Codex");
  await expect(page.locator("#d-go")).toBeEnabled();
  await expect(page.locator("#d-effort")).toBeHidden();
  await page.locator("#d-model").click();
  await picker(page).getByRole("searchbox").fill("shared");
  await expect(picker(page).getByRole("button", { name: "Remover Shared Codex · Codex dos favoritos", exact: true }).first()).toBeVisible();
  await expect(picker(page).getByRole("button", { name: "Favoritar Shared Claude · Claude", exact: true })).toBeVisible();
});

test("model picker reveals additional models explicitly", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:modelCatalog:codex", JSON.stringify([
    { id: "visible", label: "Visible model", efforts: [] },
    { id: "additional", label: "Additional native model", efforts: [], additional: true },
  ])));
  await launcher(page);
  await picker(page).getByRole("searchbox").fill("Additional native");
  await expect(choices(page)).toHaveCount(0);
  await picker(page).getByRole("checkbox", { name: "Mostrar modelos adicionais" }).check();
  await expect(choices(page)).toHaveCount(1);
  await choices(page).click();
  await expect(page.locator("#d-model")).toContainText("Additional native model");
});

test("model picker failed refresh preserves stale catalog and conversation state", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  const before = (await board(page)).workspaces[0];
  await page.locator("#chatwrap .composer .mdl").click();
  await expect(choices(page).filter({ hasText: "Sonnet" }).first()).toBeVisible();
  await page.evaluate(() => localStorage.setItem("mock:catalogError:claude", "err.modelsCatalog.timeout"));
  await picker(page).getByRole("button", { name: "Atualizar agora", exact: true }).click();
  await expect(picker(page)).toContainText("Exibindo a última lista conhecida");
  await expect(choices(page).filter({ hasText: "Sonnet" }).first()).toBeVisible();
  const after = (await board(page)).workspaces[0];
  expect(after.model).toBe(before.model);
  expect(after.effort).toBe(before.effort);
  expect(after.tabs).toEqual(before.tabs);
  await page.evaluate(() => localStorage.removeItem("mock:catalogError:claude"));
  await picker(page).getByRole("button", { name: "Atualizar agora", exact: true }).click();
  await expect(picker(page)).not.toContainText("Exibindo a última lista conhecida");
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
  await page.locator("#railbody").getByRole("button", { name: "Criar", exact: true }).click();
  await expect(page.locator("#d-model")).toContainText("Escolher modelo");
  await expect(page.locator("#d-go")).toBeDisabled();
  await page.evaluate(() => (window as unknown as { releaseModels: () => void }).releaseModels());
  await expect(page.locator("#d-model")).toContainText("Delayed native");
  await expect(page.locator("#d-go")).toBeEnabled();
});


test("model picker settings keep the trigger through refresh and persist provider identity", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
  await page.locator("#settings").click();
  await page.locator(".setnavitem").getByText("Padrões", { exact: true }).click();
  const model = page.locator(".setrow").filter({ has: page.locator("b", { hasText: /^Modelo$/ }) }).getByRole("button");
  await model.click();
  await picker(page).getByRole("searchbox").fill("GPT-5.6-Sol");
  await choices(page).click();
  await expect(model).toContainText("Codex");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("prometeu:model-choice")!))).toEqual({ agent: "codex", model: "gpt-5.6-sol" });
  await model.click();
  await picker(page).getByRole("button", { name: "Atualizar agora", exact: true }).click();
  await expect(picker(page)).not.toContainText("Carregando modelos");
  await page.keyboard.press("Escape");
  await expect(model).toBeFocused();
});

test("model picker new tab keeps the terminal action and selects another provider", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  await page.locator("#tabbar .tabadd .caret").click();
  await expect(choices(page).filter({ hasText: "Terminal novo" })).toBeVisible();
  await picker(page).getByRole("searchbox").fill("GPT-5.6-Sol");
  await choices(page).click();
  await expect(page.locator("#chatwrap .composer .mdl")).toContainText("GPT-5.6-Sol");
  const workspace = (await board(page)).workspaces[0];
  expect(workspace.tabs.at(-1)?.choice?.agent).toBe("codex");
});

for (const invalid of ["model", "effort"] as const) {
  test(`model picker launcher blocks an unavailable saved ${invalid} until explicitly corrected`, async ({ page }) => {
    await page.addInitScript(invalid => {
      localStorage.setItem("prometeu:model-choice", JSON.stringify({ agent: "claude", model: invalid === "model" ? "removed-model" : "sonnet" }));
      localStorage.setItem("prometeu:effort", invalid === "effort" ? "removed-effort" : "");
    }, invalid);
    await launcher(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#d-go")).toBeDisabled();
    const before = (await board(page)).workspaces.length;
    await page.locator("#d-prompt").fill("Keep this draft");
    await page.locator("#d-prompt").press("Enter");
    expect((await board(page)).workspaces).toHaveLength(before);
    await expect(page.locator("#d-prompt")).toHaveValue("Keep this draft");
    if (invalid === "model") {
      await page.locator("#d-model").click();
      await choices(page).filter({ hasText: "Sonnet" }).click();
    } else {
      await page.locator("#d-effort").click();
      await page.getByRole("menuitemcheckbox", { name: "Padrão do agente", exact: true }).click();
    }
    await expect(page.locator("#d-go")).toBeEnabled();
  });
}

for (const control of ["model", "effort"] as const) {
  test(`model picker ignores stale ${control} callbacks after switching conversations`, async ({ page }) => {
    await page.goto("/");
    await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
    await page.locator(`#chatwrap .composer .${control === "model" ? "mdl" : "effort"}`).click();
    const option = control === "model" ? choices(page).filter({ hasText: "Sonnet" }) : page.getByRole("menuitemcheckbox", { name: "Baixo", exact: true });
    const stale = await option.elementHandle();
    await page.keyboard.press("Escape");
    await page.locator('#tabbar .tab[data-tab="t2"]').click();
    await expect(page.locator("#tabbar .tab.on")).toHaveAttribute("data-tab", "t2");
    const before = (await board(page)).workspaces[0].tabs;
    // Exercise a callback retained by an already-open popup after the view attaches elsewhere.
    await stale!.evaluate((node: HTMLElement) => node.click());
    expect((await board(page)).workspaces[0].tabs).toEqual(before);
  });
}
