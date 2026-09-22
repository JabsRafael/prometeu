import { expect, test, type Locator, type Page } from "@playwright/test";

async function openAccounts(page: Page, provider = "codex") {
  await page.locator(`#status [data-provider="${provider}"]`).click();
  return page.getByRole("dialog", { name: "Cotas" });
}

async function action(page: Page, card: Locator, label: string) {
  await card.getByRole("button", { name: "Ações da conta" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

test("contas no rodapé trocam globalmente, preservam conversa e a seleção do outro provider", async ({ page }) => {
  await page.goto("/");
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  const before = await page.locator("#chatwrap").innerText();
  const panel = await openAccounts(page);
  const work = panel.locator(".uaccount", { hasText: "trabalho@exemplo.com" });
  const quota = await work.locator(".urow").last().boundingBox();
  await page.mouse.click(quota!.x + quota!.width / 2, quota!.y + quota!.height / 2);
  await expect(work.locator(".account-select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('#status [data-provider="codex"]')).toHaveText("5h 10% · 7d 26%");
  await page.evaluate(async () => {
    const windowWithMock = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string) => Promise<Record<string, { windows: { pct: number }[] }>> };
      mock: { usage: (value: unknown) => void };
    };
    const usage = await windowWithMock.__TAURI_INTERNALS__.invoke("usage");
    usage.codex.windows.forEach((window) => { window.pct = 99; });
    windowWithMock.mock.usage(usage);
  });
  await expect(page.locator('#status [data-provider="codex"] .utext')).toContainText("7d 26%");
  await expect(page.locator('#status [data-provider="claude"]')).toHaveText("5h 16% · 7d 78% · Fable 72%");
  await page.keyboard.press("Escape");
  expect(await page.locator("#chatwrap").innerText()).toBe(before);
  await page.evaluate(() => {
    const mock = (window as unknown as { mock: { accountError: (error: string) => void } }).mock;
    mock.accountError('i18n:{"code":"err.account.disconnected"}');
  });
  await expect(page.locator("#msg")).toHaveText("Reconecte esta conta antes de ativá-la.");
  await page.reload();
  await expect(page.locator('#status [data-provider="codex"]')).toHaveText("5h 10% · 7d 26%");
  await openAccounts(page);
  await expect(work.locator(".account-select")).toHaveAttribute("aria-pressed", "true");
  await openAccounts(page, "claude");
  await expect(panel.locator('[data-account="claude"] .account-select')).toHaveAttribute("aria-pressed", "true");
  const other = panel.locator(".uaccount", { hasText: "trabalho@exemplo.com" }).locator(".account-select");
  await other.focus();
  await page.keyboard.press("Space");
  await expect(other).toHaveAttribute("aria-pressed", "true");
});

test("login no rodapé começa sem apelido e permite cancelar e reconectar", async ({ page }) => {
  await page.goto("/");
  const panel = await openAccounts(page, "claude");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await panel.getByRole("button", { name: "Adicionar conta" }).click();
  await expect(panel.getByRole("status")).toContainText("Conclua o login no navegador.");
  await panel.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveCount(0);
  const added = panel.locator(".uaccount").last();
  await expect(added.locator(".account-select")).toBeDisabled();
  await action(page, added, "Reconectar");
  await expect(added.locator(".account-select")).toBeEnabled();
  await expect(added.locator("strong")).toHaveText("nova@exemplo.com");
  // Connecting an account does not change selection without an explicit choice.
  await expect(panel.locator('[data-account="claude"] .account-select')).toHaveAttribute("aria-pressed", "true");
  await added.locator(".account-select").click();
  await expect(added.locator(".account-select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('#status [data-provider="claude"]')).toHaveText("5h 11% · 7d 27%");
});

test("remover todas as contas limpa seleção e preserva conversa e outro provider", async ({ page }) => {
  await page.goto("/");
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  const before = await page.locator("#chatwrap").innerText();
  const panel = await openAccounts(page, "claude");
  await panel.locator(".uaccount", { hasText: "trabalho@exemplo.com" }).locator(".account-select").click();
  await openAccounts(page);
  const work = panel.locator(".uaccount", { hasText: "trabalho@exemplo.com" });
  await work.locator(".account-select").click();
  await expect(work.locator(".account-select")).toHaveAttribute("aria-pressed", "true");
  await action(page, work, "Remover conta");
  const confirm = page.getByRole("dialog", { name: "Remover conta ativa?" });
  await expect(confirm).toContainText("Novas mensagens");
  await confirm.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(work.locator(".account-select")).toHaveAttribute("aria-pressed", "true");
  await action(page, work, "Remover conta");
  await confirm.getByRole("button", { name: "Remover conta", exact: true }).click();
  await expect(work).toHaveCount(0);
  await expect(panel.locator('[data-account="codex"] .account-select')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('#status [data-provider="codex"]')).toHaveText("—");
  await action(page, panel.locator(".uaccount"), "Remover conta");
  await expect(panel.locator(".uaccount")).toHaveCount(0);
  await expect(panel.getByText("Nenhuma conta adicionada.")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.locator("#chatwrap").innerText()).toBe(before);
  await page.reload();
  await openAccounts(page);
  await expect(panel.locator(".uaccount")).toHaveCount(0);
  await expect(page.locator('#status [data-provider="codex"]')).toHaveText("—");
  await panel.getByRole("button", { name: "Adicionar conta" }).click();
  await expect(panel.getByRole("button", { name: "Ações da conta" })).toBeEnabled();
  await expect(panel.locator(".account-select")).toHaveAttribute("aria-pressed", "false");
  await panel.locator(".account-select").click();
  await expect(panel.locator(".account-select")).toHaveAttribute("aria-pressed", "true");
  await openAccounts(page, "claude");
  await expect(panel.locator(".uaccount", { hasText: "trabalho@exemplo.com" }).locator(".account-select")).toHaveAttribute("aria-pressed", "true");
});

test("cadastro antigo ignora apelidos e mostra email como texto", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('#status [data-provider="codex"]')).toBeVisible();
  const email = 'pessoal+"<img src=x onerror=alert(1)>"@exemplo.com';
  await page.evaluate(async (email) => {
    const backend = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<any> } }).__TAURI_INTERNALS__;
    const saved = await backend.invoke("accounts");
    const account = saved.accounts.find((account: { id: string }) => account.id === "codex");
    account.label = "Apelido antigo";
    account.email = email;
    localStorage.setItem("mock:accounts", JSON.stringify(saved));
  }, email);
  await page.reload();
  const panel = await openAccounts(page);
  await expect(panel.locator('[data-account="codex"] strong')).toHaveText(email);
  await expect(panel.locator('[data-account="codex"] strong')).toHaveAttribute("title", email);
  await expect(panel.getByText("Apelido antigo")).toHaveCount(0);
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.locator("img")).toHaveCount(0);
});

