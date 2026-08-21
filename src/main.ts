import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import * as board from "./board";
import * as dock from "./dock";
import { openLauncher, type Draft } from "./launcher";
import * as session from "./session";
import "./style.css";
import { statusOf, type Board, type Question, type Status, type Workspace } from "./types";

const $ = (id: string) => document.getElementById(id)!;
let state: Board = { columns: [], projects: [], workspaces: [] };
let openWs: string | null = null;

const LABEL: Record<Status, string> = {
  rodando: "rodando",
  querendo: "quer você",
  pronta: "pronta",
  desligada: "desligada",
};

function say(text: string, isError = false) {
  $("msg").textContent = text;
  $("msg").classList.toggle("err", isError);
}

const current = () => state.workspaces.find((w) => w.id === openWs);

/* ---------- navegação ---------- */

const hooks: board.Hooks = {
  open: (ws) => openWorkspace(ws),
  move: (id, column) => invoke("move_workspace", { id, column }),
  drop: (id) => {
    if (openWs === id) showBoard();
    invoke("remove_workspace", { id });
  },
  toBoard: () => showBoard(),
  addProject: async () => {
    const dir = await open({ directory: true, title: "Escolha o repositório" });
    if (typeof dir !== "string") return;
    invoke("add_project", { path: dir }).catch((e) => say(String(e), true));
  },
  newWorkspace: (projectId) => launch(projectId),
};

function draw() {
  board.render(state, hooks);
  if (openWs) drawWorkspace();
}

function showBoard() {
  session.detach();
  board.setOpen((openWs = null));
  $("boardView").hidden = false;
  $("wsView").hidden = true;
  $("crumb").textContent = "todos os workspaces";
  draw();
}

async function openWorkspace(ws: Workspace) {
  const first = ws.tabs.find((t) => t.id === ws.active) ?? ws.tabs[0];
  board.setOpen((openWs = ws.id));
  openDirs.clear();
  dockPane = null;
  dock.detach();
  drawDockTabs();
  $("boardView").hidden = true;
  $("wsView").hidden = false;
  draw();
  if (first) await session.attach(first.id);
}

/* ---------- tela do workspace ---------- */

function drawWorkspace() {
  const ws = current();
  if (!ws) return showBoard();

  $("crumb").textContent = `${ws.repo_name} › ${ws.title}`;
  $("wtpath").textContent = ws.worktree;
  $("offpath").textContent = ws.worktree;
  drawTabs(ws);
  drawDiff(ws.id);
  if (sidePane === "files") drawTree(ws.id);

  const tab = ws.tabs.find((t) => t.id === session.currentSession());
  // Terminal mudo confunde; a saída fica escrita na tela.
  $("offline").hidden = tab?.status !== "desligada";
}

/// Barra de abas à esquerda, etapa do quadro à direita: uma linha só, cheia.
function drawTabs(ws: Workspace) {
  const bar = $("tabbar");
  bar.replaceChildren();

  for (const tab of ws.tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (tab.id === session.currentSession() ? " on" : "");
    b.innerHTML = `<i class="dot"></i><span></span>`;
    (b.children[0] as HTMLElement).style.background = `var(--dot-${tab.status})`;
    b.children[1].textContent = tab.title;
    b.title = LABEL[tab.status];
    b.addEventListener("click", () => selectTab(ws.id, tab.id));

    if (ws.tabs.length > 1) {
      const x = document.createElement("span");
      x.className = "tabx";
      x.textContent = "×";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        invoke("close_tab", { workspace: ws.id, tab: tab.id });
      });
      b.append(x);
    }
    bar.append(b);
  }

  const add = document.createElement("button");
  add.className = "tabadd";
  add.textContent = "+";
  add.title = "Conversa nova, mesmos arquivos  ⌘T";
  add.addEventListener("click", () => newTab());
  bar.append(add);

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  bar.append(spacer);

  const chip = document.createElement("span");
  const st = statusOf(ws);
  chip.className = `chip s-${st}`;
  chip.innerHTML = `<i class="dot"></i>`;
  chip.append(LABEL[st]);
  bar.append(chip);

  for (const name of state.columns) {
    const b = document.createElement("button");
    b.className = "colchip" + (name === ws.column ? " on" : "");
    b.textContent = name;
    b.addEventListener("click", () => invoke("move_workspace", { id: ws.id, column: name }));
    bar.append(b);
  }
}

async function selectTab(workspace: string, tab: string) {
  invoke("focus_tab", { workspace, tab });
  await session.attach(tab);
  drawWorkspace();
}

async function newTab() {
  const ws = current();
  if (!ws) return;
  try {
    const tab = await invoke<{ id: string }>("new_tab", {
      workspace: ws.id,
      prompt: "",
      ...session.dims(),
    });
    await session.attach(tab.id);
    drawWorkspace();
  } catch (err) {
    say(String(err), true);
  }
}

/* ---------- painel da direita ---------- */

let sidePane: "files" | "diff" = "files";
let dockPane: "run" | "terminal" | null = null;
const openDirs = new Set<string>();

function setSidePane(pane: "files" | "diff") {
  sidePane = pane;
  $("tab-files").classList.toggle("on", pane === "files");
  $("tab-diff").classList.toggle("on", pane === "diff");
  $("tree").hidden = pane !== "files";
  $("difflist").hidden = pane !== "diff";
  const ws = current();
  if (ws && pane === "files") drawTree(ws.id);
}

$("tab-files").addEventListener("click", () => setSidePane("files"));
$("tab-diff").addEventListener("click", () => setSidePane("diff"));

/// Árvore preguiçosa: uma pasta por chamada, aberta sob demanda. Repo grande
/// não paga por galho que ninguém abriu.
async function drawTree(id: string) {
  const tree = $("tree");
  tree.replaceChildren();
  await fillDir(id, "", tree, 0);
}

