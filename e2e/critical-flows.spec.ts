import { expect, test, type Page } from "@playwright/test";

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator("#issuesView")).toBeVisible();
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
}

async function openWorkspace(page: Page, title: string) {
  await page.locator("#railbody .navitem.sub .lbl").getByText(title, { exact: true }).click();
  await expect(page.locator("#wsView")).toBeVisible();
  await expect(page.locator("#crumb")).toContainText(title);
}

test("a troca rápida de aba ignora o snapshot atrasado da aba anterior", async ({ page }) => {
  await boot(page);
  await openWorkspace(page, "Ola");

  const first = page.locator('#tabbar .tab[data-tab="t1"]');
  const second = page.locator('#tabbar .tab[data-tab="t2"]');
  await expect(first).toHaveClass(/\bon\b/);

  await page.evaluate(() => {
    const mock = (window as unknown as {
      mock: { line: (tab: string, line: unknown) => void };
    }).mock;
    mock.line("t1", { type: "user", message: { role: "user", content: "E2E_MARKER_T1" } });
    mock.line("t2", { type: "user", message: { role: "user", content: "E2E_MARKER_T2" } });
  });
  await expect(page.locator("#chatwrap .bubble", { hasText: "E2E_MARKER_T1" })).toBeVisible();

  // Faz o snapshot de t2 chegar depois de t1. É a ordem que antes conseguia
  // repintar a conversa errada ao clicar rapidamente entre abas.
  await page.evaluate(() => {
    type Invoke = (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async function (command, args, options) {
      if (command === "chat_buffer" && args?.session === "t2") {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return original.call(this, command, args, options);
    };
  });

  await second.click();
  await first.click();

  await expect(first).toHaveClass(/\bon\b/);
  await expect(page.locator("#chatwrap .bubble", { hasText: "E2E_MARKER_T1" })).toBeVisible();
  await expect(page.locator("#chatwrap .bubble", { hasText: "E2E_MARKER_T2" })).toHaveCount(0);
  await page.waitForTimeout(450);
  await expect(first).toHaveClass(/\bon\b/);
  await expect(page.locator("#chatwrap .bubble", { hasText: "E2E_MARKER_T2" })).toHaveCount(0);
});

test("recolhe a saída técnica de uma ferramenta que falhou", async ({ page }) => {
  await boot(page);
  await openWorkspace(page, "Ola");

  await page.evaluate(() => {
    const mock = (window as unknown as {
      mock: { line: (tab: string, line: unknown) => void };
    }).mock;
    mock.line("t1", {
      type: "assistant",
      message: {
        id: "m-erro-e2e",
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-erro-e2e", name: "Bash", input: { command: "apply_patch" } }],
      },
    });
    mock.line("t1", {
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tu-erro-e2e",
          is_error: true,
          content: "Script failed\nWall time: 0.1 seconds\nOutput:\napply_patch verification failed: trecho não encontrado",
        }],
      },
    });
  });

  const tool = page.locator('#chatwrap .tool[data-tool="tu-erro-e2e"]');
  await expect(tool).toHaveClass(/\bbad\b/);
  await expect(tool.locator(".tout")).toBeHidden();

  await tool.locator(".thead").click();
  await expect(tool.locator(".tfail")).toContainText("Uma etapa falhou");
  await expect(tool.locator(".tout")).toBeHidden();

  await tool.locator(".ttechnical summary").click();
  await expect(tool.locator(".tout")).toContainText("apply_patch verification failed");
});

test("cria um workspace pelo launcher e acompanha o preparo até a conversa", async ({ page }) => {
  await boot(page);

  await page.locator("#railbody > button.navitem").first().click();
  await expect(page.locator("#veil .sheet")).toBeVisible();

  const title = "Workspace criado pelo E2E";
  await page.locator("#d-prompt").fill(title);
  await page.locator("#d-prompt").press("Enter");

  await expect(page.locator("#veil")).toBeHidden();
  await expect(page.locator("#wsView")).toBeVisible();
  await expect(page.locator("#crumb")).toContainText(title);
  await expect(page.locator("#offline")).toBeVisible();

  await expect(page.locator('#tabbar .tab[data-tab^="t-nova-"]')).toBeVisible({ timeout: 4_000 });
  await expect(page.locator("#offline")).toBeHidden();
  await expect(page.locator("#chatwrap .composer textarea")).toBeVisible();
});

