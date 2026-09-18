import { expect, test, type Page } from "@playwright/test";
import type { Board, ProjectTools, Selection } from "../src/types";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
declare global {
  interface Window { toolTestInvoke?: Invoke }
}

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator("#deskView")).toBeVisible();
  await page.evaluate(() => {
    window.toolTestInvoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke;
  });
}

async function openWorkspace(page: Page, id: string) {
  await page.locator(`.railworkspace[data-workspace="${id}"] .navitem.sub`).click();
  await expect(page.locator("#wsView")).toBeVisible();
}

const row = (page: Page, text: string) => page.locator(".menu .mrow").filter({ hasText: text }).first();

for (const axis of ["mcp", "plugins", "skills"] as const) {
  test(`ferramentas: restaura herança de ${axis} sem apagar outros eixos`, async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async (axis) => {
      const invoke = window.toolTestInvoke!;
      const empty = { base: "none", add: [], remove: [] };
      await invoke("set_tools_global", { mcp: empty, plugins: empty, skills: empty });
      await invoke(`set_workspace_${axis}`, { id: "sessao-0929", [axis]: empty });
      await invoke(`set_workspace_${axis}`, { id: "sessao-0929" });
      const before = (await invoke("load_board") as Board).workspaces[0][axis];
      await invoke(`set_workspace_${axis}`, { id: "sessao-0929", [axis]: null });
      await invoke("set_tools_global", { [axis]: null });
      const board = await invoke("load_board") as Board;
      return { before, own: board.workspaces[0][axis], global: board.tools };
    }, axis);
    expect(result.before).toEqual({ base: "none", add: [], remove: [] });
    expect(result.own).toBeNull();
    for (const key of ["mcp", "plugins", "skills"] as const) {
      expect(result.global![key]).toEqual(key === axis ? null : { base: "none", add: [], remove: [] });
    }
  });
}

for (const declaration of [
  { base: "inherit", add: [], remove: ["capim-ds"] },
  { base: "none", add: [], remove: [] },
] satisfies Selection[]) {
  test(`ferramentas: aprova projeto com ${declaration.base === "none" ? "substituição vazia" : "apenas remoções"}`, async ({ page }) => {
    await boot(page);
    await page.evaluate(async (selection) => {
      const invoke = window.toolTestInvoke!;
      // Change the browser's shared fixture to a declaration with no added item.
      const project = await invoke("project_tools", { id: "ui-2231" }) as ProjectTools;
      project.tools.plugins = null;
      project.tools.mcp = selection;
      await invoke("set_tools_global", { mcp: { base: "inherit", add: ["capim-ds"], remove: [] } });
    }, declaration);
    await openWorkspace(page, "ui-2231");
    await page.locator("#chatwrap .mcpbtn").click();
    await expect(row(page, "Confiar nas ferramentas do projeto")).toBeVisible();
    await row(page, "Confiar nas ferramentas do projeto").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(declaration.base === "none" ? "substitui todas" : "remove capim-ds");
    await dialog.getByRole("button", { name: "Confiar e ativar" }).click();
    await expect(dialog).toHaveCount(0);
    const project = await page.evaluate(() => window.toolTestInvoke!("project_tools", { id: "ui-2231" })) as ProjectTools;
    expect(project.pending).toBe(false);
    expect(project.decision?.approved).toBe(true);
    // The workspace menu keeps the declaration accessible after approval, without pending rows.
    await page.locator('.railworkspace[data-workspace="ui-2231"] .navitem.sub').click({ button: "right" });
    await row(page, "Ferramentas do projeto").click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
}

test("ferramentas: diálogo antigo não aprova declaração nova", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    let first = true;
    internals.invoke = async (command, args) => {
      const result = await original(command, args);
      if (command === "project_tools" && first) {
        first = false;
        return { ...(result as ProjectTools), hash: "previously-displayed-version" };
      }
      return result;
    };
  });
  const open = async () => {
    await page.locator('.railworkspace[data-workspace="ui-2231"] .navitem.sub').click({ button: "right" });
    await row(page, "Ferramentas do projeto").click();
  };
  await open();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confiar e ativar" }).click();
  await expect(dialog).toContainText("A declaração mudou");
  expect(await page.evaluate(async () => (await window.toolTestInvoke!("load_board") as Board).tool_trust ?? [])).toEqual([]);
  await dialog.getByRole("button", { name: "Agora não" }).click();
  await open();
  await dialog.getByRole("button", { name: "Confiar e ativar" }).click();
  await expect(dialog).toHaveCount(0);
});

test("ferramentas: base do CLI acompanha provider da aba e explica próximo início", async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const invoke = window.toolTestInvoke!;
    const board = await invoke("load_board") as Board;
    board.workspaces[0].tabs[1].choice = { agent: "codex", model: "gpt-5.6-sol", effort: "high" };
    await invoke("set_stage", { id: "sessao-0929", stage: "Fazendo" });
  });
  await openWorkspace(page, "sessao-0929");
  await page.locator("#chatwrap .mcpbtn").click();
  await expect(row(page, "metabase")).toBeVisible();
  await expect(row(page, "vale ao iniciar uma conversa")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('#tabbar .tab[data-tab="t2"]').click();
  await page.locator("#chatwrap .mcpbtn").click();
  await expect(page.locator(".menu")).toBeVisible();
  await expect(row(page, "metabase")).toHaveCount(0);
  await expect(row(page, "n8n")).toHaveCount(0);
  await row(page, "Sem nenhum").click();
  await expect(row(page, "Herdar padrões")).toBeVisible();
  await row(page, "Herdar padrões").click();
  await expect.poll(() => page.evaluate(async () => (await window.toolTestInvoke!("load_board") as Board).workspaces[0].mcp)).toBeNull();
});

test("ferramentas: MCP integrado disponível sem ativação automática", async ({ page }) => {
  await boot(page);
  const initial = await page.evaluate(async () => {
    const invoke = window.toolTestInvoke!;
    const hub = await invoke("mcp_hub") as { id: string; config: Record<string, unknown> }[];
    const states = await Promise.all(["claude", "codex"].map(agent =>
      invoke("workspace_tools", { id: "sessao-0929", agent }) as Promise<{ mcp: { id: string }[] }>));
    return { builtin: hub.find(s => s.id === "prometeu"), selected: states.map(s => s.mcp.some(i => i.id === "prometeu")) };
  });
  expect(initial.builtin?.config).toEqual({ type: "stdio", builtin: true });
  expect(initial.selected).toEqual([false, false]);
  await openWorkspace(page, "sessao-0929");
  await page.locator("#chatwrap .mcpbtn").click();
  await expect(row(page, "prometeu")).toBeVisible();
  await row(page, "prometeu").click();
  await expect.poll(() => page.evaluate(async () => {
    const tools = await window.toolTestInvoke!("workspace_tools", { id: "sessao-0929" }) as { mcp: { id: string; provenance: string }[] };
    return tools.mcp.find(i => i.id === "prometeu")?.provenance;
  })).toBe("added");
  const rejected = await page.evaluate(async () => {
    const invoke = window.toolTestInvoke!;
    const blocked: string[] = [];
    for (const [command, args] of [
      ["mcp_remove", { id: "prometeu" }],
      ["mcp_save", { server: { id: "prometeu", config: { command: "echo" }, note: "" } }],
    ] as const) {
      try { await invoke(command, args); } catch { blocked.push(command); }
    }
    return blocked;
  });
  expect(rejected).toEqual(["mcp_remove", "mcp_save"]);
});
