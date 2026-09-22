import { expect, test, type Page } from "@playwright/test";
import type { Board } from "../src/types";

async function settings(page: Page) {
  await page.locator("#settings").click();
  await page.locator(".setnavitem").getByText("Ações", { exact: true }).click();
}
async function workspace(page: Page) {
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  await expect(page.locator("#wsView")).toBeVisible();
}

test("comando reutilizável preenche prompt editável e persiste após reabrir", async ({ page }) => {
  await page.goto("/");
  await settings(page);
  await page.getByRole("button", { name: "Novo comando", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configurar comando" });
  await dialog.getByLabel("Comando (sem /)", { exact: true }).fill("explicar");
  await dialog.getByLabel("Texto do prompt ou pedido inicial da tarefa").fill("Explique as alterações com exemplos.");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await workspace(page);
  const area = page.locator("#chatwrap .composer textarea");
  const count = await page.locator("#chatwrap .turn.user").count();
  await area.fill("/");
  const suggestions = page.locator(".menu.cmds");
  await expect(suggestions.locator(".mrow", { hasText: "/explicar" }).locator(".mbadge")).toHaveText("Prometeu");
  await expect(suggestions.locator(".mrow", { hasText: "/review" }).locator(".mbadge")).toHaveText("Prometeu");
  await expect(suggestions.locator(".mrow", { hasText: "/compact" })).toBeVisible();
  await expect(suggestions.locator(".mrow", { hasText: "/compact" }).locator(".mbadge")).toHaveCount(0);
  await area.fill("/explicar arquivo.ts");
  await area.press("Enter");
  await expect(area).toHaveValue("Explique as alterações com exemplos.\n\narquivo.ts");
  await expect(page.locator("#chatwrap .turn.user")).toHaveCount(count);
  await area.fill("outro contexto");
  await page.locator("#chatwrap .actionsbtn").click();
  await page.locator(".menu .mrow", { hasText: "/explicar" }).click();
  await expect(area).toHaveValue("Explique as alterações com exemplos.\n\noutro contexto");
});


test("model picker: editar instruções preserva modelo e esforço históricos do perfil", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#deskView")).toBeVisible();
  await page.evaluate(async () => {
    type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const board = await invoke("load_board") as Board;
    const profile = board.actions.profiles[0];
    profile.choice = { agent: "codex", model: "retired-model", effort: "retired-effort" };
    await invoke("actions_save", { catalog: board.actions });
  });
  await settings(page);
  await page.locator(".action-profile").first().getByRole("button", { name: "Editar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configurar agente" });
  await expect(dialog.getByLabel("Modelo", { exact: true })).toContainText("retired-model");
  await dialog.getByLabel("Prompt e instruções do agente", { exact: true }).fill("Preserve minha seleção anterior.");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toBeHidden();
  const choice = await page.evaluate(async () => {
    type Invoke = (command: string) => Promise<Board>;
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    return (await invoke("load_board")).actions.profiles[0].choice;
  });
  expect(choice).toEqual({ agent: "codex", model: "retired-model", effort: "retired-effort" });
});
