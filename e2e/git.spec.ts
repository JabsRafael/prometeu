import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, title = "Ola") {
  await page.goto("/");
  await page.locator("#railbody .navitem.sub .lbl").getByText(title, { exact: true }).click();
  await page.locator("#tab-diff").click();
  await expect(mode(page, "changes")).toHaveAttribute("aria-current", "true");
}
const group = (page: Page, scope: string) => page.locator(`.git-group[data-scope="${scope}"]`);
const mode = (page: Page, scope: string) => page.locator(`.git-nav [data-mode="${scope}"]`);

test("Git: stage parcial mostra dois diffs e commit deixa alterações posteriores fora", async ({ page }) => {
  await open(page);
  const staged = group(page, "staged"), changes = group(page, "changes");
  await expect(changes.locator('.git-file[data-path="src/style.css"]')).toHaveCount(1);
  await expect(staged).toHaveCount(0);
  await expect(page.locator("#git-message")).toHaveCount(0);
  await mode(page, "staged").click();
  await expect(staged.locator('.git-file[data-path="src/style.css"]')).toHaveCount(1);
  await staged.locator(".git-file-name").first().click();
  await expect(page.locator(".git-review-scope")).toContainText("Alterações em stage");
  await expect(page.locator('#dlist .dfile[data-key$="src/style.css"] .drow').first()).toBeVisible();
  const stagedPatch = await page.locator('#dlist .dfile[data-key$="src/style.css"] .dbody').innerText();
  await mode(page, "changes").click();
  await changes.locator('.git-file[data-path="src/style.css"] .git-file-name').click();
  await expect(page.locator(".git-review-scope")).toContainText("Alterações locais");
  expect(await page.locator('#dlist .dfile[data-key$="src/style.css"] .dbody').innerText()).not.toBe(stagedPatch);
  // One click opens the entire group as a stacked diff; remaining files are reached by scrolling.
  await expect(page.locator("#dlist .dfile")).toHaveCount(2);
  await expect(page.locator('#dlist .dfile[data-key$="public/logo.png"]')).toBeVisible();
  await mode(page, "staged").click();
  await page.locator("#git-message").fill("   ");
  await expect(page.locator("#git-commit")).toBeDisabled();
  await page.locator("#git-message").fill("fix: preparar somente o snapshot revisado");
  await page.locator("#git-commit").click();
  await expect(staged.locator(".git-file")).toHaveCount(0);
  await expect(mode(page, "staged")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("button", { name: "Push ↑2", exact: true })).toBeEnabled();
  await expect(page.locator("#git-message")).toHaveValue("");
  await page.getByRole("button", { name: "Push ↑2", exact: true }).click();
  await expect(page.getByRole("button", { name: "Push ↑0", exact: true })).toBeDisabled();
  await mode(page, "changes").click();
  await expect(changes.locator('.git-file[data-path="src/style.css"]')).toHaveCount(1);
  await mode(page, "history").click();
  await expect(page.locator(".git-history-row").first()).toContainText("snapshot revisado");
  await expect(page.locator("#dlist .dfile")).toHaveCount(1);
  await expect(page.locator('#dlist .dfile[data-key$="src/style.css"] .dbody')).toHaveText(stagedPatch, { useInnerText: true });
  const previous = page.locator(".git-history-row").nth(1);
  await previous.focus();
  await page.keyboard.press("Enter");
  await expect(previous).toHaveAttribute("aria-current", "true");
  await expect(previous).toBeFocused();
});

