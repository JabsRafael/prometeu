import { expect, test, type Locator, type Page } from "@playwright/test";

const path = "/Users/eu/Desktop/Captura de Tela.png";
type Point = { x: number; y: number };

async function point(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, type: "enter" | "over" | "drop" | "leave", position?: Point, paths?: string[]) {
  await page.evaluate(({ type, position, paths }) => {
    (window as unknown as {
      mock: { drag: (type: string, payload: { position?: Point; paths?: string[] }) => void };
    }).mock.drag(type, { position, paths });
  }, { type, position, paths });
}

async function promise(page: Page, type: "pending" | "received", id: string, position?: Point, paths: string[] = [], error?: string) {
  await page.evaluate(({ type, id, position, paths, error }) => {
    (window as unknown as { mock: { drag: (type: string, payload: unknown) => void } })
      .mock.drag(type, { id, position, paths, error });
  }, { type, id, position, paths, error });
}

async function paste(page: Page, selector: string, files: boolean) {
  await page.evaluate(({ selector, files }) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    // WebKit rejects a constructed ClipboardEvent with a DataTransfer, so describe the clipboard here.
    Object.defineProperty(event, "clipboardData", {
      value: { files: files ? [new File([new Uint8Array([1])], "clipboard.png", { type: "image/png" })] : [] },
    });
    document.querySelector<HTMLTextAreaElement>(selector)!.dispatchEvent(event);
  }, { selector, files });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('#tiles .tile[data-tab="t1"] .composer textarea')).toBeVisible();
});

test("arraste de arquivo usa o quadro da posição final, mesmo sem o último over", async ({ page }) => {
  const first = page.locator('#tiles .tile[data-tab="t1"]');
  const second = page.locator('#tiles .tile[data-tab="t3"]');
  await drag(page, "enter", await point(first), [path]);
  await expect(first).toHaveClass(/dropping/);
  await drag(page, "drop", await point(second), [path]);
  await expect(first.locator(".injchip")).toHaveCount(0);
  await expect(second.locator(".cfiles .injchip")).toContainText("Captura de Tela.png");
  await expect(page.locator(".dropping")).toHaveCount(0);
});

test("arraste de arquivo fora da conversa não usa hover antigo nem a moldura anterior", async ({ page }) => {
  await page.locator('#tiles .tile[data-tab="t1"] .topen').click();
  const chat = page.locator("#chatwrap");
  const composer = chat.locator("textarea");
  await composer.hover();
  const inside = await point(composer);
  const outside = await point(page.locator("#crumb"));

  await drag(page, "enter", inside, [path]);
  await expect(chat).toHaveClass(/dropping/);
  await drag(page, "drop", outside, [path]);
  await expect(chat.locator(".cfiles .injchip")).toHaveCount(0);

  await drag(page, "enter", outside, [path]);
  await expect(page.locator(".dropping")).toHaveCount(0);
  await drag(page, "drop", outside, [path]);
  await expect(chat.locator(".cfiles .injchip")).toHaveCount(0);
});

test("arraste de arquivo limpa cancelamento e não reaproveita conversa escondida", async ({ page }) => {
  const tile = page.locator('#tiles .tile[data-tab="t1"]');
  const at = await point(tile);
  const outside = { x: -100, y: -100 };
  await drag(page, "enter", at, [path]);
  await drag(page, "leave");
  await expect(page.locator(".dropping")).toHaveCount(0);
  await drag(page, "drop", outside, [path]);
  await expect(tile.locator(".cfiles .injchip")).toHaveCount(0);

  await drag(page, "enter", at, [path]);
  await tile.locator(".topen").click();
  await drag(page, "drop", outside, [path]);
  await expect(page.locator(".cfiles .injchip")).toHaveCount(0);
});

test("arraste de arquivo sem caminhos avisa e permite tentar novamente sem perder rascunho", async ({ page }) => {
  const tile = page.locator('#tiles .tile[data-tab="t1"]');
  const composer = tile.locator("textarea");
  await composer.fill("Veja estes arquivos");
  const at = await point(composer);
  await drag(page, "enter", at, []);
  await drag(page, "drop", at, []);
  await expect(page.locator("#msg")).toContainText("Não foi possível obter o arquivo arrastado");
  await expect(page.locator(".dropping")).toHaveCount(0);

  await drag(page, "enter", at, [path]);
  await drag(page, "drop", at, [path, path, "/tmp/notas.txt"]);
  await expect(tile.locator(".cfiles .injchip")).toHaveCount(2);
  await expect(composer).toHaveValue("Veja estes arquivos");
});