test("contas: Antigravity usa a conta externa sem criar login ou ativar automaticamente", async ({ page }) => {
  await page.goto("/");
  const panel = await openAccounts(page, "antigravity");
  await panel.getByRole("button", { name: "Usar conta do agy" }).click();
  const added = panel.locator('[data-account="antigravity"]');
  await expect(added).toContainText("Conta do Antigravity");
  await expect(added.locator(".account-select")).toHaveAttribute("aria-pressed", "false");
  await expect(added.locator(".account-select")).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Usar conta do agy" })).toHaveCount(0);
  await expect(panel).toContainText("Conta do agy adicionada");
  await added.locator(".account-select").click();
  await expect(added.locator(".account-select")).toHaveAttribute("aria-pressed", "true");
  await expect(panel).toContainText("Gemini Models");
  await expect(panel).toContainText("Claude and GPT models");
  await expect(panel).toContainText("59% livre");
  await expect(panel).toContainText("97% livre");
  await expect(page.locator('#status [data-provider="antigravity"]')).not.toHaveText("—");
});


test("contas: remover última conta sem CLI mantém foco no grupo", { tag: "@webkit" }, async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mock:antigravityMissing", "1");
    localStorage.setItem("mock:accounts", JSON.stringify({ accounts: [
      { id: "antigravity", provider: "antigravity", connected: true, revision: 0, authMethod: "external" },
    ], active: {}, login: null }));
  });
  await page.goto("/");
  await page.locator("#settings").click();
  await page.locator("#settingsView").getByRole("button", { name: "Contas", exact: true }).click();
  const group = page.locator('#settingsView [data-provider-accounts="antigravity"]');
  await action(page, group.locator(".uaccount"), "Remover conta");
  await expect(group.locator(".uaccount")).toHaveCount(0);
  await expect(group).toContainText("Instale Antigravity");
  await expect(group.getByRole("button", { name: "Usar conta do agy" })).toBeDisabled();
  await expect(group).toBeFocused();
});

test("contas: launcher preserva o pedido até selecionar uma conta conectada", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("prometeu:model", "gemini-3.8-flash-high");
    localStorage.setItem("mock:accounts", JSON.stringify({ accounts: [
      { id: "antigravity", provider: "antigravity", email: "pessoa@exemplo.com", connected: true, revision: 0, authMethod: "external" },
    ], active: {}, login: null }));
  });
  await page.goto("/");
  await page.locator('#status [data-provider="antigravity"]').waitFor();
  await page.locator("#railbody").getByRole("button", { name: "Criar", exact: true }).click();
  await page.locator("#d-model").click();
  await page.locator(".ui-search-picker-choice", { hasText: "Gemini 3.8 Flash (High)" }).click();
  const prompt = page.locator("#d-prompt");
  await prompt.fill("Meu pedido preservado");
  const workspaceIds = () => page.evaluate(async () => {
    const backend = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<{ workspaces: { id: string }[] }> } }).__TAURI_INTERNALS__;
    return (await backend.invoke("load_board")).workspaces.map(workspace => workspace.id);
  });
  const before = await workspaceIds();
  await prompt.press("Enter");
  const picker = page.getByRole("dialog", { name: "Usar esta conta", exact: true });
  await expect(picker).toBeVisible();
  expect(await workspaceIds()).toEqual(before);
  await expect(prompt).toHaveValue("Meu pedido preservado");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue("Meu pedido preservado");
  await prompt.press("Enter");
  await expect(picker).toBeVisible();
  const account = picker.locator('[data-account="antigravity"]');
  await expect(account).toContainText("Usar esta conta");
  await expect(account.locator(".account-select")).toHaveAttribute("aria-pressed", "false");
  await account.locator(".account-select").click();
  await picker.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator("#d-account")).toContainText("Conta do Antigravity");
  await expect(prompt).toHaveValue("Meu pedido preservado");
  await prompt.press("Enter");
  await expect(page.locator("#veil")).toBeHidden();
  await expect(page.locator("#crumb")).toContainText("Meu pedido preservado");
});
