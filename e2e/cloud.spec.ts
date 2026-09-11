import { expect, test } from "@playwright/test";

test("organizações no desktop oferecem instalação direta sem alterar catálogo pessoal", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mock:cloud", JSON.stringify({ user: { id: "1", name: "Pessoa", email: "me@example.com" }, origin: "https://app.prometeu.co", offline: false }));
    localStorage.setItem("mock:organizationCatalogs", JSON.stringify([
      { id: "acme", name: "Equipe Acme", links: {},
        plugins: [{ id: "revisor", source: "https://github.com/acme/revisor", note: "Revisão da equipe" }],
        mcp: [{ id: "notion", config: { url: "https://acme.test/mcp", headers: { Authorization: "" } }, note: "Documentos da equipe" }],
        skills: [{ id: "revisao-cloud", description: "Revisão institucional", content: "Leia mudanças da equipe." }] },
      { id: "other", name: "Outra equipe", links: {}, plugins: [{ id: "revisor", source: "https://github.com/other/revisor", note: "Outra revisão" }], mcp: [], skills: [] },
    ]));
  });
  await page.goto("/");
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  await page.locator("#settings").click();
  await page.locator(".setnavitem", { hasText: "Plugins" }).click();
  const acme = page.locator(".setrow", { hasText: "Equipe Acme" });
  await expect(acme).toContainText("https://github.com/acme/revisor");
  await page.evaluate(() => {
    const organizations = JSON.parse(localStorage.getItem("mock:organizationCatalogs")!);
    organizations[0].revision = 1;
    organizations[0].plugins[0].source = "https://github.com/acme/revisor-v2";
    localStorage.setItem("mock:organizationCatalogs", JSON.stringify(organizations));
  });
  await acme.getByRole("button", { name: "Instalar aqui" }).click();
  await expect(page.locator(".setrow", { hasText: "cloud-revisor-1" })).toHaveCount(0);
  await expect(acme).toContainText("https://github.com/acme/revisor-v2");
  await acme.getByRole("button", { name: "Instalar aqui" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".setrow", { hasText: "cloud-revisor-1" })).toContainText("só neste Mac");
  await expect(acme).toHaveCount(0);
  await page.locator(".setrow", { hasText: "Outra equipe" }).getByRole("button", { name: "Instalar aqui" }).click();
  await expect(page.locator(".setrow", { hasText: "cloud-revisor-2" })).toContainText("só neste Mac");
  // The uninstalled personal item keeps its identity and remains available independently.
  await expect(page.locator(".setrow", { has: page.locator("b", { hasText: /^revisor$/ }) }).getByRole("button", { name: "Instalar aqui" })).toBeVisible();
  await page.locator(".setnavitem", { hasText: "Ferramentas" }).click();
  await expect(acme).toContainText("Documentos da equipe");
  await page.evaluate(() => localStorage.setItem("mock:cloudOffline", "1"));
  await acme.getByRole("button", { name: "Instalar aqui" }).click();
  await expect(acme.getByRole("button", { name: "Instalar aqui" })).toBeEnabled();
  await expect(page.locator(".setrow", { hasText: "cloud-notion-1" })).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem("mock:cloudOffline"));
  await acme.getByRole("button", { name: "Instalar aqui" }).click();
  await expect(page.locator(".setrow", { hasText: "cloud-notion-1" })).toContainText("só neste Mac");
  await expect(page.locator(".setrow", { has: page.locator("b", { hasText: /^notion$/ }) })).toContainText("na nuvem");
  await page.locator(".setnavitem", { hasText: "Skills" }).click();
  await acme.getByRole("button", { name: "Instalar aqui" }).click();
  await expect(page.locator(".setrow", { hasText: "cloud-revisao-cloud-1" })).toContainText("só neste Mac");
  expect(await page.evaluate(() => localStorage.getItem("mock:catalog"))).toBeNull();
  await page.evaluate(() => localStorage.setItem("mock:organizationCatalogs", "[]"));
  await page.locator(".cloud-account").click();
  await page.getByRole("menuitem", { name: "Atualizar conta" }).click();
  await expect(page.locator(".setrow", { hasText: "cloud-revisao-cloud-1" })).toContainText("só neste Mac");
});

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
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(account.getByRole("status")).toHaveText("ABCD-EFGH");
  await expect(account).toHaveAttribute("title", /Autorize somente se o navegador mostrar este mesmo código/);
  await page.evaluate(() => localStorage.setItem("mock:cloudApproved", "1"));
  await expect(account).toContainText("Gustavo Brancaglione");
  await expect(account.locator(".cloud-label > span")).toHaveText("Prometeu");
  await expect(account.locator(".cloud-label > small")).toHaveText("Gustavo Brancaglione");
  await expect(account.locator(".av svg")).toHaveCount(1);
  await expect(account.locator(".avatar")).toHaveCount(0);
  expect(await page.locator("#chatwrap").innerText()).toBe(before);
  await page.reload();
  await expect(account).toHaveAttribute("title", "gustavo@example.com");
  // Account catalogs show each item's source; cloud-only items require installation.
  await page.locator("#settings").click();
  await page.locator(".setnavitem", { hasText: "Plugins" }).click();
  await expect(page.locator(".setrow", { hasText: "caveman" })).toContainText("na nuvem");
  await expect(page.locator(".setrow", { hasText: "ponytail" })).toContainText("só neste Mac");
  const pending = page.locator(".setrow", { hasText: "revisor" });
  await expect(pending).toContainText("não instalado neste Mac");
  await pending.getByRole("button", { name: "Instalar aqui" }).click();
  await expect(page.getByRole("dialog", { name: "Instalar aqui" })).toContainText("https://github.com/prometeu/revisor");
  await page.keyboard.press("Escape");
  await page.locator(".setnavitem", { hasText: "Ferramentas" }).click();
  await expect(page.locator(".setrow", { hasText: "notion" })).toContainText("na nuvem");
  await expect(page.locator(".setrow", { hasText: "capim-ds" })).toContainText("só neste Mac");
  await page.locator(".cloud-account").scrollIntoViewIfNeeded();
  await account.focus(); await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Gerenciar conta" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Sair da conta" }).click();
  await expect(account).toContainText("Criar conta");
  await page.reload(); await expect(account).toContainText("Criar conta");
});

