import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mock:cloud", JSON.stringify({ user: { id: "1", name: "Pessoa", email: "me@example.test" }, origin: "https://app.prometeu.co", offline: false }));
    localStorage.setItem("mock:catalog", JSON.stringify({ connected: true, revision: 0, plugins: [], mcp: [], skills: [], shared: {}, projects: [
      { id: "personal-app", source: "team/personal", note: "App pessoal", revision: 0, organization: null, organization_name: null, local_path: null },
    ] }));
    localStorage.setItem("mock:organizationCatalogs", JSON.stringify([
      { id: "acme", name: "Equipe Acme", revision: 0, links: {}, plugins: [], mcp: [], skills: [], projects: [{ id: "team-app", source: "team/shared", note: "App da equipe" }] },
    ]));
    localStorage.setItem("mock:directory", "/tmp/projects");
  });
  await page.goto("/");
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  await page.locator("#settings").click();
  await page.locator(".setnavitem", { hasText: "Projetos" }).click();
  await page.getByRole("button", { name: "Adicionar neste Mac" }).click();
});

test("Git projects open without a selected button and keep compact actions readable", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Projetos", exact: true });
  const local = dialog.getByRole("button", { name: "Adicionar pasta local", exact: true });
  await expect(dialog.locator(".sheettop b")).toBeFocused();
  await expect(dialog.locator("button:focus-visible")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(local).toBeFocused();
  await expect(local).toHaveCSS("outline-style", "solid");
  expect((await local.boundingBox())!.width).toBeLessThan((await dialog.boundingBox())!.width / 2);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 480 });
    expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const save = dialog.getByRole("button", { name: "Adicionar neste Mac", exact: true });
    await expect(save).toBeVisible();
    const bounds = (await save.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(480);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Adicionar neste Mac", exact: true })).toBeFocused();
});

test("Git projects clone in a batch, retain success and retry only failures", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Projetos", exact: true });
  const personal = dialog.getByRole("checkbox", { name: /personal-app/ });
  const shared = dialog.getByRole("checkbox", { name: /team-app/ });
  await expect(shared).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Adicionar neste Mac" })).toBeDisabled();
  await personal.check(); await shared.check();
  await dialog.getByRole("button", { name: "Escolher pasta de destino" }).click();
  await page.evaluate(() => localStorage.setItem("mock:projectFail", "team-app"));
  await dialog.getByRole("button", { name: "Adicionar neste Mac" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Alguns projetos falharam");
  const failure = dialog.locator(".setrow", { hasText: "team-app" }).getByRole("status");
  await expect(failure).toContainText("Sem acesso ao repositório");
  await expect(failure).toContainText("Permission denied (publickey).");
  await expect(failure).toHaveClass(/bad/);
  await expect(personal).not.toBeChecked();
  await expect(shared).toBeChecked();
  await expect(dialog).toContainText("/tmp/projects/personal-app");
  await page.evaluate(() => localStorage.removeItem("mock:projectFail"));
  await dialog.getByRole("button", { name: "Adicionar neste Mac" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#railbody")).toContainText("personal-app");
  await expect(page.locator("#railbody")).toContainText("team-app");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mock:catalog")!).revision)).toBe(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mock:catalog")!).projects)).toHaveLength(1);
});

test("Git projects reject a stale selection and link existing clones explicitly", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Projetos", exact: true });
  await dialog.getByRole("checkbox", { name: /personal-app/ }).check();
  await dialog.getByRole("button", { name: "Escolher pasta de destino" }).click();
  await page.evaluate(() => {
    const catalog = JSON.parse(localStorage.getItem("mock:catalog")!);
    catalog.revision = 1;
    localStorage.setItem("mock:catalog", JSON.stringify(catalog));
  });
  await dialog.getByRole("button", { name: "Adicionar neste Mac" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /personal-app/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await page.getByRole("button", { name: "Adicionar neste Mac" }).click();
  const row = dialog.locator(".setrow", { hasText: "personal-app" });
  await row.getByRole("button", { name: "Vincular pasta existente" }).click();
  await expect(row.getByRole("status")).toHaveText("/tmp/projects");
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.locator("#railbody")).toContainText("projects");
});
