import { expect, test } from "@playwright/test";

test("design system searchable picker searches accents and selects with keyboard", async ({ page }) => {
  await page.goto("/packages/design-system/index.html");
  const trigger = page.getByRole("button", { name: "Buscar opção", exact: true });
  await trigger.click();
  const search = page.getByRole("searchbox", { name: "Buscar opções" });
  await expect(search).toBeFocused();
  await search.fill("acentuacao");
  await expect(page.locator(".ui-search-picker-choice")).toHaveCount(1);
  await expect(page.locator(".ui-search-picker-choice")).toContainText("Opção 000");
  await search.fill("missing option");
  await expect(page.getByText("Nenhuma opção encontrada", { exact: true })).toBeVisible();
  await search.fill("OPCAO 099");
  await expect(page.locator(".ui-search-picker-choice")).toHaveCount(1);
  await search.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger).toBeFocused();
  await expect(page.locator(".ui-search-picker")).toHaveCount(0);
  await expect(page.getByText("Escolhida: Opção 099", { exact: true })).toBeVisible();
});

test("design system searchable picker secondary action and refresh preserve search and focus", async ({ page }) => {
  await page.goto("/packages/design-system/index.html");
  await page.getByRole("button", { name: "Buscar opção", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Buscar opções" });
  await search.fill("opcao 001");
  const star = page.getByRole("button", { name: "Favoritar Opção 001", exact: true });
  await star.click();
  const saved = page.getByRole("button", { name: "Desfavoritar Opção 001", exact: true });
  await expect(saved).toHaveAttribute("aria-pressed", "true");
  await expect(saved).toBeFocused();
  await expect(search).toHaveValue("opcao 001");
  await page.getByRole("button", { name: "Atualizar opções", exact: true }).click();
  await expect(search).toHaveValue("opcao 001");
  await expect(page.getByRole("button", { name: "Atualizar opções", exact: true })).toBeFocused();
  await expect(page.getByText("Catálogo atualizado", { exact: true })).toBeVisible();
});

test("design system searchable picker stays within narrow dialog and Escape closes first", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/packages/design-system/index.html");
  await page.getByRole("button", { name: "Busca em diálogo", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Exemplo de busca", exact: true });
  const trigger = dialog.getByRole("button", { name: "Buscar opção", exact: true });
  await trigger.click();
  const picker = dialog.locator(".ui-search-picker");
  await expect(picker).toBeVisible();
  const box = await picker.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  await page.getByRole("searchbox").press("Tab");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Favoritar Opção 000", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Atualizar opções", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Mostrar opções adicionais", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("design system searchable picker mouse selection works inside a modal", async ({ page }) => {
  await page.goto("/packages/design-system/index.html");
  await page.getByRole("button", { name: "Busca em diálogo", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Exemplo de busca", exact: true });
  await dialog.getByRole("button", { name: "Buscar opção", exact: true }).click();
  await dialog.locator(".ui-search-picker-choice", { hasText: "Opção 003" }).click();
  await expect(dialog.getByText("Escolhida: Opção 003", { exact: true })).toBeVisible();
});


test("design system searchable picker matches every search term in any order", async ({ page }) => {
  await page.goto("/packages/design-system/index.html");
  await page.getByRole("button", { name: "Buscar opção", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Buscar opções" });
  for (const query of ["codex cafe", "CAFÉ   codex", "codex 000", "000 cafe"]) {
    await search.fill(query);
    await expect(page.locator(".ui-search-picker-choice")).toHaveCount(1);
    await expect(page.locator(".ui-search-picker-choice")).toContainText("Opção 000");
  }
  await search.fill("codex missing");
  await expect(page.locator(".ui-search-picker-choice")).toHaveCount(0);
});