test("arraste de arquivo respeita diálogo modal aberto durante o gesto", async ({ page }) => {
  const tile = page.locator('#tiles .tile[data-tab="t1"]');
  const at = await point(tile);
  await drag(page, "enter", at, [path]);
  // Use the same native mechanism as Design System forms.
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.showModal();
  });
  await drag(page, "drop", at, [path]);
  await expect(page.locator(".dropping")).toHaveCount(0);
  await expect(tile.locator(".cfiles .injchip")).toHaveCount(0);
});

test("arraste de arquivo preserva caminho completado no rascunho sem navegador", async ({ page }) => {
  await page.locator('#tiles .tile[data-tab="t1"] .topen').click();
  const composer = page.locator("#chatwrap .composer textarea");
  await composer.fill("Veja @CLA");
  await expect(page.locator(".menu .mrow").first()).toContainText("CLAUDE.md");
  await composer.press("Tab");
  await expect(composer).toHaveValue("Veja @CLAUDE.md ");
  await drag(page, "drop", await point(composer), [path]);
  await expect(page.locator("#chatwrap .cfiles .injchip")).toContainText("Captura de Tela.png");
  await expect(composer).toHaveValue("Veja @CLAUDE.md ");
  await expect(page.locator("#webview")).toBeHidden();
});

test("arraste de arquivo no lançador preserva texto e não duplica anexos", async ({ page }) => {
  await page.locator("#railbody").getByRole("button", { name: "Criar", exact: true }).click();
  const composer = page.locator("#d-prompt");
  await composer.fill("Veja esta captura");
  const at = await point(composer);
  await drag(page, "drop", at, []);
  await expect(page.locator("#msg")).toContainText("Não foi possível obter o arquivo arrastado");
  await drag(page, "enter", at, [path]);
  await drag(page, "drop", at, [path, path]);
  await expect(page.locator("#d-inj .injchip")).toHaveCount(1);
  await expect(composer).toHaveValue("Veja esta captura");
  await expect(page.locator(".cfiles .injchip")).toHaveCount(0);
  await promise(page, "pending", "launcher", at);
  await expect(page.locator("#d-go")).toBeDisabled();
  await composer.press("Enter");
  await expect(page.locator("#veil")).toBeVisible();
  await promise(page, "received", "launcher", undefined, ["/tmp/outra.png"]);
  await expect(page.locator("#d-inj .injchip")).toHaveCount(2);
  await expect(page.locator("#d-go")).toBeEnabled();
});

test("arraste de arquivo no terminal escreve caminho escapado no pty correto", async ({ page }) => {
  await page.locator('#tiles .tile[data-tab="t1"] .topen').click();
  await page.locator(".tabadd .caret").click();
  await page.locator(".ui-search-picker-choice", { hasText: "Terminal novo" }).click();
  await expect(page.locator("#termview .xterm")).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      droppedWrites: Record<string, unknown>[];
    };
    w.droppedWrites = [];
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "pty_write" && args) w.droppedWrites.push(args);
      return invoke(command, args);
    };
  });
  const at = await point(page.locator("#termview"));
  await drag(page, "enter", at, [path]);
  await drag(page, "drop", at, [path, "/tmp/a;echo.txt"]);
  const writes = await page.evaluate(() => (window as unknown as {
    droppedWrites: { session: string; data: string }[];
  }).droppedWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0].session).toBe("sessao-0929:terminal");
  expect(writes[0].data).toBe("/Users/eu/Desktop/Captura\\ de\\ Tela.png /tmp/a\\;echo.txt ");
  await expect(page.locator(".cfiles .injchip")).toHaveCount(0);
});