test("Git: rascunho do commit sobrevive à atualização e erro não apaga o stage", async ({ page }) => {
  await open(page);
  await mode(page, "staged").click();
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

test("Git: branch abre lançador em worktree e publicação continua explícita", async ({ page }) => {
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

test("Git: conflito usa resultado revisado e permite concluir merge sem mudanças no índice", async ({ page }) => {
  await open(page, "Ícone do app");
  await mode(page, "staged").click();
  await expect(page.locator("#git-commit")).toBeDisabled();
  await mode(page, "changes").click();
  await group(page, "conflict").locator(".git-file-name").click();
  await page.getByRole("button", { name: "Aceitar versão atual", exact: true }).click();
  await page.getByRole("button", { name: "Salvar resolução", exact: true }).click();
  await expect(group(page, "conflict")).toHaveCount(0);
  await mode(page, "staged").click();
  await expect(group(page, "staged").locator(".git-file")).toHaveCount(0);
  await page.locator("#git-message").fill("merge: preservar versão atual");
  await expect(page.locator("#git-commit")).toHaveText("Concluir merge");
  await expect(page.locator("#git-commit")).toBeEnabled();
  await page.locator("#git-commit").click();
  await expect(page.locator("#git-commit")).toHaveText("Commit de 0 arquivos");
  await expect(page.locator("#git-commit")).toBeDisabled();
});

test("Git: comparação mostra commits sem misturar mudanças locais", async ({ page }) => {
  await open(page);
  await mode(page, "compare").click();
  await expect(page.locator(".git-review-scope")).toContainText("somente commits");
  await expect(page.locator(".git-review-list .dfile")).toHaveCount(1);
  await expect(page.locator('.git-review-list .dfile[data-key$="/src/style.css"]')).toHaveCount(0);
  await expect(group(page, "changes")).toHaveCount(0);
  await expect(page.locator("#git-message")).toHaveCount(0);
  await mode(page, "changes").click();
  await expect(group(page, "changes").locator('.git-file[data-path="src/style.css"]')).toHaveCount(1);
});

test("Git: erro temporário de status preserva os rascunhos e restaura o editor de conflito", async ({ page }) => {
  await open(page, "Ícone do app");
  await mode(page, "staged").click();
  await page.locator("#git-message").fill("merge: rascunho ainda não enviado");
  await mode(page, "changes").click();
  await group(page, "conflict").locator(".git-file-name").click();
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
  await page.evaluate(() => { (window as any).failGitStatus = false; });
  await refresh.click();
  await expect(page.locator("#dlist .git-error")).toHaveCount(0);
  await expect(page.locator(".git-conflict-result")).toHaveValue(".card {\n  gap: 10px;\n}\n");
  await expect(page.getByRole("button", { name: "Salvar resolução", exact: true })).toBeEnabled();
  await mode(page, "staged").click();
  await expect(page.locator("#git-message")).toHaveValue("merge: rascunho ainda não enviado");
  await expect(page.locator("#git-commit")).toBeDisabled();
});

test("Git: botão antigo de stage não prepara arquivos de outro repositório durante carregamento", async ({ page }) => {
  await open(page, "Contratação pelo portal");
  await group(page, "changes").locator('.git-file[data-path="src/style.css"] .git-file-name').click();
  const stageAll = group(page, "changes").getByRole("button", { name: "Adicionar tudo ao stage", exact: true });
  await expect(stageAll).toBeEnabled();
  await stageAll.evaluate(button => { (window as any).oldGitStage = button; });
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
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
  expect(await page.evaluate(() => (window as any).oldGitStage.isConnected)).toBe(false);
  await page.evaluate(() => { (window as any).oldGitStage.click(); });
  expect(await page.evaluate(() => (window as any).gitActions)).toEqual([]);
  await page.evaluate(() => {
    const w = window as any;
    w.delayGitDiff = false;
    w.delayedGitDiffs.splice(0).forEach((release: () => void) => release());
  });
  await expect(group(page, "changes").locator(".git-file")).toHaveCount(0);
  await expect(mode(page, "changes")).toHaveAttribute("aria-current", "true");
  await mode(page, "staged").click();
  await expect(page.locator("#dlist .dfile").first()).toBeVisible();
  await expect(group(page, "staged").locator(".git-file")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).gitActions)).toEqual([]);
});

test("Git: Enter compara a base escolhida e voltar a Mudanças mantém o editor de conflito", async ({ page }) => {
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
  await mode(page, "compare").click();
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

test("Git: grupos recolhidos sobrevivem à atualização e ações Git ficam no cabeçalho", async ({ page }) => {
  await open(page);
  await mode(page, "staged").click();
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
  const history = mode(page, "history");
  await history.click();
  await expect(history).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".git-history-row").first()).toBeVisible();
  await mode(page, "staged").click();
  await expect(page.locator("#dlist .dfile").first()).toBeVisible();
  await expect(page.locator("#git-message")).toHaveValue("fix: manter rascunho");
});

test("Git: revisão por teclado não altera o stage e um patch novo pede nova revisão", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.gitActions = [];
    w.changedPatch = false;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any, options: any) => {
      if (command === "workspace_git_action") w.gitActions.push(structuredClone(args));
      const result = await original(command, args, options);
      if (command === "workspace_git_diff" && args.scope === "changes" && w.changedPatch) {
        const file = result.files.find((file: any) => file.path === "src/style.css");
        file.patch += "\n@@ -400,0 +401,1 @@\n+/* alteração depois da revisão */";
        file.added++;
      }
      return result;
    };
  });
  await group(page, "changes").locator('.git-file[data-path="src/style.css"] .git-file-name').click();
  const file = page.locator('#dlist .dfile[data-key$="src/style.css"]');
  const reviewed = file.locator('input.dseen[type="checkbox"]');
  await expect(page.locator("#dprogress")).toContainText(/0.*2/);
  await reviewed.focus();
  await page.keyboard.press("Space");
  await expect(reviewed).toBeChecked();
  await expect(reviewed).toBeFocused();
  await expect(file.locator(".dbody")).toBeVisible();
  await expect(page.locator("#dprogress")).toContainText(/1.*2/);
  await expect(group(page, "changes").locator(".git-file")).toHaveCount(2);

  await page.locator("#dnext button").click();
  const binary = page.locator('#dlist .dfile[data-key$="public/logo.png"]');
  await expect(binary.locator(".dnote")).toBeVisible();
  await binary.locator(".dseen").check();
  await expect(page.locator("#dprogress")).toContainText(/2.*2/);
  await expect(page.locator("#dnext button")).toBeDisabled();
  await mode(page, "staged").click();
  await expect(group(page, "staged").locator(".git-file")).toHaveCount(1);
  await expect(file.locator(".dseen")).not.toBeChecked();
  await mode(page, "changes").click();
  await expect(reviewed).toBeChecked();

  const refresh = page.locator(".git-panel").getByRole("button", { name: "Atualizar", exact: true });
  await refresh.click();
  await expect(reviewed).toBeChecked();
  await page.evaluate(() => { (window as any).changedPatch = true; });
  await refresh.click();
  await expect(file.locator(".dbody")).toContainText("alteração depois da revisão");
  await expect(reviewed).not.toBeChecked();
  await expect(binary.locator(".dseen")).toBeChecked();
  await expect(page.locator("#dprogress")).toContainText(/1.*2/);
  await expect(page.locator("#dnext button")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).gitActions)).toEqual([]);
});

