import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import * as board from "./board";
import * as dock from "./dock";
import { avatar, fileIcon, icon } from "./icons";
import { openLauncher, type Draft } from "./launcher";
import * as session from "./session";
import "./style.css";
import * as viewer from "./viewer";
import { statusOf, type Board, type Question, type Status, type Workspace } from "./types";

// Navegador puro (sem Tauri): back falso, só para mexer na UI.
if (!("__TAURI_INTERNALS__" in window)) await import("./mock");

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

/* Histórico ← →: quadro e workspaces visitados, como as setas do Conductor. */
const hist: (string | null)[] = [];
let at = -1;
function visit(to: string | null) {
  if (hist[at] === to) return;
  hist.splice(at + 1);
  hist.push(to);
  at = hist.length - 1;
  drawNav();
}
function drawNav() {
  ($("back") as HTMLButtonElement).disabled = at <= 0;
  ($("fwd") as HTMLButtonElement).disabled = at >= hist.length - 1;
}
function travel(dir: -1 | 1) {
  const next = at + dir;
  if (next < 0 || next >= hist.length) return;
  at = next;
  const ws = state.workspaces.find((w) => w.id === hist[at]);
  ws ? openWorkspace(ws, false) : showBoard(false);
  drawNav();
}
$("back").addEventListener("click", () => travel(-1));
$("fwd").addEventListener("click", () => travel(1));

function showBoard(push = true) {
  if (push) visit(null);
  session.detach();
  board.setOpen((openWs = null));
  $("boardView").hidden = false;
  $("wsView").hidden = true;
  $("wsctl").hidden = true;
  $("crumb").replaceChildren(Object.assign(document.createElement("span"), { textContent: "Quadro" }));
  draw();
}

async function openWorkspace(ws: Workspace, push = true) {
  if (push) visit(ws.id);
  const first = ws.tabs.find((t) => t.id === ws.active) ?? ws.tabs[0];
  board.setOpen((openWs = ws.id));
  openDirs.clear();
  dockPane = null;
  dock.detach();
  drawDock();
  $("boardView").hidden = true;
  $("wsView").hidden = false;
  $("wsctl").hidden = false;
  // attach primeiro: é ele quem define a sessão corrente que as abas marcam.
  if (first) await session.attach(first.id);
  // Volta para onde parou: arquivo aberto continua aberto.
  files(ws.id).active ? await showFile() : showTerm();
  draw();
}

/* ---------- tela do workspace ---------- */

function drawWorkspace() {
  const ws = current();
  if (!ws) return showBoard();

  // Migalha como no Conductor: avatar do projeto › nome do workspace.
  const crumb = $("crumb");
  crumb.innerHTML = `${avatar(ws.repo_name)}<span></span><span class="sep">${icon("chevron-right", 12)}</span><span></span>`;
  crumb.children[1].textContent = ws.repo_name;
  crumb.children[3].textContent = ws.title;

  const st = statusOf(ws);
  const chip = $("wsstatus");
  chip.className = `chip s-${st}`;
  chip.innerHTML = `<i class="dot"></i>`;
  chip.append(LABEL[st]);

  // O evento `board` chega a cada ferramenta do agente; o select só é refeito
  // quando a lista muda, e o valor não é tocado enquanto ele está em foco.
  const sel = $("wscol") as HTMLSelectElement;
  const cols = state.columns.join("\n");
  if (sel.dataset.cols !== cols) {
    sel.dataset.cols = cols;
    sel.replaceChildren(
      ...state.columns.map((name) => Object.assign(document.createElement("option"), { value: name, textContent: name })),
    );
  }
  if (document.activeElement !== sel) sel.value = ws.column;

  $("offpath").textContent = ws.worktree;
  drawTabs(ws);
  drawDiff(ws.id);
  if (sidePane === "files") drawTree(ws.id);
  // O agente edita; o arquivo na tela acompanha, sem polling.
  const file = files(ws.id).active;
  if (file) viewer.show(ws.id, file);

  const tab = ws.tabs.find((t) => t.id === session.currentSession());
  // Terminal mudo confunde; a saída fica escrita na tela.
  $("offline").hidden = tab?.status !== "desligada";
}

$("wscol").addEventListener("change", () => {
  const ws = current();
  if (ws) invoke("move_workspace", { id: ws.id, column: ($("wscol") as HTMLSelectElement).value });
});

