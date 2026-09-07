import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, title = "Ola") {
  await page.goto("/");
  await page.locator("#railbody .navitem.sub .lbl").getByText(title, { exact: true }).click();
  await page.locator("#tab-diff").click();
  await expect(page.locator("#git-message")).toBeVisible();
}
const group = (page: Page, scope: string) => page.locator(`.git-group[data-scope="${scope}"]`);

test("stage parcial mostra dois diffs e commit deixa alterações posteriores fora", async ({ page }) => {
  await open(page);
  const staged = group(page, "staged"), changes = group(page, "changes");
  await expect(staged.locator('.git-file[data-path="src/style.css"]')).toHaveCount(1);
  await expect(changes.locator('.git-file[data-path="src/style.css"]')).toHaveCount(1);
  await staged.locator(".git-file-name").first().click();
  await expect(page.locator(".git-review-scope")).toContainText("Alterações em stage");
  const stagedPatch = await page.locator('#dlist .dfile[data-key$="src/style.css"] .dbody').innerText();
  await changes.locator('.git-file[data-path="src/style.css"] .git-file-name').click();
  await expect(page.locator(".git-review-scope")).toContainText("Alterações locais");
  expect(await page.locator('#dlist .dfile[data-key$="src/style.css"] .dbody').innerText()).not.toBe(stagedPatch);
  // Um clique traz o grupo inteiro empilhado: ler o resto é rolar, não voltar
  // à lista para escolher o próximo arquivo.
  await expect(page.locator("#dlist .dfile")).toHaveCount(2);
  await expect(page.locator('#dlist .dfile[data-key$="public/logo.png"]')).toBeVisible();
  await page.locator("#git-message").fill("   ");
  await expect(page.locator("#git-commit")).toBeDisabled();
  await page.locator("#git-message").fill("fix: preparar somente o snapshot revisado");
  await page.locator("#git-commit").click();
  await expect(staged.locator(".git-file")).toHaveCount(0);
  await expect(changes.locator('.git-file[data-path="src/style.css"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Push ↑2", exact: true })).toBeEnabled();
  await expect(page.locator("#git-message")).toHaveValue("");
  await page.getByRole("button", { name: "Push ↑2", exact: true }).click();
  await expect(page.getByRole("button", { name: "Push ↑0", exact: true })).toBeDisabled();
  await expect(changes.locator('.git-file[data-path="src/style.css"]')).toHaveCount(1);
  await page.locator(".git-nav").getByRole("button", { name: "Histórico", exact: true }).click();
  await expect(page.locator(".git-history-row").first()).toContainText("snapshot revisado");
});

test("rascunho do commit sobrevive à atualização e erro não apaga o stage", async ({ page }) => {
  await open(page);
  await page.locator("#git-message").fill("mensagem ainda em edição");
  await page.evaluate(() => {
    const internals = (window as any).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = (command: string, args: any, options: any) => command === "workspace_git_action" && args.operation === "commit"
      ? Promise.reject('i18n:{"code":"err.git.changed"}') : original(command, args, options);
  });
  await page.locator(".git-panel").getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(page.locator("#git-message")).toHaveValue("mensagem ainda em edição");
  await page.locator("#git-commit").click();
  await expect(page.locator("#msg")).toContainText("O estado do Git mudou");
  await expect(group(page, "staged").locator(".git-file")).toHaveCount(1);
  await expect(page.locator("#git-message")).toHaveValue("mensagem ainda em edição");
});

test("branch abre lançador em worktree e publicação continua explícita", async ({ page }) => {
  await open(page, "Tela igual ao Conductor");
  await expect(page.getByRole("button", { name: "Publicar branch", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Publicar branch", exact: true }).click();
  await expect(page.locator(".git-upstream")).toContainText("origin/");
  await expect(page.getByRole("button", { name: "Publicar branch", exact: true })).toHaveCount(0);
  await page.locator("#crumb .branch").click();
  await page.getByRole("textbox", { name: "Buscar branch…", exact: true }).fill("feature/local-work");
  await page.locator(".git-branch-row").getByRole("button", { name: "Criar workspace", exact: true }).click();
  await expect(page.locator("#d-base")).toContainText("feature/local-work");
  await expect(page.locator("#d-wt")).toBeDisabled();
});

test("conflito usa resultado revisado e permite concluir merge sem mudanças no índice", async ({ page }) => {
  await open(page, "Ícone do app");
  await group(page, "conflict").locator(".git-file-name").click();
  await expect(page.locator("#git-commit")).toBeDisabled();
  await page.getByRole("button", { name: "Aceitar versão atual", exact: true }).click();
  await page.getByRole("button", { name: "Salvar resolução", exact: true }).click();
  await expect(group(page, "conflict")).toHaveCount(0);
  await expect(group(page, "staged").locator(".git-file")).toHaveCount(0);
  await page.locator("#git-message").fill("merge: preservar versão atual");
  await expect(page.locator("#git-commit")).toHaveText("Concluir merge");
  await expect(page.locator("#git-commit")).toBeEnabled();
  await page.locator("#git-commit").click();
  await expect(page.locator("#git-commit")).toHaveText("Commit");
});

test("comparação mostra commits sem misturar mudanças locais", async ({ page }) => {
  await open(page);
  await page.locator(".git-nav").getByRole("button", { name: "Comparar branch", exact: true }).click();
  await expect(page.locator(".git-review-scope")).toContainText("somente commits");
  await expect(page.locator(".git-review-list .dfile")).toHaveCount(1);
  await expect(page.locator('.git-review-list .dfile[data-key$="/src/style.css"]')).toHaveCount(0);
  await expect(group(page, "changes").locator('.git-file[data-path="src/style.css"]')).toHaveCount(1);
});

test("erro temporário de status preserva os rascunhos e restaura o editor de conflito", async ({ page }) => {
  await open(page, "Ícone do app");
  await group(page, "conflict").locator(".git-file-name").click();
  await page.locator("#git-message").fill("merge: rascunho ainda não enviado");
  await page.locator(".git-conflict-result").fill(".card {\n  gap: 10px;\n}\n");
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.failGitStatus = true;
    w.__TAURI_INTERNALS__.invoke = (command: string, args: any, options: any) =>
      command === "workspace_git_status" && w.failGitStatus
        ? Promise.reject('i18n:{"code":"err.git.changed"}') : original(command, args, options);
  });
  const refresh = page.locator(".git-panel").getByRole("button", { name: "Atualizar", exact: true });
  await refresh.click();
  await expect(page.locator("#dlist .git-error")).toContainText("O estado do Git mudou");
  await expect(page.locator("#git-message")).toHaveValue("merge: rascunho ainda não enviado");
  await expect(page.locator("#git-commit")).toBeDisabled();
  await page.evaluate(() => { (window as any).failGitStatus = false; });
  await refresh.click();
  await expect(page.locator("#dlist .git-error")).toHaveCount(0);
  await expect(page.locator(".git-conflict-result")).toHaveValue(".card {\n  gap: 10px;\n}\n");
  await expect(page.locator("#git-message")).toHaveValue("merge: rascunho ainda não enviado");
  await expect(page.getByRole("button", { name: "Salvar resolução", exact: true })).toBeEnabled();
});

test("botão antigo de stage não prepara arquivos de outro repositório durante carregamento", async ({ page }) => {
  await open(page, "Contratação pelo portal");
  await group(page, "changes").locator('.git-file[data-path="src/style.css"] .git-file-name').click();
  await expect(page.locator("#dcrumb").getByRole("button", { name: "Adicionar tudo ao stage", exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.oldGitStage = [...document.querySelectorAll<HTMLButtonElement>("#dcrumb button")]
      .find(button => button.textContent === "Adicionar tudo ao stage");
    w.gitActions = [];
    w.delayedGitDiffs = [];
    w.delayGitDiff = true;
    w.__TAURI_INTERNALS__.invoke = (command: string, args: any, options: any) => {
      if (command === "workspace_git_action") w.gitActions.push(structuredClone(args));
      if (command === "workspace_git_diff" && args.repo === 1 && w.delayGitDiff) {
        return new Promise(resolve => w.delayedGitDiffs.push(() => resolve(original(command, args, options))));
      }
      return original(command, args, options);
    };
  });
  await page.getByRole("button", { name: "Repositório", exact: true }).click();
  await page.locator(".menu .mrow", { hasText: "njord" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).delayedGitDiffs.length)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Repositório", exact: true })).toContainText("njord");
  await expect(page.locator("#dcrumb").getByRole("button", { name: "Adicionar tudo ao stage", exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).oldGitStage.click(); });
  expect(await page.evaluate(() => (window as any).gitActions)).toEqual([]);
  await page.evaluate(() => {
    const w = window as any;
    w.delayGitDiff = false;
    w.delayedGitDiffs.splice(0).forEach((release: () => void) => release());
  });
  await expect(page.locator("#dlist .dfile").first()).toBeVisible();
  await expect(group(page, "staged").locator(".git-file")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).gitActions)).toEqual([]);
});

test("Enter compara a base escolhida e voltar a Mudanças mantém o editor de conflito", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.gitDiffRequests = [];
    w.__TAURI_INTERNALS__.invoke = (command: string, args: any, options: any) => {
      if (command === "workspace_git_diff") {
        w.gitDiffRequests.push(structuredClone(args));
        if (args.scope === "conflict") return Promise.reject("unsupported diff scope: conflict");
        if (args.reference === "missing-branch") return Promise.reject("Unknown revision: missing-branch");
      }
      return original(command, args, options);
    };
  });
  await page.locator(".git-nav").getByRole("button", { name: "Comparar branch", exact: true }).click();
  await page.getByRole("textbox", { name: "Base", exact: true }).fill("missing-branch");
  await page.getByRole("textbox", { name: "Base", exact: true }).press("Enter");
  await expect(page.locator("#dlist .git-error")).toContainText("missing-branch");
  await expect(page.getByRole("textbox", { name: "Base", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Base", exact: true }).fill("origin/feature/review");
  await page.getByRole("textbox", { name: "Base", exact: true }).press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).gitDiffRequests.some(
    (args: any) => args.scope === "compare" && args.reference === "origin/feature/review",
  ))).toBe(true);
  await expect(page.locator(".git-review-scope")).toContainText("origin/feature/review");
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ícone do app", { exact: true }).click();
  await expect(group(page, "conflict").locator(".git-file-name")).toBeVisible();
  await group(page, "conflict").locator(".git-file-name").click();
  await page.locator(".git-conflict-result").fill("resolução em andamento\n");
  await page.locator("#tab-diff").click();
  await expect(page.locator(".git-conflict-result")).toHaveValue("resolução em andamento\n");
  await expect(page.locator("#dlist .git-error")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).gitDiffRequests.some((args: any) => args.scope === "conflict"))).toBe(false);
});

test("grupos recolhidos sobrevivem à atualização e ações Git ficam no cabeçalho", async ({ page }) => {
  await open(page);
  const staged = group(page, "staged"), toggle = staged.locator(".git-group-toggle");
  await page.locator("#git-message").fill("fix: manter rascunho");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(staged.locator(".git-file-name")).toBeHidden();
  await page.getByRole("button", { name: "Ações do Git", exact: true }).click();
  await page.locator(".menu .mrow", { hasText: "Fetch" }).click();
  await expect(page.getByRole("button", { name: "Pull ↓1", exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#git-message")).toHaveValue("fix: manter rascunho");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(staged.locator(".git-file-name")).toBeVisible();
  await staged.locator(".git-file .git-file-action").focus();
  await expect(staged.locator(".git-file .git-file-action")).toHaveCSS("opacity", "1");
  const history = page.locator(".git-nav").getByRole("button", { name: "Histórico", exact: true });
  await history.click();
  await expect(history).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".git-history-row").first()).toBeVisible();
  await page.locator(".git-nav").getByRole("button", { name: "Alterações", exact: true }).click();
  await expect(page.locator("#dlist .dfile").first()).toBeVisible();
  await expect(page.locator("#git-message")).toHaveValue("fix: manter rascunho");
});
