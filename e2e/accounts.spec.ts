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

test("falha de login mantém conta ativa e permite remover a tentativa", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:accountLoginError", "1"));
  await page.goto("/");
  const panel = await openAccounts(page);
  await panel.getByRole("button", { name: "Adicionar conta" }).click();
  const added = panel.locator(".uaccount", { hasText: "Nova conta" });
  await expect(added.getByRole("button", { name: "Ações da conta" })).toBeEnabled();
  await expect(added.locator(".account-select")).toBeDisabled();
  await expect(panel.locator('[data-account="codex"] .account-select')).toHaveAttribute("aria-pressed", "true");
  await action(page, added, "Remover conta");
  await expect(added).toHaveCount(0);
  await page.reload();
  await openAccounts(page);
  await expect(panel.locator(".uaccount")).toHaveCount(2);
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
  await page.getByRole("dialog", { name: "Remover conta ativa?" }).getByRole("button", { name: "Remover conta", exact: true }).click();
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

test("contas: configurações compartilham cartões e confirmam remoção ativa", async ({ page }) => {
  await page.goto("/");
  const panel = await openAccounts(page);
  await panel.getByRole("button", { name: "Gerenciar contas" }).click();
  const settings = page.locator("#settingsView");
  await expect(settings.getByRole("heading", { name: "Contas", exact: true })).toBeVisible();
  const active = settings.locator('[data-account="codex"]');
  await active.getByRole("button", { name: "Ações da conta" }).click();
  await page.getByRole("menuitem", { name: "Remover conta" }).click();
  const confirm = page.getByRole("dialog", { name: "Remover conta ativa?" });
  await expect(confirm).toContainText("Novas mensagens");
  await confirm.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(active.locator(".account-select")).toHaveAttribute("aria-pressed", "true");
  await active.getByRole("button", { name: "Ações da conta" }).click();
  await page.getByRole("menuitem", { name: "Remover conta" }).click();
  await confirm.getByRole("button", { name: "Remover conta", exact: true }).click();
  await expect(active).toHaveCount(0);
  await expect(settings.locator('[data-provider-accounts="codex"] .account-select')).toBeFocused();
  await expect(page.locator('#status [data-provider="codex"]')).toHaveText("—");
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
  await expect(panel.getByRole("button", { name: "Usar conta do agy" })).toBeDisabled();
  await added.locator(".account-select").click();
  await expect(added.locator(".account-select")).toHaveAttribute("aria-pressed", "true");
  await expect(panel).toContainText("Gemini Models");
  await expect(panel).toContainText("Claude and GPT models");
  await expect(panel).toContainText("59% livre");
  await expect(panel).toContainText("97% livre");
  await expect(page.locator('#status [data-provider="antigravity"]')).not.toHaveText("—");
});

test("contas: configurações mostram agente não instalado", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:antigravityMissing", "1"));
  await page.goto("/");
  const panel = await openAccounts(page);
  await panel.getByRole("button", { name: "Gerenciar contas" }).click();
  const antigravity = page.locator('#settingsView [data-provider-accounts="antigravity"]');
  await expect(antigravity).toContainText("Instale Antigravity");
  await expect(antigravity.getByRole("button", { name: "Usar conta do agy" })).toBeDisabled();
});

test("contas: configurações atualizam disponibilidade após descoberta atrasada", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mock:agentsDelay", "2000");
    localStorage.setItem("prometeu:configuracoes", "contas");
  });
  await page.goto("/");
  await page.locator("#settings").click();
  const group = page.locator('#settingsView [data-provider-accounts="antigravity"]');
  await expect(group.getByRole("button", { name: "Usar conta do agy" })).toBeEnabled();
  await expect(group).not.toContainText("Instale Antigravity");
});


test("contas: remover última conta sem CLI mantém foco no grupo", async ({ page }) => {
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
  await page.getByRole("menuitemcheckbox", { name: "Gemini 3.8 Flash (High)", exact: true }).click();
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
