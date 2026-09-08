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
  await page.screenshot({ path: "/tmp/prometeu-command-origin.png" });
  await area.fill("/explicar arquivo.ts");
  await area.press("Enter");
  await expect(area).toHaveValue("Explique as alterações com exemplos.\n\narquivo.ts");
  await expect(page.locator("#chatwrap .turn.user")).toHaveCount(count);
  await area.fill("outro contexto");
  await page.locator("#chatwrap .actionsbtn").click();
  await page.locator(".menu .mrow", { hasText: "/explicar" }).click();
  await expect(area).toHaveValue("Explique as alterações com exemplos.\n\noutro contexto");
});

test("perfil por projeto inicia tarefa em outra aba e permite pausar acompanhamento", async ({ page }) => {
  await page.goto("/");
  await settings(page);
  await page.getByRole("button", { name: "Mais opções · Agentes", exact: true }).click();
  await page.locator(".menu .mrow", { hasText: "Responsável pela PR" }).click();
  await expect(page.locator(".action-profile", { hasText: "Responsável pela PR" }).first()).toBeVisible();
  await page.getByLabel("Configuração dos agentes para", { exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "njord", exact: true }).click();
  await page.locator(".action-profile", { hasText: "Responsável pela PR" }).first().getByRole("button", { name: "Editar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configurar agente" });
  await dialog.getByLabel("Nome do agente", { exact: true }).fill("Revisor do njord");
  await dialog.getByLabel("Modelo", { exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Sonnet", exact: true }).click();
  await dialog.locator("summary", { hasText: "MCP, plugins e skills" }).click();
  await dialog.getByLabel("Skills a usar (nomes separados por vírgula)").fill("code-review, pr");
  await dialog.getByLabel("Herdar seleção do workspace").first().uncheck();
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toBeHidden();
  // The original fixture has a setup prompt pending in its second tab.
  await page.evaluate(async () => {
    type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const board = await invoke("load_board") as Board;
    for (const tab of board.workspaces[0].tabs) { tab.pending_prompt = null; tab.status = "pronta"; }
    await invoke("set_stage", { id: "sessao-0929", stage: "Fazendo" });
  });
  await workspace(page);
  await page.locator("#chatwrap .composer textarea").fill("/entregar");
  await page.locator("#chatwrap .composer textarea").press("Enter");
  await expect(page.locator("#tabbar .tab", { hasText: "Revisor do njord" })).toBeVisible();
  await expect(page.locator("#chatwrap .mdl")).toBeDisabled();
  await expect(page.locator("#chatwrap .mcpbtn")).toBeHidden();
  const monitor = page.locator("#chatwrap .taskwatch");
  await expect(monitor).toHaveText("Acompanhando PR");
  await monitor.click();
  await expect(monitor).toHaveText("Acompanhamento pausado");
  await monitor.click();
  await expect(monitor).toHaveText("Acompanhando PR");
  const task = await page.evaluate(async () => {
    type Invoke = (command: string) => Promise<Board>;
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    return (await invoke("load_board")).workspaces[0].tabs.find(t => t.task)?.task;
  });
  expect(task?.profile.choice.model).toBe("sonnet");
  expect(task?.profile.mcp).toEqual([]);
  expect(task?.profile.skills).toEqual(["code-review", "pr"]);
  await settings(page);
  await page.locator(".action-pr summary").click();
  await page.getByLabel("Ação do botão Open PR / Atualizar PR", { exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "/entregar", exact: true }).click();
  await workspace(page);
  await page.locator('#tabbar .tab[data-tab="t1"]').click();
  const original = page.locator("#chatwrap .composer textarea");
  await original.fill("/entregar contexto adicional");
  await original.press("Enter");
  await expect(original).toHaveValue("/entregar contexto adicional");
  await expect(page.locator("#msg")).toContainText("Esta tarefa já está em andamento");
  await original.fill("");
  await page.locator("#pr").click();
  await expect(page.locator("#chatwrap .taskwatch")).toHaveText("Acompanhando PR");
  await expect(page.locator("#tabbar .tab", { hasText: "Revisor do njord" })).toHaveCount(1);
});


test("Code review já vem pronto e a remoção não é desfeita ao reabrir", async ({ page }) => {
  await page.goto("/");
  await settings(page);
  const command = page.locator(".action-command", { hasText: "/review" });
  const profile = page.locator(".action-profile", { hasText: "Code review" });
  await expect(command).toHaveCount(1);
  await expect(profile).toHaveCount(1);
  await page.screenshot({ path: "/tmp/prometeu-actions-redesign.png" });
  await profile.getByRole("button", { name: "Editar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configurar agente" });
  await expect(dialog.getByLabel("Prompt e instruções do agente")).toHaveValue(/Review the changes/);
  await expect(dialog.getByLabel("Acompanhar PR após o trabalho inicial")).not.toBeChecked();
  expect(await dialog.locator(".ui-form-body").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/prometeu-review-editor.png" });
  await page.setViewportSize({ width: 390, height: 640 });
  expect(await dialog.locator(".ui-form-body").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 760 });
  expect(await page.locator(".actions-page").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await command.getByRole("button", { name: "Mais opções · Code review", exact: true }).click();
  await page.locator(".menu .mrow", { hasText: "Remover" }).click();
  await profile.getByRole("button", { name: "Mais opções · Code review", exact: true }).click();
  await page.locator(".menu .mrow", { hasText: "Remover" }).click();
  await page.reload();
  await settings(page);
  await expect(page.locator(".action-command")).toHaveCount(0);
  await expect(page.locator(".action-profile")).toHaveCount(0);
});
