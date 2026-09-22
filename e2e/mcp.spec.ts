import { expect, test, type Page } from "@playwright/test";
import type { McpServer } from "../src/types";

type McpWindow = Window & {
  __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
  mcpCalls: string[];
  releaseMcpLogin?: () => void;
  releaseMcpCheck?: () => void;
  mock: { catalog: (servers: McpServer[]) => void };
};

async function openTools(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("mock:cloud", JSON.stringify({ user: { id: "1", name: "Pessoa", email: "me@example.com" }, origin: "https://app.prometeu.co", offline: false }));
    localStorage.setItem("mock:cloudOffline", "1");
  });
  await page.goto("/");
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as McpWindow;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.mcpCalls = [];
    w.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command.startsWith("mcp_")) w.mcpCalls.push(command);
      if (command === "mcp_login") {
        if (localStorage.getItem("test:denyMcpLogin")) throw 'i18n:{"code":"err.mcp.auth.denied"}';
        if (localStorage.getItem("test:holdMcpLogin")) await new Promise<void>((resolve) => { w.releaseMcpLogin = resolve; });
      }
      if (command === "mcp_check" && localStorage.getItem("test:holdMcpCheck")) {
        await new Promise<void>((resolve) => { w.releaseMcpCheck = resolve; });
      }
      if (command === "mcp_check" && localStorage.getItem("test:failMcpCheck")) return {
        steps: [{ key: "connect", ok: false, note: "", detail: "connection refused" }],
        probe: { ok: false, auth: false, tools: 0, name: "", detail: "connection refused" },
      };
      return invoke(command, args);
    };
  });
  await page.locator("#settings").click();
  await page.locator(".setnavitem", { hasText: "Ferramentas" }).click();
}

test("ferramentas: MCP do Cloud testa e autentica localmente, com falha recuperável e sem cópia", async ({ page }) => {
  await openTools(page);
  const row = page.locator(".mcp-server", { has: page.locator("b", { hasText: /^notion$/ }) });
  const catalogBefore = await page.evaluate(() => localStorage.getItem("mock:catalog"));
  await expect(row).toContainText("na nuvem");
  await expect(row.getByRole("status")).toHaveText("Não verificado neste Mac");
  await row.getByRole("button", { name: "Testar conexão" }).click();
  await expect(row.getByRole("status")).toHaveText("Exige autenticação neste Mac");

  await page.evaluate(() => localStorage.setItem("test:denyMcpLogin", "1"));
  await row.getByRole("button", { name: "Autenticar", exact: true }).click();
  await expect(row.getByRole("status")).toContainText("Erro de conexão");
  await expect(row.getByRole("button", { name: "Autenticar", exact: true })).toBeEnabled();
  await page.evaluate(() => {
    localStorage.removeItem("test:denyMcpLogin");
    localStorage.setItem("test:holdMcpLogin", "1");
  });
  await row.getByRole("button", { name: "Autenticar", exact: true }).click();
  await expect(row).toHaveAttribute("aria-busy", "true");
  await expect(row.getByRole("button", { name: "Testar conexão" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "Editar", exact: true })).toBeDisabled();
  // A settings redraw must not allow a second login while browser consent is pending.
  await page.locator(".setnavitem", { hasText: "Plugins" }).click();
  await page.locator(".setnavitem", { hasText: "Ferramentas" }).click();
  await expect(row.getByRole("button", { name: "Autenticar", exact: true })).toBeDisabled();
  await page.evaluate(() => (window as McpWindow).releaseMcpLogin!());
  await expect(row.getByRole("status")).toHaveText("conectado");

  // A saved token does not hide a failed connection check.
  await page.evaluate(() => localStorage.setItem("test:failMcpCheck", "1"));
  await row.getByRole("button", { name: "Testar conexão" }).click();
  await expect(row.getByRole("status")).toHaveText("Erro de conexão · connection refused");
  await page.evaluate(() => localStorage.removeItem("test:failMcpCheck"));
  await row.getByRole("button", { name: "Testar conexão" }).click();
  await expect(row.getByRole("status")).toHaveText("conectado");
  await row.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Exige autenticação neste Mac");
  expect(await page.evaluate(() => localStorage.getItem("mock:catalog"))).toBe(catalogBefore);
  expect(await page.evaluate(() => (window as McpWindow).mcpCalls)).not.toContain("mcp_save");
  await expect(page.locator(".mcp-server", { has: page.locator("b", { hasText: /^notion$/ }) })).toHaveCount(1);

  const local = page.locator(".mcp-server", { has: page.locator("b", { hasText: /^capim-ds$/ }) });
  await expect(local.getByRole("button", { name: "Autenticar", exact: true })).toHaveCount(0);
  await local.getByRole("button", { name: "Testar conexão" }).click();
  await expect(local.getByRole("status")).toHaveText("conectado");
  await expect(page.locator(".mcp-server", { has: page.locator("b", { hasText: /^prometeu$/ }) }).getByRole("button")).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 800 });
  const bounds = await row.getByRole("button", { name: "Excluir da nuvem" }).boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(900);
});