test("arraste de arquivo da miniatura recebe captura na aba original após navegar", async ({ page }) => {
  await page.locator('#tiles .tile[data-tab="t1"] .topen').click();
  const composer = page.locator("#chatwrap .composer textarea");
  await composer.fill("Analise esta captura");
  const at = await point(composer);
  // The screenshot thumbnail advertises a file promise before a path exists.
  await drag(page, "enter", at, []);
  await expect(page.locator("#chatwrap")).toHaveClass(/dropping/);
  await promise(page, "pending", "capture-1", at);
  await expect(page.locator("#msg")).toContainText("Recebendo arquivo");
  await expect(page.locator(".dropping")).toHaveCount(0);
  await expect(page.locator("#chatwrap .send")).toBeDisabled();
  await composer.press("Enter");
  await expect(composer).toHaveValue("Analise esta captura");

  // A board update can arrive between mouse press and release.
  const second = page.locator('#tabbar .tab[data-tab="t2"]');
  await second.hover();
  await page.mouse.down();
  await page.evaluate(() => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    return internals.invoke("rename_tab", { workspace: "sessao-0929", tab: "t2", title: "Outra conversa" });
  });
  await page.mouse.up();
  await expect(second).toHaveClass(/\bon\b/);
  await expect(second).toContainText("Outra conversa");
  await promise(page, "received", "capture-1", undefined, [path]);
  await expect(page.locator("#chatwrap .cfiles .injchip")).toHaveCount(0);
  await page.locator('#tabbar .tab[data-tab="t1"]').click();
  await expect(page.locator("#chatwrap .cfiles .injchip")).toContainText("Captura de Tela.png");
  await expect(composer).toHaveValue("Analise esta captura");
  await expect(page.locator("#chatwrap .send")).toBeEnabled();
});

test("arraste de arquivo prometido na mesa atualiza a conversa já aberta no workspace", async ({ page }) => {
  const tile = page.locator('#tiles .tile[data-tab="t1"]');
  await promise(page, "pending", "desk", await point(tile));
  await tile.locator(".topen").click();
  await expect(page.locator("#chatwrap .send")).toBeDisabled();
  await promise(page, "received", "desk", undefined, [path]);
  await expect(page.locator("#chatwrap .cfiles .injchip")).toContainText("Captura de Tela.png");
  await expect(page.locator("#chatwrap .send")).toBeEnabled();
});

test("arraste de arquivo prometido mantém destinos independentes e permite repetir após falha", async ({ page }) => {
  const first = page.locator('#tiles .tile[data-tab="t1"]');
  const second = page.locator('#tiles .tile[data-tab="t3"]');
  await promise(page, "pending", "first", await point(first));
  await promise(page, "pending", "second", await point(second));
  await promise(page, "received", "second", undefined, ["/tmp/segunda.png"]);
  await promise(page, "received", "first", undefined, [], "timeout");
  await expect(page.locator("#msg")).toContainText("Não foi possível receber o arquivo");
  await expect(first.locator(".cfiles .injchip")).toHaveCount(0);
  await expect(second.locator(".cfiles .injchip")).toContainText("segunda.png");
  await promise(page, "pending", "retry", await point(first));
  await promise(page, "received", "retry", undefined, [path]);
  await promise(page, "received", "retry", undefined, ["/tmp/duplicada.png"]);
  await expect(first.locator(".cfiles .injchip")).toHaveCount(1);
  await expect(first.locator(".cfiles .injchip")).toContainText("Captura de Tela.png");
});

test("colar imagem anexa na conversa e no lançador, sem tocar em texto colado", async ({ page }) => {
  await page.locator('#tiles .tile[data-tab="t1"] .topen').click();
  const composer = page.locator("#chatwrap .composer textarea");
  await composer.fill("Veja isto");
  await paste(page, "#chatwrap .composer textarea", false);
  await expect(page.locator("#chatwrap .cfiles .injchip")).toHaveCount(0);
  await paste(page, "#chatwrap .composer textarea", true);
  await expect(page.locator("#chatwrap .cfiles .injchip")).toContainText("pasted.png");
  await expect(composer).toHaveValue("Veja isto");

  await page.locator("#railbody").getByRole("button", { name: "Criar", exact: true }).click();
  await page.locator("#d-prompt").fill("Analise esta captura");
  await paste(page, "#d-prompt", true);
  await expect(page.locator("#d-inj .injchip")).toContainText("pasted.png");
  await expect(page.locator("#d-prompt")).toHaveValue("Analise esta captura");
});