test("conta opcional na barra lateral cancela login e mantém trabalho local quando SaaS cai", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cloud-account").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".cloud-account").getByRole("status")).toHaveText("ABCD-EFGH");
  await page.locator(".cloud-account").click();
  await page.getByRole("menuitem", { name: "Cancelar", exact: true }).click();
  await expect(page.locator(".cloud-account")).toContainText("Criar conta");
  await page.evaluate(() => localStorage.setItem("mock:cloudOffline", "1"));
  await page.locator(".cloud-account").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Não foi possível conectar ao Prometeu Cloud", { exact: false })).toBeVisible();
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

test("catálogo pessoal mantém skills privadas, publica por escolha e cria cópia independente", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:cloud", JSON.stringify({ user: { id: "1", name: "Pessoa", email: "me@example.com" }, origin: "https://app.prometeu.co", offline: false })));
  await page.goto("/");
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  await page.locator("#settings").click();
  await page.locator(".setnavitem", { hasText: "Skills" }).click();
  const pending = page.locator(".setrow", { has: page.locator("b", { hasText: /^revisao-cloud$/ }) });
  await expect(pending).toContainText("não instalado neste Mac");
  await pending.getByRole("button", { name: "Instalar aqui" }).click();
  await expect(pending).toContainText("na nuvem");
  await page.getByRole("button", { name: "Criar skill", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Criar skill" });
  await dialog.getByLabel("Nome da skill").fill("minha-revisao");
  await dialog.getByLabel("Quando usar esta skill").fill("Antes de entregar código");
  await dialog.getByLabel("Instruções", { exact: true }).fill("Leia alterações e rode testes.");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  const local = page.locator(".setrow", { has: page.locator("b", { hasText: /^minha-revisao$/ }) });
  await expect(local).toContainText("só neste Mac");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mock:catalog") ?? "{}").shared?.["skills:minha-revisao"])).toBeUndefined();
  await local.getByRole("button", { name: "Compartilhar na nuvem" }).click();
  dialog = page.getByRole("dialog", { name: "Compartilhar na nuvem" });
  await dialog.getByRole("button", { name: "Compartilhar na nuvem" }).click();
  await expect(local).toContainText("na nuvem");
  await local.getByRole("button", { name: "Criar cópia local" }).click();
  dialog = page.getByRole("dialog", { name: "Criar cópia local" });
  await dialog.getByLabel("Nome da cópia").fill("minha-copia");
  await dialog.getByRole("button", { name: "Criar cópia local" }).click();
  const copy = page.locator(".setrow", { has: page.locator("b", { hasText: /^minha-copia$/ }) });
  await expect(copy).toContainText("só neste Mac");
  await page.evaluate(() => localStorage.setItem("mock:cloudOffline", "1"));
  await copy.getByRole("button", { name: "Editar", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Editar skill" });
  await dialog.getByLabel("Instruções", { exact: true }).fill("Somente local, mesmo offline.");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mock:catalog")!).skills.find((s: {id:string}) => s.id === "minha-revisao").content)).toBe("Leia alterações e rode testes.");
  await local.getByRole("button", { name: "Editar", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Editar skill" });
  await dialog.getByLabel("Instruções", { exact: true }).fill("Tentativa offline");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await expect(dialog.getByLabel("Instruções", { exact: true })).toHaveValue("Tentativa offline");
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await page.evaluate(() => localStorage.removeItem("mock:cloudOffline"));
  await pending.getByRole("button", { name: "Remover deste Mac" }).click();
  await expect(pending).toContainText("não instalado neste Mac");
  await expect(pending.getByRole("button", { name: "Instalar aqui" })).toBeVisible();
});

test("catálogo pessoal recusa salvar editor antigo sobre revisão mais nova", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mock:cloud", JSON.stringify({ user: { id: "1", name: "Pessoa", email: "me@example.com" }, origin: "https://app.prometeu.co", offline: false })));
  await page.goto("/");
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  await page.locator("#settings").click();
  await page.locator(".setnavitem", { hasText: "Skills" }).click();
  const row = page.locator(".setrow", { has: page.locator("b", { hasText: /^revisao-cloud$/ }) });
  await row.getByRole("button", { name: "Instalar aqui" }).click();
  await row.getByRole("button", { name: "Editar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Editar skill" });
  await page.evaluate(() => localStorage.setItem("mock:catalog", JSON.stringify({ connected: true, revision: 7, plugins: [], mcp: [],
    skills: [{ id: "revisao-cloud", local_id: "revisao-cloud", installed: true, description: "Revisar", content: "Atualizado no SaaS" }], shared: { "skills:revisao-cloud": "revisao-cloud" } })));
  await dialog.getByLabel("Instruções", { exact: true }).fill("Rascunho antigo");
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("O catálogo mudou");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mock:catalog")!).skills[0].content)).toBe("Atualizado no SaaS");
});
