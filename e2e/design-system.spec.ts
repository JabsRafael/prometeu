import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Um consumidor estático separado: nenhum asset ou módulo do desktop disponível.
let server: Server;
let baseURL: string;
test.beforeAll(async () => {
  const root = resolve("packages/design-system");
  server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url!, "http://localhost").pathname);
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep)) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html";
      response.writeHead(200, { "Content-Type": type }); response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

test("design system da empresa funciona sem CSS ou JavaScript do desktop", async ({ page, browserName }) => {
  const scripts: string[] = [];
  page.on("request", request => { if (request.resourceType() === "script") scripts.push(request.url()); });
  await page.goto(`${baseURL}/index.html`);
  expect(scripts.every(url => url.startsWith(baseURL))).toBe(true);
  const save = page.getByRole("button", { name: "Salvar", exact: true });
  await expect(save).toHaveCSS("background-color", "rgb(234, 232, 230)");
  await expect(save).toHaveCSS("min-height", "44px");
  // No macOS, Option+Tab inclui botões e links na navegação nativa do WebKit.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(save).toBeFocused();
  await expect(save).toHaveCSS("outline-style", "solid");
  await expect(page.getByRole("button", { name: "Indisponível" })).toBeDisabled();
  const email = page.getByLabel("Email", { exact: true });
  await expect(email).toHaveAccessibleDescription("Informe um email válido.");
  await expect(email).toHaveCSS("border-top-color", "rgb(224, 108, 108)");
  const checkbox = page.getByRole("checkbox");
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  await page.getByText("Informações adicionais", { exact: true }).press("Enter");
  await expect(page.locator("details")).toHaveAttribute("open", "");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("design system entrega menu, submenu, senha e formulário com recuperação de erro", async ({ page }) => {
  await page.goto(`${baseURL}/index.html`);
  const password = page.getByLabel("Senha", { exact: true });
  await password.fill("exemplo-seguro");
  await page.getByRole("button", { name: "Mostrar senha", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Ocultar senha", exact: true }).click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveValue("exemplo-seguro");

  const menu = page.getByRole("button", { name: "Ações do projeto" });
  await menu.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Renomear" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Exportar" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menuitem", { name: "Copiar" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("menuitem", { name: "Exportar" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute("aria-expanded", "false");

  const trigger = page.getByRole("button", { name: "Editar perfil", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByLabel("Nome do perfil");
  await expect(name).toBeFocused();
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(name).toBeFocused();
  await name.fill("Equipe");
  const project = dialog.getByLabel("Projeto", { exact: true });
  await project.click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(project).toHaveText("Prometeu Desktop");
  await dialog.getByLabel("Simular erro ao salvar").check();
  await name.press("Enter");
  await expect(dialog.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveText("Não foi possível salvar. Tente novamente.");
  await expect(name).toHaveValue("Equipe");
  await dialog.getByLabel("Simular erro ao salvar").uncheck();
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("design system pode montar, desmontar e remontar melhorias sem duplicar controles", async ({ page }) => {
  await page.goto(`${baseURL}/index.html`);
  const result = await page.evaluate(async () => {
    const { enhance, field, input } = await import("/dist/index.js");
    const root = document.createElement("form"); root.setAttribute("data-ui-form", "true");
    const password = document.createElement("div"); password.className = "ui-password";
    password.dataset.uiPassword = "true"; password.dataset.uiShow = "Mostrar"; password.dataset.uiHide = "Ocultar";
    const control = input(); control.type = "password"; control.name = "password";
    password.append(control); root.append(field('<img src=x onerror="alert(1)">', password));
    document.body.append(root);
    const dispose = enhance(root); const duplicate = enhance(root);
    const first = root.querySelectorAll("button").length;
    duplicate(); dispose();
    const after = root.querySelectorAll("button").length;
    const again = enhance(root);
    const remounted = root.querySelectorAll("button").length;
    const injected = root.querySelectorAll("img").length;
    again(); root.remove();
    return { first, after, remounted, injected };
  });
  expect(result).toEqual({ first: 1, after: 0, remounted: 1, injected: 0 });
});

test("design system valida seletor e preserva submitter com bloqueio de envio duplicado", async ({ page }) => {
  await page.goto(`${baseURL}/index.html`);
  const result = await page.evaluate(async () => {
    const { enhance, field, select, button } = await import("/dist/index.js");
    const form = document.createElement("form"); form.dataset.uiForm = "true";
    const choice = select("", [["", "Escolha"], ["cloud", "Cloud"]], { name: "project", required: true });
    const submit = button("Autorizar"); submit.type = "submit"; submit.name = "decision"; submit.value = "approve";
    form.append(field("Projeto obrigatório", choice.root), submit); document.body.append(form);
    const cleanup = enhance(form);
    const invalid = !form.reportValidity() && document.activeElement === choice.control;
    choice.value = "cloud";
    const valid = form.checkValidity();
    const first = new SubmitEvent("submit", { cancelable: true, bubbles: true, submitter: submit });
    const second = new SubmitEvent("submit", { cancelable: true, bubbles: true, submitter: submit });
    form.dispatchEvent(first); form.dispatchEvent(second);
    const data = new FormData(form, submit);
    const result = { invalid, valid, blocked: second.defaultPrevented, busy: form.getAttribute("aria-busy"),
      decision: data.get("decision"), project: data.get("project") };
    window.dispatchEvent(new PageTransitionEvent("pageshow"));
    const reset = !form.hasAttribute("aria-busy") && !submit.hasAttribute("aria-disabled");
    cleanup(); form.remove(); return { ...result, reset };
  });
  expect(result).toEqual({ invalid: true, valid: true, blocked: true, busy: "true", decision: "approve", project: "cloud", reset: true });
});