test("Git: diff unificado e lado a lado mantêm números, revisão e recolhimento por teclado", async ({ page }) => {
  await open(page);
  await group(page, "changes").locator('.git-file[data-path="src/style.css"] .git-file-name').click();
  const file = page.locator('#dlist .dfile[data-key$="src/style.css"]');
  const toggle = file.locator(".dtoggle");
  await expect(file.locator(".drow.ctx").first().locator(".dno")).toHaveCount(2);
  await file.locator(".dseen").check();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await expect(file.locator(".dbody")).toBeHidden();

  const split = page.locator('#dlayout [data-layout="split"]');
  await split.click();
  await expect(split).toHaveAttribute("aria-pressed", "true");
  await expect(file.locator(".dbody")).toBeHidden();
  await expect(file.locator(".dseen")).toBeChecked();
  await toggle.click();
  await expect(file.locator(".dbody.dlayout-split")).toBeVisible();
  const row = file.locator(".drow.dsplit").first();
  await expect(row.locator(":scope > *")).toHaveCount(6);
  await expect(row.locator(".dno")).toHaveCount(2);
  await expect(row.locator("code")).toHaveCount(2);
  await expect(file.locator(".dbody")).toContainText(".foot .chip { padding: 0; }");
  await page.locator('#dlayout [data-layout="unified"]').click();
  await expect(file.locator(".dbody")).toHaveClass(/\bdlayout-unified\b/);
  await expect(file.locator(".dseen")).toBeChecked();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("Git: filtro mantém foco, stage mantém o escopo e rascunhos ficam no repositório escolhido", async ({ page }) => {
  await open(page, "Contratação pelo portal");
  const filter = page.locator("#git-filter");
  const files = group(page, "changes").locator(".git-file");
  await filter.fill("logo");
  await expect(filter).toBeFocused();
  await expect(files).toHaveCount(1);
  await expect(files).toHaveAttribute("data-path", "public/logo.png");
  const stage = files.locator(".git-file-action");
  await expect(stage).not.toHaveText(/^[+−-]$/);
  await expect(stage).toHaveCSS("opacity", "1");
  await stage.click();
  await expect(mode(page, "changes")).toHaveAttribute("aria-current", "true");
  await expect(files).toHaveCount(0);
  await expect(page.locator("#git-message")).toHaveCount(0);
  await page.locator(".git-filter button").click();
  await expect(filter).toHaveValue("");
  await expect(filter).toBeFocused();
  await expect(files).toHaveCount(1);

  await mode(page, "staged").click();
  await expect(group(page, "staged").locator(".git-file")).toHaveCount(2);
  const unstage = group(page, "staged").locator('[data-path="public/logo.png"] .git-file-action');
  await expect(unstage).not.toHaveText(/^[+−-]$/);
  await unstage.click();
  await expect(mode(page, "staged")).toHaveAttribute("aria-current", "true");
  await expect(group(page, "staged").locator(".git-file")).toHaveCount(1);
  await page.locator("#git-message").fill("fix: prometeu draft");
  const picker = page.getByRole("button", { name: "Repositório", exact: true });
  await picker.click();
  await page.locator(".menu .mrow", { hasText: "njord" }).click();
  await expect(mode(page, "changes")).toHaveAttribute("aria-current", "true");
  await mode(page, "staged").click();
  await expect(page.locator("#git-message")).toHaveValue("");
  await page.locator("#git-message").fill("fix: njord draft");
  await picker.click();
  await page.locator(".menu .mrow", { hasText: "prometeu" }).click();
  await mode(page, "staged").click();
  await expect(page.locator("#git-message")).toHaveValue("fix: prometeu draft");
});
