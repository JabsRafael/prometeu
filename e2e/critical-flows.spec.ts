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