/// Abas sublinhadas: uma por conversa, depois uma por arquivo aberto, e o +
/// logo depois da última.
function drawTabs(ws: Workspace) {
  const bar = $("tabbar");
  bar.replaceChildren();
  const fs = files(ws.id);

  for (const tab of ws.tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (!fs.active && tab.id === session.currentSession() ? " on" : "");
    b.innerHTML = `<i class="dot"></i><span></span>`;
    (b.children[0] as HTMLElement).style.background = `var(--dot-${tab.status})`;
    b.children[1].textContent = tab.title;
    b.title = LABEL[tab.status];
    b.addEventListener("click", () => selectTab(ws.id, tab.id));

    if (ws.tabs.length > 1) {
      const x = document.createElement("span");
      x.className = "tabx ico sm";
      x.innerHTML = icon("x", 12);
      x.title = "Fechar conversa";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        invoke("close_tab", { workspace: ws.id, tab: tab.id });
      });
      b.append(x);
    }
    bar.append(b);
  }

  for (const path of fs.open) {
    const b = document.createElement("button");
    b.className = "tab file" + (path === fs.active ? " on" : "");
    b.innerHTML = `${icon("file", 14)}<span></span><span class="tabx ico sm">${icon("x", 12)}</span>`;
    b.children[1].textContent = path.slice(path.lastIndexOf("/") + 1);
    b.title = path;
    b.addEventListener("click", () => openFile(path));
    b.querySelector(".tabx")!.addEventListener("click", (e) => {
      e.stopPropagation();
      closeFile(path);
    });
    bar.append(b);
  }

  const add = document.createElement("button");
  add.className = "ico";
  add.innerHTML = icon("plus");
  add.title = "Conversa nova, mesmos arquivos  ⌘T";
  add.addEventListener("click", () => newTab());
  bar.append(add);
}

async function selectTab(workspace: string, tab: string) {
  invoke("focus_tab", { workspace, tab });
  showTerm();
  await session.attach(tab);
  drawWorkspace();
}

/* ---------- arquivos abertos ---------- */

/// Abas de arquivo por workspace, só em memória: fechar o app fecha os arquivos.
type Files = { open: string[]; active: string | null };
const filesOf = new Map<string, Files>();
function files(id: string): Files {
  let f = filesOf.get(id);
  if (!f) filesOf.set(id, (f = { open: [], active: null }));
  return f;
}

async function openFile(path: string) {
  const ws = current();
  if (!ws) return;
  const fs = files(ws.id);
  if (!fs.open.includes(path)) fs.open.push(path);
  fs.active = path;
  await showFile();
  drawTabs(ws);
}

async function showFile() {
  const ws = current();
  const path = ws && files(ws.id).active;
  if (!ws || !path) return showTerm();
  $("termwrap").hidden = true;
  $("viewer").hidden = false;
  await viewer.show(ws.id, path);
}

function showTerm() {
  const ws = current();
  if (ws) files(ws.id).active = null;
  $("termwrap").hidden = false;
  $("viewer").hidden = true;
}

async function closeFile(path: string) {
  const ws = current();
  if (!ws) return;
  const fs = files(ws.id);
  const at = fs.open.indexOf(path);
  if (at !== -1) fs.open.splice(at, 1);
  if (fs.active === path) {
    // Cai na vizinha; sem vizinha, volta para a conversa.
    const next = fs.open[at] ?? fs.open[at - 1];
    if (next) return openFile(next);
    const tab = session.currentSession();
    tab ? await selectTab(ws.id, tab) : showTerm();
  }
  drawTabs(ws);
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
    showTerm();
    await session.attach(tab.id);
    drawWorkspace();
  } catch (err) {
    say(String(err), true);
  }
}

/* ---------- painel da direita ---------- */

let sidePane: "files" | "diff" = "files";
let dockPane: "run" | "terminal" | null = null;
let dockOpen = true;
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
$("collapse").addEventListener("click", () => {
  openDirs.clear();
  const ws = current();
  if (ws) drawTree(ws.id);
});
$("reveal").addEventListener("click", () => {
  const ws = current();
  if (ws) invoke("reveal", { id: ws.id }).catch((e) => say(String(e), true));
});

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
    row.className = "treerow";
    row.style.paddingLeft = `${14 + depth * 20}px`;
    row.innerHTML = `<span class="tw"></span><span class="tn"></span><span class="tc"></span>`;
    // Pasta aberta troca o ícone e o chevron da ponta, que só aparece no hover.
    const glyph = (open: boolean) => {
      row.children[0].innerHTML = entry.dir ? icon(open ? "folder-open" : "folder") : fileIcon(entry.name);
      row.children[2].innerHTML = entry.dir ? icon(open ? "chevron-down" : "chevron-right", 14) : "";
    };
    glyph(false);
    row.children[1].textContent = entry.name;
    into.append(row);

    if (!entry.dir) {
      row.addEventListener("click", () => openFile(entry.path));
      continue;
    }

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
      glyph(!isOpen);
    });

    if (openDirs.has(entry.path)) {
      glyph(true);
      kids.hidden = false;
      await fillDir(id, entry.path, kids, depth + 1);
    }
  }
}

