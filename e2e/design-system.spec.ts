import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Test an independent static consumer without desktop assets or modules.
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

test("design system entrega menu, submenu, senha e formulário com recuperação de erro", { tag: "@webkit" }, async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", request => { if (request.resourceType() === "script") scripts.push(request.url()); });
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
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(project).toHaveAttribute("aria-expanded", "false");
  await project.click();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("menuitemcheckbox", { name: "Prometeu Cloud" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("menuitemcheckbox", { name: "Prometeu Desktop" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(project).toHaveText("Prometeu Desktop");
  await dialog.getByLabel("Simular erro ao salvar").check();
  await dialog.getByRole("button", { name: "Salvar", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(name).toBeFocused();
  await name.press("Enter");
  await expect(dialog.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveText("Não foi possível salvar. Tente novamente.");
  await expect(name).toHaveValue("Equipe");
  await dialog.getByLabel("Simular erro ao salvar").uncheck();
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 640 });
  await trigger.click();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(scripts.every(url => url.startsWith(baseURL))).toBe(true);
});

test("design system opens confirmations without highlighting actions and keeps keyboard focus", { tag: "@webkit" }, async ({ page }) => {
  await page.goto(`${baseURL}/index.html`);
  const trigger = page.getByRole("button", { name: "Excluir conta", exact: true });
  for (const keyboard of [false, true]) {
    if (keyboard) await trigger.press("Enter"); else await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Excluir conta?", exact: true });
    await expect(dialog.locator(".sheettop b")).toBeFocused();
    await expect(dialog.locator("button:focus-visible")).toHaveCount(0);
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Excluir", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    const cancel = dialog.getByRole("button", { name: "Cancelar", exact: true });
    await expect(cancel).toBeFocused();
    await expect(cancel).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
});

test("design system valida seletor e preserva submitter com bloqueio de envio duplicado", { tag: "@webkit" }, async ({ page }) => {
  await page.goto(`${baseURL}/index.html`);
  const result = await page.evaluate(async () => {
    const { enhance, field, select, button } = await import("/dist/index.js");
    const form = document.createElement("form"); form.dataset.uiForm = "true";
    const choice = select("", [["", "Escolha"], ["cloud", "Cloud"]], { name: "project", required: true });
    const submit = button("Autorizar"); submit.type = "submit"; submit.name = "decision"; submit.value = "approve";
    form.append(field('<img src=x onerror="alert(1)">', choice.root), submit); document.body.append(form);
    const cleanup = enhance(form);
    const invalid = !form.reportValidity() && document.activeElement === choice.control;
    choice.value = "cloud";
    const valid = form.checkValidity();
    const first = new SubmitEvent("submit", { cancelable: true, bubbles: true, submitter: submit });
    const second = new SubmitEvent("submit", { cancelable: true, bubbles: true, submitter: submit });
    form.dispatchEvent(first); form.dispatchEvent(second);
    const data = new FormData(form, submit);
    const result = { invalid, valid, injected: form.querySelectorAll("img").length, blocked: second.defaultPrevented, busy: form.getAttribute("aria-busy"),
      decision: data.get("decision"), project: data.get("project") };
    window.dispatchEvent(new PageTransitionEvent("pageshow"));
    const reset = !form.hasAttribute("aria-busy") && !submit.hasAttribute("aria-disabled");
    cleanup(); form.remove(); return { ...result, reset };
  });
  expect(result).toEqual({ invalid: true, valid: true, injected: 0, blocked: true, busy: "true", decision: "approve", project: "cloud", reset: true });
});
