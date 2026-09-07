import { expect, test } from "@playwright/test";

test("organizações no desktop selecionam acesso aceito e mantêm compartilhamento no escopo escolhido", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("mock:cloud")) localStorage.setItem("mock:cloud", JSON.stringify({ user: { id: "user1", name: "Alice", email: "alice@example.com" }, origin: "https://app.prometeu.co", offline: false }));
    if (!localStorage.getItem("mock:organizations")) localStorage.setItem("mock:organizations", JSON.stringify([
      { id: "organization1", slug: "one", name: "One", member: "membership1", role: "owner" },
      { id: "organization2", slug: "two", name: "Two", member: "membership2", role: "member" },
    ]));
  });
  await page.goto("/");
  await expect(page.locator(".cloud-account")).toContainText("Alice");
  await page.locator("#settings").click();
  await page.locator(".setnavitem", { hasText: "Organizações" }).click();
  await expect(page.getByRole("button", { name: "Criar time", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Entrar com código", exact: true })).toHaveCount(0);
  const choice = () => page.getByLabel("Compartilhar workspaces com", { exact: true });
  await choice().click();
  await page.getByRole("menuitemcheckbox", { name: "One", exact: true }).click();
  await expect(page.locator(".setrow", { hasText: "One" }).first()).toContainText("Conectado");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mock:team")!).cloud)).toMatchObject({ user: "user1", slug: "one" });
  expect(await page.evaluate(() => localStorage.getItem("mock:shared"))).toBeNull();
  await page.reload();
  await page.locator("#settings").click();
  await expect(choice()).toContainText("One");
  await choice().click();
  await page.getByRole("menuitemcheckbox", { name: "Two", exact: true }).click();
  await expect(page.locator(".setrow", { hasText: "Two" }).first()).toContainText("Conectado");
  expect(await page.evaluate(() => localStorage.getItem("mock:shared"))).toBeNull();
  await page.evaluate(() => localStorage.setItem("mock:organizations", "[]"));
  await page.locator(".cloud-account").click();
  await page.getByRole("menuitem", { name: "Atualizar conta" }).click();
  await expect(choice()).toHaveCount(0);
  await expect(page.locator("#settingsView")).toContainText("Crie organizações");
});