type Entry = { name: string; path: string; dir: boolean };

async function fillDir(id: string, rel: string, into: HTMLElement, depth: number) {
  const entries = await invoke<Entry[]>("list_dir", { id, rel });
  for (const entry of entries) {
    const row = document.createElement("button");
    row.className = "treerow" + (entry.dir ? " isdir" : "");
    row.style.paddingLeft = `${8 + depth * 13}px`;
    row.innerHTML = `<span class="tw"></span><span class="tn"></span>`;
    row.children[0].textContent = entry.dir ? "▸" : "";
    row.children[1].textContent = entry.name;
    into.append(row);

    if (!entry.dir) continue;

    const kids = document.createElement("div");
    kids.hidden = true;
    into.append(kids);

    row.addEventListener("click", async () => {
      const isOpen = openDirs.has(entry.path);
      if (isOpen) {
        openDirs.delete(entry.path);
      } else {
        openDirs.add(entry.path);
        if (!kids.childElementCount) await fillDir(id, entry.path, kids, depth + 1);
      }
      kids.hidden = isOpen;
      row.children[0].textContent = isOpen ? "▸" : "▾";
    });

    if (openDirs.has(entry.path)) {
      row.children[0].textContent = "▾";
      kids.hidden = false;
      await fillDir(id, entry.path, kids, depth + 1);
    }
  }
}

/* ---------- dock: run e terminal ---------- */

async function setDock(pane: "run" | "terminal") {
  const ws = current();
  if (!ws) return;
  const same = dockPane === pane;
  dockPane = same ? null : pane;
  drawDockTabs();
  if (!dockPane) return dock.detach();
  try {
    await dock.open(ws.id, pane);
    dock.focus();
  } catch (err) {
    dockPane = null;
    drawDockTabs();
    say(String(err), true);
  }
}

function drawDockTabs() {
  $("dock-run").classList.toggle("on", dockPane === "run");
  $("dock-term").classList.toggle("on", dockPane === "terminal");
  $("dockwrap").hidden = dockPane === null;
  $("dock-toggle").textContent = dockPane === null ? "▴" : "▾";
}

$("dock-run").addEventListener("click", () => setDock("run"));
$("dock-term").addEventListener("click", () => setDock("terminal"));
$("dock-toggle").addEventListener("click", () => setDock(dockPane ?? "terminal"));
$("dock-kill").addEventListener("click", () => {
  const ws = current();
  if (ws && dockPane) {
    dock.kill(ws.id, dockPane);
    dockPane = null;
    drawDockTabs();
  }
});

/// Painel da direita. Redesenha junto com o quadro, que já é atualizado a cada
/// ferramenta que o agente usa — então o diff acompanha sozinho, sem polling.
async function drawDiff(id: string) {
  type Change = { path: string; added: number; removed: number; new_file: boolean };
  const files = await invoke<Change[]>("workspace_diff", { id });
  $("diffcount").textContent = files.length ? String(files.length) : "";

  const list = $("difflist");
  if (!files.length) {
    const none = document.createElement("div");
    none.className = "none";
    none.textContent = "worktree limpo";
    return list.replaceChildren(none);
  }
  list.replaceChildren(
    ...files.map((f) => {
      const row = document.createElement("div");
      row.className = "diffrow";
      row.title = f.path;
      row.innerHTML = `<span class="p"></span><span class="new"></span><span class="a"></span><span class="r"></span>`;
      row.children[0].textContent = f.path;
      row.children[1].textContent = f.new_file ? "novo" : "";
      row.children[2].textContent = f.added ? `+${f.added}` : "";
      row.children[3].textContent = f.removed ? `−${f.removed}` : "";
      return row;
    }),
  );
}

/* ---------- eventos do back ---------- */

listen<Board>("board", ({ payload }) => {
  state = payload;
  draw();
});

listen<{ session: string; payload: { tool_input?: { questions?: Question[] } } }>(
  "question",
  ({ payload }) => {
    const qs = payload.payload.tool_input?.questions;
    if (qs?.length) session.showQuestion(payload.session, qs);
  },
);

listen<{ id: number; session: string; payload: { tool_name?: string; tool_input?: unknown } }>(
  "permission",
  ({ payload }) => {
    session.showPermission(
      payload.id,
      payload.session,
      payload.payload.tool_name ?? "ferramenta",
      payload.payload.tool_input,
    );
  },
);

/* ---------- ações ---------- */

function launch(projectId?: string) {
  if (!state.projects.length) return hooks.addProject();
  openLauncher(state, projectId, async (draft: Draft) => {
    say("montando worktree…");
    try {
      const ws = await invoke<Workspace>("create_workspace", { ...draft, ...session.dims() });
      say("");
      openWorkspace(ws);
    } catch (err) {
      say(String(err), true);
    }
  });
}

$("new").addEventListener("click", () => launch(current()?.project));

$("resume").addEventListener("click", async () => {
  const tab = session.currentSession();
  if (!tab) return;
  say("retomando…");
  try {
    await invoke("resume_tab", { tab, ...session.dims() });
    say("");
    await session.attach(tab);
  } catch (err) {
    say(String(err), true);
  }
});

document.addEventListener("keydown", (e) => {
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.key === "n") {
    e.preventDefault();
    launch(current()?.project);
  }
  if (cmd && e.key === "t" && openWs) {
    e.preventDefault();
    newTab();
  }
  if (e.key === "Escape" && !$("veil").hidden) {
    $("veil").hidden = true;
    $("veil").replaceChildren();
  }
});

/* ---------- início ---------- */

session.initTerminal((m) => say(m, true));
dock.init($("dockterm"));
state = await invoke<Board>("load_board");
showBoard();