test("ferramentas: autenticação no editor não salva catálogo nem publica rascunho", async ({ page }) => {
  await openTools(page);
  const row = page.locator(".mcp-server", { has: page.locator("b", { hasText: /^notion$/ }) });
  await row.getByRole("button", { name: "Editar", exact: true }).click();
  // The catalog revision can change after opening the editor without blocking local OAuth.
  const changed = JSON.stringify({ connected: true, revision: 7, plugins: [], mcp: ["notion"], skills: [], shared: { "mcp:notion": "notion" } });
  await page.evaluate((value) => localStorage.setItem("mock:catalog", value), changed);
  await page.locator("#veil").getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.locator("#veil").getByRole("button", { name: "Sair", exact: true })).toBeVisible();
  await page.locator("#veil").getByRole("button", { name: "Cancelar", exact: true }).click();
  // A saved login without a cached check offers sign-out, not another browser OAuth flow.
  await expect(row.getByRole("status")).toHaveText("Não verificado neste Mac");
  await expect(row.getByRole("button", { name: "Autenticar", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Sair", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Editar", exact: true }).click();
  await page.locator("#veil").getByRole("button", { name: "Sair", exact: true }).click();
  await page.locator("#veil .mhead").click();
  await page.locator("#veil").getByLabel("URL do servidor remoto", { exact: true }).fill("https://mcp.capim.test/mcp");
  await page.locator("#veil").getByLabel("URL do servidor remoto", { exact: true }).press("Tab");
  await expect(page.locator("#veil .mcheck")).toContainText("Servidor verificado");
  await page.locator("#veil").getByRole("button", { name: "Continuar", exact: true }).click();
  await page.locator("#veil").getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.locator("#veil .hint")).toHaveText("Salve as alterações de conexão antes de autenticar.");
  const calls = await page.evaluate(() => (window as McpWindow).mcpCalls);
  expect(calls.filter((command) => command === "mcp_login")).toHaveLength(1);
  expect(calls).not.toContain("mcp_save");
  expect(await page.evaluate(() => localStorage.getItem("mock:catalog"))).toBe(changed);
});

for (const action of ["login", "check"] as const) {
  test(`ferramentas: refresh preserva bloqueio de ${action} e descarta resultado antigo`, async ({ page }) => {
    await openTools(page);
    const id = action === "login" ? "notion" : "linear-server";
    const row = page.locator(".mcp-server", { has: page.locator("b", { hasText: new RegExp(`^${id}$`) }) });
    await page.evaluate((action) => localStorage.setItem(action === "login" ? "test:holdMcpLogin" : "test:holdMcpCheck", "1"), action);
    await row.getByRole("button", { name: action === "login" ? "Autenticar" : "Testar conexão", exact: true }).click();
    await expect(row).toHaveAttribute("aria-busy", "true");
    await page.evaluate(async (id) => {
      const w = window as McpWindow;
      const servers = await w.__TAURI_INTERNALS__.invoke("mcp_hub") as McpServer[];
      w.mock.catalog(servers.map((server) => server.id === id
        ? { ...server, config: { ...server.config, url: "https://quebrado.test/mcp" } } : server));
    }, id);
    await expect(row).toContainText("https://quebrado.test/mcp");
    await expect(row).toHaveAttribute("aria-busy", "true");
    await expect(row.getByRole("button", { name: "Testar conexão" })).toBeDisabled();
    await expect(row.getByRole("button", { name: "Editar", exact: true })).toBeDisabled();
    await page.evaluate((action) => {
      const w = window as McpWindow;
      if (action === "login") w.releaseMcpLogin!();
      else { localStorage.removeItem("test:holdMcpCheck"); w.releaseMcpCheck!(); }
    }, action);
    await expect(row).toHaveAttribute("aria-busy", "false");
    await expect(row.getByRole("status")).toHaveText("Não verificado neste Mac");
    await row.getByRole("button", { name: "Testar conexão" }).click();
    await expect(row.getByRole("status")).toHaveText("Erro de conexão · connection refused");
    const calls = await page.evaluate(() => (window as McpWindow).mcpCalls);
    expect(calls.filter((command) => command === "mcp_login")).toHaveLength(action === "login" ? 1 : 0);
    expect(calls.filter((command) => command === "mcp_check")).toHaveLength(2);
  });
}
