import { expect, test, type Locator, type Page } from "@playwright/test";

const email = "pessoa.com.sobrenome.comprido@departamento.empresa.exemplo.com";

async function seed(page: Page, locale: string) {
  await page.addInitScript(({ locale, email }) => {
    localStorage.setItem("prometeu:idioma", locale);
    localStorage.setItem("prometeu:model-choice", JSON.stringify({ agent: "codex", model: "gpt-5.6-sol" }));
    localStorage.setItem("prometeu:effort", "high");
    localStorage.setItem("mock:accounts", JSON.stringify({ accounts: [
      { id: "codex", provider: "codex", email, plan: "pro", connected: true, revision: 0 },
    ], active: { codex: "codex" }, login: null }));
  }, { locale, email });
  await page.goto("/");
  await expect(page.locator("#railbody .navitem.sub").first()).toBeVisible();
}

async function inside(locator: Locator, container: Locator) {
  const item = (await locator.boundingBox())!;
  const bounds = (await container.boundingBox())!;
  expect(item.x).toBeGreaterThanOrEqual(bounds.x);
  expect(item.x + item.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(item.y).toBeGreaterThanOrEqual(bounds.y);
  expect(item.y + item.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
}

// Cover the two-column and stacked layouts without a locale/viewport matrix.
for (const [width, height, locale] of [
  [1280, 800, "pt-BR"], [390, 720, "en"],
] as const) {
  test(`launcher layout: readable settings and fixed actions at ${width}×${height} in ${locale}`, { tag: "@webkit" }, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await seed(page, locale);
    await page.locator("#railbody").getByRole("button", { name: locale === "en" ? "Create" : "Criar", exact: true }).click();
    const scroll = page.locator(".launcher-scroll");
    const footer = page.locator(".launcher-footer");
    await expect(page.locator("#d-model")).toContainText("GPT-5.6-Sol");
    const footerTop = (await footer.boundingBox())!.y;
    if (width === 1280) expect(await scroll.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    for (const id of ["d-project", "d-base", "d-issuebtn", "d-model", "d-effort", "d-account", "d-mcp", "d-plugins"]) {
      const control = page.locator(`#${id}`);
      await control.scrollIntoViewIfNeeded();
      await inside(control, scroll);
      expect(await control.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect((await footer.boundingBox())!.y).toBe(footerTop);
    }
    await inside(page.locator("#d-go"), footer);
    expect((await footer.boundingBox())!.y + (await footer.boundingBox())!.height).toBeLessThanOrEqual(height);
    await expect(page.locator(".launcher-account-name")).toHaveText(email);
    expect(await scroll.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

    await page.locator("#d-account").click();
    const dialog = page.locator(".account-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("strong")).toHaveText(email);
    await inside(dialog.locator(".ui-form-footer .pri"), dialog);
    expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("#d-account")).toBeFocused();

    await page.locator("#d-model").click();
    await expect(page.locator(".ui-search-picker")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#d-model")).toBeFocused();
    await expect(page.locator(".launcher")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#veil")).toBeHidden();
  });
}

test("launcher layout: native branch controls preserve worktree and multiple-repository rules", async ({ page }) => {
  await seed(page, "pt-BR");
  await page.locator("#railbody").getByRole("button", { name: "Criar", exact: true }).click();
  await expect(page.locator("#d-nb")).toBeChecked();
  await expect(page.locator("#d-nb")).toBeDisabled();
  await page.locator("#d-wt").uncheck();
  await page.locator("#d-nb").uncheck();
  await expect(page.locator("#d-base")).toBeDisabled();
  await page.locator("#d-more").click();
  await page.getByRole("menuitem", { name: "prometeu", exact: true }).click();
  await expect(page.locator("#d-wt")).toBeChecked();
  await expect(page.locator("#d-wt")).toBeDisabled();
  await expect(page.locator("#d-nb")).toBeChecked();
  await expect(page.locator("#d-nb")).toBeDisabled();
  await page.getByTitle("Tirar prometeu deste workspace", { exact: true }).click();
  await expect(page.locator("#d-wt")).toBeEnabled();
});