/* ---------- dock: run e terminal ---------- */

async function setDock(pane: "run" | "terminal") {
  const ws = current();
  if (!ws) return;
  const same = dockOpen && dockPane === pane;
  dockPane = same ? null : pane;
  dockOpen = true;
  drawDock();
  if (!dockPane) return dock.detach();
  try {
    await dock.open(ws.id, pane);
    dock.focus();
  } catch (err) {
    dockPane = null;
    drawDock();
    say(String(err), true);
  }
}

function drawDock() {
  $("dock").classList.toggle("closed", !dockOpen);
  $("dock-toggle").innerHTML = icon(dockOpen ? "chevron-down" : "chevron-right");
  $("dock-toggle").title = dockOpen ? "Recolher" : "Expandir";
  $("dock-run").classList.toggle("on", dockPane === "run");
  $("dock-term").classList.toggle("on", dockPane === "terminal");
  $("dockwrap").hidden = dockPane === null;
  $("dockempty").hidden = dockPane !== null;
  $("dock-kill").hidden = dockPane === null;
}

$("dock-run").addEventListener("click", () => setDock("run"));
$("dock-term").addEventListener("click", () => setDock("terminal"));
$("empty-run").addEventListener("click", () => setDock("run"));
$("empty-term").addEventListener("click", () => setDock("terminal"));
$("dock-toggle").addEventListener("click", () => {
  dockOpen = !dockOpen;
  drawDock();
});
$("dock-kill").addEventListener("click", () => {
  const ws = current();
  if (ws && dockPane) {
    dock.kill(ws.id, dockPane);
    dockPane = null;
    drawDock();
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

/* ---------- painéis laterais ---------- */

function toggleRail() {
  const hidden = document.body.classList.toggle("norail");
  $("railshow").hidden = !hidden;
  // As setas acompanham: sidebar recolhida, elas vão para o header.
  (hidden ? $("railshow") : $("railtoggle")).after($("back"), $("fwd"));
}
$("railtoggle").addEventListener("click", toggleRail);
$("railshow").addEventListener("click", toggleRail);
$("sidetoggle").addEventListener("click", () => document.body.classList.toggle("noside"));

/* ---------- eventos do back ---------- */

listen<Board>("board", ({ payload }) => {
  state = payload;
  // Workspace removido sai do histórico; duas paradas iguais seguidas viram uma.
  const alive = new Set(state.workspaces.map((w) => w.id));
  for (let i = hist.length - 1; i >= 0; i--) {
    const id = hist[i];
    if ((id !== null && !alive.has(id)) || (i > 0 && id === hist[i - 1])) {
      hist.splice(i, 1);
      if (i <= at) at--;
    }
  }
  drawNav();
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
  if (cmd && e.key === "b") {
    e.preventDefault();
    toggleRail();
  }
  const file = openWs && files(openWs).active;
  if (cmd && e.key === "w" && file) {
    e.preventDefault();
    closeFile(file);
  }
  if (cmd && (e.key === "[" || e.key === "]")) {
    e.preventDefault();
    travel(e.key === "[" ? -1 : 1);
  }
  if (e.key === "Escape" && !$("veil").hidden) {
    $("veil").hidden = true;
    $("veil").replaceChildren();
  }
});

/* ---------- início ---------- */

for (const [id, name] of [
  ["railtoggle", "panel-left"],
  ["railshow", "panel-left"],
  ["back", "arrow-left"],
  ["fwd", "arrow-right"],
  ["sidetoggle", "panel-right"],
  ["reveal", "external-link"],
  ["collapse", "list-tree"],
  ["dock-kill", "square"],
] as const) {
  $(id).innerHTML = icon(name);
}

session.initTerminal((m) => say(m, true));
viewer.init((m) => say(m, true));
dock.init($("dockterm"));
drawDock();
state = await invoke<Board>("load_board");
showBoard();
