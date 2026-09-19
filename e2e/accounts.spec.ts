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
  await expect(page.locator('#status [data-provider="codex"]')).toHaveText("—");
});

test("contas: Gemini conecta API key uma vez, sem ativar nem persistir o segredo", async ({ page }) => {
  await page.goto("/");
  const panel = await openAccounts(page, "gemini");
  await panel.getByRole("button", { name: "Adicionar conta" }).click();
  let dialog = page.getByRole("dialog", { name: "Adicionar conta" });
  await dialog.getByRole("button", { name: "Método de autenticação" }).click();
  await page.getByRole("menuitemcheckbox", { name: "API key" }).click();
  await dialog.getByRole("button", { name: "Continuar" }).click();
  dialog = page.getByRole("dialog", { name: "Adicionar conta" });
  const secret = "test-private-api-key-1234";
  await dialog.getByLabel("API key", { exact: true }).fill(secret);
  await dialog.getByRole("button", { name: "Conectar", exact: true }).click();
  const added = panel.locator(".uaccount", { hasText: "API key · 1234" });
  await expect(added.locator(".account-select")).toHaveAttribute("aria-pressed", "false");
  await expect(added.locator(".account-select")).toBeFocused();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret);
  await added.locator(".account-select").click();
  await expect(page.locator('#status [data-provider="gemini"]')).toHaveText("—");
  await action(page, added, "Reconectar");
  await expect(page.getByRole("dialog", { name: "Reconectar" }).getByLabel("API key", { exact: true })).toHaveValue("");
});

test("contas: configurações mostram agente não instalado", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:geminiMissing", "1"));
  await page.goto("/");
  const panel = await openAccounts(page);
  await panel.getByRole("button", { name: "Gerenciar contas" }).click();
  const gemini = page.locator('#settingsView [data-provider-accounts="gemini"]');
  await expect(gemini).toContainText("Instale Gemini");
  await expect(gemini.getByRole("button", { name: "Adicionar conta" })).toBeDisabled();
});
