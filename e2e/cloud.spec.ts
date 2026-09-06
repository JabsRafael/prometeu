import { expect, test } from "@playwright/test";

test("conta opcional na barra lateral conecta, persiste e sai sem alterar conversas", async ({ page }) => {
  await page.goto("/");
  const account = page.locator(".cloud-account");
  await expect(account.locator(".cloud-label > span")).toHaveText("Prometeu");
  await expect(account.locator(".cloud-label > small")).toHaveText("Criar conta");
  await expect(account).not.toContainText("conta opcional");
  await expect(account.locator(".av svg")).toHaveCount(1);
  const brand = await account.locator(".cloud-label > span").boundingBox();
  const signup = await account.locator(".cloud-label > small").boundingBox();
  expect(Math.abs((brand!.y + brand!.height / 2) - (signup!.y + signup!.height / 2))).toBeLessThan(2);
  expect(signup!.x).toBeGreaterThan(brand!.x + brand!.width);
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  const before = await page.locator("#chatwrap").innerText();
  await account.locator(".cloud-label > small").click();
  const dialog = page.getByRole("dialog", { name: "Conectar conta Prometeu" });
  await expect(dialog.getByRole("status")).toHaveText("ABCD-EFGH");
  await expect(dialog).toContainText("a sincronização ainda não está disponível");
  await page.evaluate(() => localStorage.setItem("mock:cloudApproved", "1"));
  await dialog.getByRole("button", { name: "Verificar conexão" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(account).toContainText("Gustavo Brancaglione");
  await expect(account.locator(".cloud-label > span")).toHaveText("Prometeu");
  await expect(account.locator(".cloud-label > small")).toHaveText("Gustavo Brancaglione");
  await expect(account.locator(".av svg")).toHaveCount(1);
  await expect(account.locator(".avatar")).toHaveCount(0);
  expect(await page.locator("#chatwrap").innerText()).toBe(before);
  await page.reload();
  await expect(account).toHaveAttribute("title", "gustavo@example.com");
  await account.focus(); await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Gerenciar conta" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Sair da conta" }).click();
  await expect(account).toContainText("Criar conta");
  await page.reload(); await expect(account).toContainText("Criar conta");
});

test("conta opcional na barra lateral cancela login e mantém trabalho local quando SaaS cai", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cloud-account").click();
  const dialog = page.getByRole("dialog", { name: "Conectar conta Prometeu" });
  await expect(dialog.getByRole("status")).toHaveText("ABCD-EFGH");
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("mock:cloudOffline", "1"));
  await page.locator(".cloud-account").click();
  await expect(dialog).toContainText("Não foi possível conectar ao Prometeu Cloud");
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.locator("#railbody .navitem.sub .lbl").getByText("Ola", { exact: true }).click();
  await expect(page.locator("#chatwrap")).toBeVisible();
  await expect(page.locator(".cloud-account")).toContainText("Criar conta");
});

test("conta opcional na barra lateral preserva identidade offline e reconhece revogação", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mock:cloud", JSON.stringify({ user: { id: "1", name: "<img src=x>", email: "me@example.com" }, origin: "https://app.prometeu.co", offline: false }));
    localStorage.setItem("mock:cloudOffline", "1");
  });
  await page.goto("/");
  const account = page.locator(".cloud-account");
  await expect(account).toContainText("<img src=x>");
  await expect(account.locator("img")).toHaveCount(0);
  await expect(account).toContainText("Conta offline");
  await page.evaluate(() => { localStorage.removeItem("mock:cloudOffline"); localStorage.setItem("mock:cloudExpired", "1"); });
  await account.click(); await page.getByRole("menuitem", { name: "Atualizar conta" }).click();
  await expect(account).toContainText("Criar conta");
});
