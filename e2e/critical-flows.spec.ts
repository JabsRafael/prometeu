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

test("o topo local fica estável e não trata workspace comum como compartilhado", async ({ page }) => {
  await boot(page);
  await openWorkspace(page, "Ola");

  // Este workspace nunca foi compartilhado: colaboração não vira um estado
  // permanente na barra. A ação só entra no menu quando há um time configurado.
  await expect(page.locator("#msg")).toBeHidden();
  await expect(page.locator("#share")).toBeHidden();
  await expect(page.locator("#wsmore")).toBeVisible();
  await page.locator("#wsmore").click();
  await expect(page.locator(".menu .mrow", { hasText: "Definir etapa" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Um evento do quadro redesenha o app inteiro. O nó da identidade deve
  // sobreviver em vez de sumir e nascer de novo a cada ferramenta do agente.
  await page.locator("#crumb .nm").evaluate((el) => (el.dataset.stable = "yes"));
  await page.evaluate(async () => {
    type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke;
    await invoke("set_stage", { id: "sessao-0929", stage: "Fazendo" });
  });
  await expect(page.locator("#crumb .nm")).toHaveAttribute("data-stable", "yes");
  await expect(page.locator("#msg")).toBeHidden();
});

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

test("a lista de issues cabe no lançador e deixa os títulos legíveis", async ({ page }) => {
  await boot(page);

  // Uma lista longa revela os dois limites do popup: a lateral da folha e o
  // início do rodapé. O mock normal tem só cinco linhas e não força rolagem.
  await page.evaluate(() => {
    type Invoke = (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async function (command, args, options) {
      const result = await original.call(this, command, args, options);
      if (command !== "linear_issues") return result;
      const found = result as { issues: Record<string, unknown>[]; fetched_at: number };
      return {
        ...found,
        issues: Array.from({ length: 4 }, (_, batch) =>
          found.issues.map((issue) => ({ ...issue, id: `${issue.id}-${batch}` })),
        ).flat(),
      };
    };
    return internals.invoke("linear_connect");
  });
  await expect(page.locator("#railbody .navitem", { hasText: "Issues" }).locator(".n")).toHaveText("20");

  await page.locator("#railbody > button.navitem").first().click();
  await page.locator("#d-issuebtn").click();
  await expect(page.locator("#d-ipicker .prow")).toHaveCount(20);

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const picker = rect("#d-ipicker");
    const sheet = rect("#veil .sheet");
    const foot = rect("#veil .sheetbar");
    const id = rect("#d-ipicker .prow .iid");
    const title = rect("#d-ipicker .prow > span:last-child");
    return {
      picker: { left: picker.left, right: picker.right, bottom: picker.bottom },
      sheet: { left: sheet.left, right: sheet.right },
      foot: { top: foot.top },
      title: { width: title.width, gap: title.left - id.right },
    };
  });
  expect(geometry.picker.left).toBeGreaterThanOrEqual(geometry.sheet.left);
  expect(geometry.picker.right).toBeLessThanOrEqual(geometry.sheet.right);
  expect(geometry.picker.bottom).toBeLessThanOrEqual(geometry.foot.top);
  expect(geometry.title.width).toBeGreaterThan(200);
  expect(geometry.title.gap).toBeGreaterThanOrEqual(8);
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

/// O "@" da caixa aponta um arquivo do workspace para o agente. O que importa
/// aqui é a caixa acabar com um caminho de verdade escrito nela: é isso que o
/// agente lê, e é o que faltava — a lista nunca abria.
test("o @ na caixa completa um caminho do workspace", async ({ page }) => {
  await boot(page);
  await openWorkspace(page, "Ola");

  const composer = page.locator("#chatwrap .composer textarea");
  await composer.fill("veja @app/adapters/tra");

  const first = page.locator(".menu .mrow").first();
  await expect(first).toContainText("app/adapters/transcriber.rb");

  // Tab escreve o caminho inteiro no lugar do que foi digitado, e não manda a
  // fala.
  await composer.press("Tab");
  await expect(composer).toHaveValue("veja @app/adapters/transcriber.rb ");
  await expect(page.locator("#chatwrap .feed")).not.toContainText("veja @app");
});

/// Entre dois caminhos que combinam igual, o que o agente acabou de mexer vem
/// na frente: no meio de um trabalho, o "@" quase sempre é sobre o arquivo que
/// acabou de aparecer na conversa.
test("o arquivo que o agente acabou de ler sobe na lista do @", async ({ page }) => {
  await boot(page);
  await openWorkspace(page, "Ola");

  const composer = page.locator("#chatwrap .composer textarea");
  await composer.fill("veja @waha");
  await expect(page.locator(".menu .mrow").first()).toContainText("app/adapters/waha.rb");

  // O agente lê outro arquivo da mesma pasta. A lista do "@" passa a oferecê-lo
  // primeiro, mesmo com "adapters" combinando igual nos dois.
  await composer.fill("");
  await page.evaluate(() => {
    const mock = (window as unknown as { mock: { line: (tab: string, line: unknown) => void } }).mock;
    mock.line("t1", {
      type: "assistant",
      message: {
        id: "m-recency",
        role: "assistant",
        content: [{ type: "tool_use", id: "tu-recency", name: "Read", input: { file_path: "app/adapters/transcriber.rb" } }],
      },
    });
  });
  await composer.fill("veja @adapters");
  await expect(page.locator(".menu .mrow").first()).toContainText("app/adapters/transcriber.rb");
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

/// O arquivo abre pronto para escrever — não há botão de editar. O que este
/// teste guarda é o que quebra sozinho: o quadro bate a cada ferramenta que o
/// agente usa e redesenha o arquivo aberto; se o redesenho não respeitar o que
/// está sendo escrito, o texto some no meio da frase.
test("escrever no arquivo aberto sobrevive ao redesenho do quadro e salva", async ({ page }) => {
  await boot(page);
  await openWorkspace(page, "Ola");

  await page.locator("#tab-files").click();
  await page.locator("#tree .treerow", { hasText: "CLAUDE.md" }).click();
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#vpre")).toContainText("Controle financeiro pessoal");

  // Sem nada escrito não há o que salvar nem o que desfazer.
  await expect(page.locator("#vtext")).toBeVisible();
  await expect(page.locator("#vsave")).toBeHidden();
  await expect(page.locator("#vcancel")).toBeHidden();

  const texto = "# Njord\n\nCorrigido à mão pelo E2E.\n";
  await page.locator("#vtext").fill(texto);
  // As cores acompanham: o que se lê é o <pre>, e ele já mostra o texto novo.
  await expect(page.locator("#vpre")).toContainText("Corrigido à mão pelo E2E.");
  await expect(page.locator("#vsave")).toBeVisible();
  await expect(page.locator("#vcrumb")).toHaveClass(/\bdirty\b/);

  const board = () =>
    page.evaluate(async () => {
      type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke;
      await invoke("set_stage", { id: "sessao-0929", stage: "Fazendo" });
    });

  await board();
  await expect(page.locator("#vtext")).toHaveValue(texto);

  // Nem clicar em outro arquivo e voltar: o rascunho espera, e volta de onde
  // parou. Um clique errado não custa o que já foi escrito.
  await page.locator("#tree .treerow", { hasText: ".gitignore" }).click();
  await expect(page.locator("#vpre")).toContainText("Ignore bundler config");
  await expect(page.locator("#vsave")).toBeHidden();
  await page.locator("#tree .treerow", { hasText: "CLAUDE.md" }).click();
  await expect(page.locator("#vtext")).toHaveValue(texto);
  await expect(page.locator("#vsave")).toBeVisible();

  await page.locator("#vsave").click();
  await expect(page.locator("#vsave")).toBeHidden();
  await expect(page.locator("#vcrumb")).not.toHaveClass(/\bdirty\b/);

  // Salvou de verdade: o redesenho seguinte lê o disco e acha o que foi escrito.
  await board();
  await expect(page.locator("#vpre")).toContainText("Corrigido à mão pelo E2E.");
  await expect(page.locator("#vpre")).not.toContainText("Controle financeiro pessoal");

  // E o arquivo que só passou pela tela no meio da edição continua intacto:
  // salvar escreve no arquivo que está sendo editado, não no último aberto.
  await page.locator("#tree .treerow", { hasText: ".gitignore" }).click();
  await expect(page.locator("#vpre")).toContainText("Ignore bundler config");
  await expect(page.locator("#vpre")).not.toContainText("Corrigido à mão pelo E2E.");
});

/// Ler o diff e ir mexer no arquivo são o mesmo movimento: o duplo clique
/// atravessa da lista de Mudanças, e do diff empilhado no centro, para o
/// arquivo inteiro aberto no viewer.
test("duplo clique numa mudança abre o arquivo no viewer", async ({ page }) => {
  await boot(page);
  await openWorkspace(page, "Ola");

  await page.locator("#tab-diff").click();
  const row = page.locator("#difflist .diffrow", { hasText: "style.css" }).first();
  await expect(row).toBeVisible();

  // Um clique é ir até o arquivo no diff do centro, e não abrir.
  await row.click();
  await expect(page.locator("#dlist .dhead", { hasText: "style.css" }).first()).toBeVisible();
  await expect(page.locator("#viewer")).toBeHidden();

  await row.dblclick();
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#vcrumb")).toContainText("style.css");
  await expect(page.locator("#vpre")).toContainText("padding: 12px");

  // E o mesmo gesto no cabeçalho do arquivo dentro do diff empilhado.
  await page.locator("#tab-diff").click();
  await page.locator("#dlist .dhead", { hasText: "style.css" }).first().dblclick();
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#vcrumb")).toContainText("style.css");
});

/// O filtro do que está fora de commit escondia repositório inteiro: num
/// workspace com três repos, se o que ainda não foi commitado estava só num
/// deles, os outros dois sumiam da lista sem deixar rastro — e a tela parecia
/// estar deixando de mostrar mudança. Agora o repositório continua ali,
/// dizendo que o dele está todo commitado.
test("o filtro de fora de commit não faz repositório sumir da lista", async ({ page }) => {
  await boot(page);

  await page.evaluate(() => {
    type Invoke = (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    const files = (repo: string, n: number, dirty: boolean) =>
      Array.from({ length: n }, (_, i) => ({
        path: `${repo}/arquivo${i}.ts`,
        added: 3,
        removed: 1,
        new_file: false,
        deleted: false,
        dirty,
        patch: "@@ -1,1 +1,1 @@\n-velho\n+novo",
      }));
    internals.invoke = async function (command, args, options) {
      if (command === "workspace_diff") {
        return [
          // Tudo commitado: é este que sumia quando o filtro ligava.
          { name: "prometheus", base: "origin/main", ahead: 9, unpushed: 0, dirty: 0, files: files("um", 8, false) },
          { name: "njord", base: "origin/develop", ahead: 4, unpushed: 0, dirty: 2, files: files("dois", 2, true) },
        ];
      }
      return original.call(this, command, args, options);
    };
  });

  await openWorkspace(page, "Contratação pelo portal");
  await page.locator("#tab-diff").click();

  const repos = page.locator("#difflist .diffrepo");
  await expect(repos).toHaveCount(2, { timeout: 10_000 });
  await expect(page.locator("#difflist .diffrow")).toHaveCount(10);

  // Liga o filtro: só os dois arquivos do njord ficam, mas os dois
  // repositórios continuam na lista.
  await page.locator("#difflist .diffsum .dirtyf").click();
  await expect(page.locator("#difflist .diffrow")).toHaveCount(2);
  await expect(repos).toHaveCount(2);
  await expect(repos.first()).toHaveClass(/\bquiet\b/);
  await expect(repos.first()).toContainText("prometheus");
  await expect(repos.first()).toContainText("tudo commitado");
});