test("envia uma pergunta, responde o card e devolve o controle ao chat", async ({ page }) => {
  await boot(page);
  await openWorkspace(page, "Ola");

  const composer = page.locator("#chatwrap .composer textarea");
  await composer.fill("Tenho uma pergunta para o fluxo E2E");
  await composer.press("Enter");

  const card = page.locator("#chatwrap .question");
  await expect(card).toBeVisible();
  await expect(card.locator(".qbody")).toContainText("Onde guardar os concluídos?");
  await card.locator(".qbody .opt").first().click();
  await expect(card.locator(".qbody")).toContainText("Rodar a migração agora?");
  await card.locator(".qbody .opt").first().click();

  const answer = card.locator("button.pri");
  await expect(answer).toBeEnabled();
  await answer.click();

  await expect(card).toHaveCount(0);
  await expect(page.locator("#chatwrap .feed")).toContainText("Combinado. Seguindo.");
  await expect(composer).toBeEnabled();
});

/// Um workspace de três repositórios com cem arquivos mudados: o diff inteiro
/// são dezenas de milhares de linhas, e montá-las de uma vez travava a tela por
/// segundos e deixava a rolagem arrastando. O que este teste guarda é a regra —
/// só o que está perto da tela é montado — porque ela é invisível enquanto
/// funciona, e o que ela evita só aparece no workspace grande de alguém.
test("a tela de Mudanças não monta o diff que ninguém está vendo", async ({ page }) => {
  await boot(page);

  await page.evaluate(() => {
    type Invoke = (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    const patch = (n: number) =>
      ["@@ -1,30 +1,30 @@ function algo() {"]
        .concat(Array.from({ length: n }, (_, i) => (i % 2 ? `+  const x${i} = novo(${i});` : `-  const y${i} = velho(${i});`)))
        .join("\n");
    const files = (repo: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `${repo}/src/pasta${i % 7}/arquivo${i}.ts`,
        added: 30,
        removed: 30,
        new_file: false,
        deleted: false,
        dirty: false,
        patch: patch(60),
      }));
    internals.invoke = async function (command, args, options) {
      if (command === "workspace_diff") {
        return [
          { name: "prometheus", base: "origin/main", ahead: 9, unpushed: 0, dirty: 0, files: files("um", 60) },
          { name: "njord", base: "origin/develop", ahead: 3, unpushed: 0, dirty: 0, files: files("dois", 50) },
        ];
      }
      return original.call(this, command, args, options);
    };
  });

  await openWorkspace(page, "Contratação pelo portal");
  // O diff é conferido de novo enquanto a tela dele está aberta: é por aí que
  // ele chega, sem depender de o agente mexer em nada.
  await page.locator("#tab-diff").click();
  await expect(page.locator("#difflist .diffrepo")).toHaveCount(2, { timeout: 10_000 });
  await expect(page.locator("#difflist .diffsum .state")).toContainText("tudo empurrado");

  await page.locator("#review").click();
  const dlist = page.locator("#dlist");
  await expect(dlist.locator(".dfile")).toHaveCount(110);
  // Os 110 cabeçalhos existem; as 6.600 linhas, não — só as de quem está perto
  // da tela. Sem preguiça isto passava de 40 mil nós.
  const linhas = await dlist.locator(".drow").count();
  expect(linhas).toBeGreaterThan(0);
  expect(linhas).toBeLessThan(2_000);

  // O lugar de cada arquivo já está guardado: a rolagem tem a altura do diff
  // inteiro antes de ele existir, e por isso não anda sozinha enquanto se lê.
  const altura = await dlist.evaluate((el) => el.scrollHeight);
  expect(altura).toBeGreaterThan(100_000);

  // Clicar num arquivo lá do fim da lista leva até ele — montado.
  await page.locator("#difflist .diffrow").last().click();
  await expect(dlist.locator(".dfile").last().locator(".drow").first()).toBeVisible();
});
