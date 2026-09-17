import { expect, test, type Page } from "@playwright/test";

async function changeCatalog(page: Page, mode: "pending" | "error" | "new") {
  await page.evaluate(async (mode) => {
    type Invoke = (command: string, args?: Record<string, unknown>) => Promise<any>;
    const target = window as unknown as {
      __TAURI_INTERNALS__: { invoke: Invoke };
      catalogInvoke?: Invoke;
      finishModels?: () => void;
    };
    const backend = target.__TAURI_INTERNALS__;
    const original = target.catalogInvoke ??= backend.invoke;
    backend.invoke = async (command, args) => {
      if (command !== "agent_models") return original(command, args);
      if (args?.provider === "codex") return [];
      if (mode === "error") throw new Error("catalog unavailable");
      if (mode === "pending") await new Promise<void>(resolve => { target.finishModels = resolve; });
      return [{ id: "new-model", label: "Modelo anunciado", efforts: ["high"] }];
    };
    const accounts = await original("accounts");
    const next = accounts.accounts.find((account: { provider: string; id: string }) =>
      account.provider === "claude" && account.id !== accounts.active.claude);
    await original("account_select", { id: next.id });
  }, mode);
}

test("catálogo de modelos: falha visível, descoberta tardia e modelo aposentado fora do launcher", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#deskView")).toBeVisible();
  await changeCatalog(page, "error");
  await page.locator("#railbody").getByRole("button", { name: "Criar", exact: true }).click();
  await expect(page.locator("#d-go")).toBeDisabled();
  await page.locator("#d-model").click();
  await expect(page.locator(".menu")).toContainText("Falha ao carregar modelos");
  await expect(page.locator(".menu")).toContainText("Nenhum modelo disponível");
  await expect(page.locator(".menu")).not.toContainText("Opus");
  await page.keyboard.press("Escape");

  await changeCatalog(page, "pending");
  await page.locator("#d-model").click();
  await expect(page.locator(".menu")).toContainText("Carregando modelos");
  await expect(page.locator("#d-go")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as unknown as { finishModels: () => void }).finishModels());
  await expect(page.locator("#d-model")).toContainText("Modelo anunciado");
  await expect(page.locator("#d-go")).toBeEnabled();
  await page.locator("#d-model").click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Modelo anunciado", exact: true })).toBeVisible();
  await expect(page.locator(".menu")).not.toContainText("Opus");
});

test("catálogo de modelos: rótulo vivo no picker e histórico preservado na conversa", async ({ page }) => {
  await page.goto("/");
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  await expect(page.locator("#chatwrap .mdl")).toContainText("Opus (1M context)");
  await changeCatalog(page, "new");
  await page.locator("#chatwrap .mdl").click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Modelo anunciado", exact: true })).toBeVisible();
  await expect(page.locator(".menu")).not.toContainText("Opus");
  await page.keyboard.press("Escape");
  await expect(page.locator("#chatwrap .mdl")).toContainText("Opus");
});

test("catálogo de modelos: editar ação preserva escolha antiga sem oferecê-la novamente", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#deskView")).toBeVisible();
  await page.evaluate(async () => {
    const { invoke } = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<any> };
    }).__TAURI_INTERNALS__;
    const board = await invoke("load_board");
    board.actions.profiles[0].choice = { agent: "claude", model: "opus[1m]", effort: "high" };
    await invoke("actions_save", { catalog: board.actions });
  });
  await changeCatalog(page, "new");
  await page.locator("#settings").click();
  await page.locator(".setnavitem").getByText("Ações", { exact: true }).click();
  await page.locator(".action-profile").first().getByRole("button", { name: "Editar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configurar agente" });
  await expect(dialog.getByLabel("Modelo", { exact: true })).toHaveText(/Opus/);
  await dialog.getByLabel("Modelo", { exact: true }).click();
  await expect(page.locator(".menu")).not.toContainText("Opus");
  await expect(page.getByRole("menuitemcheckbox", { name: "Modelo anunciado", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { checked: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await dialog.getByLabel("Nome do agente", { exact: true }).fill("Revisor preservado");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toBeHidden();
  const choice = await page.evaluate(() => JSON.parse(localStorage.getItem("mock:actions")!).profiles[0].choice);
  expect(choice).toEqual({ agent: "claude", model: "opus[1m]", effort: "high" });
});
