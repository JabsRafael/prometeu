import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import * as board from "./board";
import * as diff from "./diff";
import * as dock from "./dock";
import { avatar, fileIcon, icon, stageIcon } from "./icons";
import { openLauncher, type Draft } from "./launcher";
import * as menu from "./menu";
import * as rename from "./rename";
import * as session from "./session";
import "./style.css";
import * as viewer from "./viewer";
import {
  statusOf,
  type Board,
  type Change,
  type Question,
  type Status,
  type Tab,
  type Workspace,
} from "./types";

// Navegador puro (sem Tauri): back falso, só para mexer na UI.
if (!("__TAURI_INTERNALS__" in window)) await import("./mock");

const $ = (id: string) => document.getElementById(id)!;
let state: Board = { stages: [], projects: [], workspaces: [] };
let openWs: string | null = null;

const LABEL: Record<Status, string> = {
  rodando: "rodando",
  querendo: "quer você",
  pronta: "pronta",
  desligada: "desligada",
};

/// Recado na barra de cima. Some sozinho: recado que fica vira parte do
/// cabeçalho, e daqui a uma hora você está lendo o aviso de outra coisa. Quem
/// termina em "…" é progresso e fica até quem começou apagar.
let fade = 0;
function say(text: string, isError = false) {
  $("msg").textContent = text;
  $("msg").classList.toggle("err", isError);
  clearTimeout(fade);
  if (text && !text.endsWith("…")) fade = setTimeout(() => say(""), 6000);
}

const current = () => state.workspaces.find((w) => w.id === openWs);

/* ---------- navegação ---------- */

const hooks: board.Hooks = {
  open: (ws) => openWorkspace(ws),
  setStage: (id, stage) => invoke("set_stage", { id, stage }),
  drop: (id) => {
    if (openWs === id) showBoard();
    invoke("remove_workspace", { id });
  },
  rename: (id, title) => renameWorkspace(id, title),
  // Arquivar o que está aberto na tela deixaria você dentro do que acabou de
  // sair da lista; o quadro é para onde se volta.
  archive: (id, archived) => {
    if (archived && openWs === id) showBoard();
    invoke("archive_workspace", { id, archived }).catch((e) => say(String(e), true));
  },
  pin: (id, pinned) => invoke("pin_workspace", { id, pinned }),
  unread: (id, unread) => invoke("set_unread", { id, unread }),
  reveal: (id) => invoke("reveal", { id }).catch((e) => say(String(e), true)),
  copyPath: (ws) => {
    navigator.clipboard.writeText(ws.worktree);
    say(`${ws.worktree} copiado`);
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
  // Campo de renomear ou menu aberto: o quadro é redesenhado a cada ferramenta
  // que o agente usa, e refazer a linha debaixo do que você está usando apaga o
  // que foi digitado, ou tira o menu do lugar no meio do clique.
  if (rename.editing() || menu.isOpen()) return;
  board.render(state, hooks);
  if (openWs) drawWorkspace();
}

/// Fim de um rename. Nome novo grava — e o `board` que volta do back redesenha;
/// desistência só devolve a linha ao normal.
function renameWorkspace(id: string, title: string | null) {
  draw();
  if (title) invoke("rename_workspace", { id, title }).catch((e) => say(String(e), true));
}

/// Mesmo contrato, para a aba: o nome dela nasce da primeira frase do prompt —
/// ou de um "conversa 2" quando não houve prompt — e nenhum dos dois é o assunto
/// que ela acaba tendo.
function renameTab(workspace: string, tab: string, title: string | null) {
  draw();
  if (title) invoke("rename_tab", { workspace, tab, title }).catch((e) => say(String(e), true));
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
  invoke("look_at", { id: null });
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
  // Abrir é ler: a novidade deste workspace morre aqui, e o que acontecer nele
  // enquanto ele estiver na tela não vira novidade nova.
  invoke("look_at", { id: ws.id });
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
  // Volta para onde parou: arquivo aberto continua aberto, diff continua na tela.
  const fs = files(ws.id);
  if (fs.diff) showChanges();
  else if (fs.active) await showFile();
  else showTerm();
  draw();
}

/* ---------- tela do workspace ---------- */

function drawWorkspace() {
  const ws = current();
  if (!ws) return showBoard();

  // Migalha como no Conductor: avatar do projeto › nome do workspace › branch.
  const crumb = $("crumb");
  crumb.innerHTML =
    `${avatar(ws.repo_name)}<span></span><span class="sep">${icon("chevron-right", 12)}</span><span></span>` +
    `<button class="branch" hidden>${icon("git-branch", 12)}<span></span></button>`;
  crumb.children[1].textContent = ws.repo_name;
  const name = crumb.children[3] as HTMLElement;
  name.textContent = ws.title;
  // Na migalha não tem lápis: nada ali é clicável, então o duplo clique é livre.
  name.title = "Duplo clique para renomear";
  name.addEventListener("dblclick", () =>
    rename.start(name, ws.title, (title) => renameWorkspace(ws.id, title), "crumb"),
  );

  const st = statusOf(ws);
  const chip = $("wsstatus");
  chip.className = `chip s-${st}`;
  chip.innerHTML = `<i class="dot"></i>`;
  chip.append(LABEL[st]);

  // A etapa é o mesmo submenu do botão direito, ancorado no botão: um lugar só
  // para escolher, esteja você no quadro ou dentro da conversa.
  const stage = $("wsstage");
  stage.innerHTML = `${stageIcon(state.stages.indexOf(ws.stage), state.stages.length, 14)}<span></span>`;
  stage.children[1].textContent = ws.stage;
  stage.onclick = () => {
    const at = stage.getBoundingClientRect();
    menu.openAt(
      { x: at.left, y: at.bottom + 4 },
      state.stages.map((name, i) => ({
        label: name,
        glyph: stageIcon(i, state.stages.length),
        checked: name === ws.stage,
        run: () => hooks.setStage(ws.id, name),
      })),
    );
  };

  $("offpath").textContent = ws.worktree;
  drawBranch(ws);
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

/* ---------- branch do worktree ---------- */

/// Em que branch o worktree está agora — lido do git, e não do `ws.branch` que
/// ficou gravado quando o workspace nasceu: o agente comita, troca de branch,
/// rebaseia, e o que a migalha tem que dizer é onde o próximo commit cai.
/// O cache é o que impede a pastilha de piscar entre dois redesenhos, que são
/// muitos — a tela é refeita a cada ferramenta que o agente usa.
const branchOf = new Map<string, string>();

function paintBranch(id: string) {
  const chip = $("crumb").querySelector<HTMLElement>(".branch");
  const name = branchOf.get(id);
  if (!chip || !name) return;
  chip.hidden = false;
  chip.children[1].textContent = name;
  chip.title = "Branch deste worktree — clique para copiar";
  chip.onclick = () => {
    navigator.clipboard.writeText(name);
    say(`${name} copiado`);
  };
}

async function drawBranch(ws: Workspace) {
  paintBranch(ws.id);
  // Nome vazio é HEAD solto, e dizer isso é melhor do que não dizer nada: um
  // worktree em detached HEAD é justamente onde um commit se perde.
  const name = (await invoke<string | null>("workspace_branch", { id: ws.id })) ?? "HEAD solto";
  branchOf.set(ws.id, name);
  if (openWs === ws.id) paintBranch(ws.id);
}

/// Abas sublinhadas: uma por conversa, a de Mudanças, depois uma por arquivo
/// aberto, e o + logo depois da última.
function drawTabs(ws: Workspace) {
  // Refazer a barra com um campo de renomear aberto nela apaga o que foi
  // digitado — e o diff, que redesenha sozinho, chega aqui a toda hora.
  if (rename.editing()) return;
  const bar = $("tabbar");
  bar.replaceChildren();
  const fs = files(ws.id);
  const elsewhere = fs.diff || fs.active;

  for (const tab of ws.tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (!elsewhere && tab.id === session.currentSession() ? " on" : "");
    b.innerHTML = `<i class="dot"></i><span></span>`;
    (b.children[0] as HTMLElement).style.background = `var(--dot-${tab.status})`;
    b.dataset.tab = tab.id;
    b.children[1].textContent = tab.title;
    b.title = `${LABEL[tab.status]} · duplo clique para renomear`;
    b.addEventListener("click", () => selectTab(ws.id, tab.id));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu.openAt({ x: e.clientX, y: e.clientY }, tabMenu(ws, tab));
    });

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

  // A aba de Mudanças existe enquanto houver o que mostrar e você não a tiver
  // fechado — ou enquanto ela estiver aberta, para o worktree ficar limpo sem a
  // tela sumir debaixo de você.
  const changes = changesOf.get(ws.id) ?? [];
  if (fs.diff || (changes.length && !fs.hidDiff)) {
    const b = document.createElement("button");
    b.className = "tab file" + (fs.diff ? " on" : "");
    b.innerHTML = `${icon("diff", 14)}<span></span><span class="n"></span>`;
    b.children[1].textContent = "Mudanças";
    b.children[2].textContent = changes.length ? String(changes.length) : "";
    b.title = "Diff do worktree inteiro";
    b.addEventListener("click", () => showChanges());
    const x = document.createElement("span");
    x.className = "tabx ico sm";
    x.innerHTML = icon("x", 12);
    x.title = fs.diff ? "Fechar Mudanças  ⌘W" : "Fechar Mudanças";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeChanges();
    });
    b.append(x);
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

/// Abre o campo no rótulo da aba que está na barra agora. Procurar o botão na
/// hora, em vez de guardar o de quando o gesto começou, é o que faz o renomear
/// sobreviver ao redesenho que a troca de aba dispara no caminho.
function editTab(id: string) {
  const ws = current();
  const tab = ws?.tabs.find((t) => t.id === id);
  const b = $("tabbar").querySelector<HTMLElement>(`.tab[data-tab="${CSS.escape(id)}"]`);
  if (!ws || !tab || !b) return;
  rename.start(b.children[1] as HTMLElement, tab.title, (title) => renameTab(ws.id, id, title), "tab");
}

// Duplo clique renomeia, como no nome do workspace na migalha. Escuta na barra e
// não no botão: o primeiro clique troca de aba, a troca refaz a barra, e o botão
// em que o gesto começou já não existe quando o duplo clique chega.
$("tabbar").addEventListener("dblclick", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>(".tab[data-tab]");
  if (b?.dataset.tab) editTab(b.dataset.tab);
});

/// Tudo que se faz com uma conversa, no botão direito — o mesmo lugar em que
/// moram as ações do workspace, em vez de um botãozinho por ação na aba.
function tabMenu(ws: Workspace, tab: Tab): menu.Item[] {
  const items: menu.Item[] = [
    { label: "Renomear", glyph: icon("pencil"), run: () => editTab(tab.id) },
  ];
  // A última conversa não fecha: um workspace sem conversa nenhuma é uma tela
  // vazia sem nada para clicar.
  if (ws.tabs.length > 1) {
    items.push("sep", {
      label: "Fechar conversa",
      glyph: icon("x"),
      danger: true,
      run: () => invoke("close_tab", { workspace: ws.id, tab: tab.id }),
    });
  }
  return items;
}

async function selectTab(workspace: string, tab: string) {
  const fs = files(workspace);
  // Clicar na aba em que você já está não refaz nada. É o que deixa o duplo
  // clique chegar inteiro no renomear: o rótulo continua sendo o mesmo nó.
  if (tab === session.currentSession() && !fs.diff && !fs.active) return;
  invoke("focus_tab", { workspace, tab });
  showTerm();
  await session.attach(tab);
  drawWorkspace();
}

/* ---------- arquivos abertos ---------- */

/// O que está no centro de cada workspace, só em memória: fechar o app volta
/// tudo para a conversa. `diff` ligado é a tela de mudanças; `active` é o
/// arquivo aberto; nenhum dos dois é o terminal.
type Files = {
  open: string[];
  active: string | null;
  diff: boolean;
  /// Você fechou a aba de Mudanças. Sem isto ela renasceria no redesenho
  /// seguinte, porque o worktree continua sujo — e aí fechar não fecharia nada.
  hidDiff: boolean;
};
const filesOf = new Map<string, Files>();
function files(id: string): Files {
  let f = filesOf.get(id);
  if (!f) filesOf.set(id, (f = { open: [], active: null, diff: false, hidDiff: false }));
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
  files(ws.id).diff = false;
  center("viewer");
  await viewer.show(ws.id, path);
}

function showTerm() {
  const ws = current();
  if (ws) {
    files(ws.id).active = null;
    files(ws.id).diff = false;
  }
  center("termwrap");
}

/// Tela de mudanças. `focus` vem do clique na lista da direita: é a mesma tela,
/// só rolada até aquele arquivo.
function showChanges(focus?: string) {
  const ws = current();
  if (!ws) return;
  const fs = files(ws.id);
  fs.active = null;
  fs.diff = true;
  fs.hidDiff = false;
  center("diffview");
  drawChanges(ws.id, focus);
  drawTabs(ws);
}

/// Fechar a aba de Mudanças é tirá-la da barra, não só sair da tela: uma aba que
/// fica depois do x não foi fechada. Ela volta quando você abre o diff de novo
/// pela lista da direita, ou quando o worktree limpa e suja outra vez — o que é
/// trabalho novo, e não o que você mandou embora.
async function closeChanges() {
  const ws = current();
  if (!ws) return;
  const fs = files(ws.id);
  const wasOpen = fs.diff;
  fs.hidDiff = true;
  // `diff` fica ligado até o `showTerm` da vez desligar: é ele que faz o
  // `selectTab` entender que a tela precisa trocar.
  if (wasOpen) {
    const tab = session.currentSession();
    if (tab) await selectTab(ws.id, tab);
    else showTerm();
  }
  drawTabs(ws);
}

function center(show: "termwrap" | "viewer" | "diffview") {
  for (const id of ["termwrap", "viewer", "diffview"] as const) $(id).hidden = id !== show;
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
$("tab-diff").addEventListener("click", () => {
  // Já no painel de Mudanças, clicar de novo traz o diff para o centro. É o
  // caminho de volta depois de fechar a aba — sem ele, quem fechou só voltaria
  // clicando num arquivo da lista.
  const changes = openWs ? (changesOf.get(openWs)?.length ?? 0) : 0;
  if (sidePane === "diff" && changes) showChanges();
  else setSidePane("diff");
});
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
const changesOf = new Map<string, Change[]>();

async function drawDiff(id: string) {
  const changes = await invoke<Change[]>("workspace_diff", { id });
  changesOf.set(id, changes);
  $("diffcount").textContent = changes.length ? String(changes.length) : "";
  // Worktree limpo esquece que a aba foi fechada: o que sujar depois é trabalho
  // novo, e não o diff que você mandou embora.
  if (!changes.length) files(id).hidDiff = false;

  const list = $("difflist");
  if (!changes.length) {
    const none = document.createElement("div");
    none.className = "none";
    none.textContent = "worktree limpo";
    list.replaceChildren(none);
  } else {
    list.replaceChildren(
      ...changes.map((f) => {
        // A lista é o índice da tela do centro: clicar rola até o arquivo.
        const row = document.createElement("button");
        row.className = "diffrow";
        row.title = f.path;
        row.innerHTML = `<span class="p"></span><span class="new"></span><span class="a"></span><span class="r"></span>`;
        row.children[0].textContent = f.path;
        row.children[1].textContent = f.new_file ? "novo" : "";
        row.children[2].textContent = f.added ? `+${f.added}` : "";
        row.children[3].textContent = f.removed ? `−${f.removed}` : "";
        row.addEventListener("click", () => showChanges(f.path));
        return row;
      }),
    );
  }

  const ws = current();
  if (ws?.id !== id) return;
  drawTabs(ws); // a aba de Mudanças aparece, some e conta junto com a lista
  if (files(id).diff) drawChanges(id);
}

/// Resumo na barra e o diff empilhado embaixo. Redesenhar é barato: a tela só é
/// refeita quando algum patch mudou de verdade.
function drawChanges(id: string, focus?: string) {
  const changes = changesOf.get(id) ?? [];
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);

  const crumb = $("dcrumb");
  crumb.innerHTML = `${icon("diff", 14)}<span class="nm"></span><span class="a"></span><span class="r"></span>`;
  crumb.children[1].textContent = `${changes.length} ${changes.length === 1 ? "arquivo" : "arquivos"}`;
  crumb.children[2].textContent = added ? `+${added}` : "";
  crumb.children[3].textContent = removed ? `−${removed}` : "";

  diff.render($("dlist"), id, changes, focus);
}

$("dfold").addEventListener("click", () => {
  const ws = current();
  if (!ws) return;
  diff.foldAll((changesOf.get(ws.id) ?? []).map((c) => c.path));
  drawChanges(ws.id);
});

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

/* ---------- arrastar arquivo para dentro do terminal ---------- */

/// O Tauri come os eventos de drag do HTML para entregar caminho de arquivo de
/// verdade, então quem escuta é a webview, não o documento. Soltar escreve o
/// caminho no pty — é o que o Terminal do macOS faz, e é assim que uma imagem
/// chega no Claude Code.
type Drag = { type: string; paths?: string[]; position?: { x: number; y: number } };

/// Caminho vai escapado como o Terminal escapa ao soltar um arquivo: barra
/// invertida em tudo que o shell leria como outra coisa.
const escapePath = (p: string) => p.replace(/([\s!"#$&'()*,:;<>?[\\\]^`{|}~])/g, "\\$1");

/// Onde o arquivo caiu: o terminal da conversa, o do dock, ou lugar nenhum.
function dropTarget(at?: { x: number; y: number }) {
  if (!at || !$("veil").hidden) return null;
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(at.x / dpr, at.y / dpr);
  if (!el) return null;
  if (el.closest("#dock")) return { host: $("dock"), pty: dock.currentKey(), focus: dock.focus };
  if (el.closest("#termwrap")) return { host: $("termwrap"), pty: session.currentSession(), focus: session.focus };
  return null;
}

let dropHost: HTMLElement | null = null;
function markDrop(host: HTMLElement | null) {
  if (dropHost === host) return;
  dropHost?.classList.remove("dropping");
  dropHost = host;
  dropHost?.classList.add("dropping");
}

getCurrentWebview().onDragDropEvent(({ payload }) => {
  const drag = payload as Drag;
  if (drag.type === "leave") return markDrop(null);

  const target = dropTarget(drag.position);
  if (drag.type !== "drop") return markDrop(target?.pty ? target.host : null);

  markDrop(null);
  const paths = drag.paths ?? [];
  if (!target?.pty || !paths.length) return;
  // Espaço no fim: o próximo arquivo, ou o que você for escrever, não cola.
  invoke("pty_write", { session: target.pty, data: paths.map(escapePath).join(" ") + " " })
    .then(() => target.focus())
    .catch((e) => say(String(e), true));
});

/* ---------- ações ---------- */

function launch(projectId?: string) {
  if (!state.projects.length) return hooks.addProject();
  openLauncher(state, projectId, async (draft: Draft) => {
    say("montando worktree…");
    try {
      const ws = await invoke<Workspace>("create_workspace", { draft, ...session.dims() });
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
    // Conversa vazia não tem transcript: o back abre uma nova no mesmo lugar, e
    // dizer isso é melhor do que deixar você procurar o histórico que não existe.
    const resumed = await invoke<boolean>("resume_tab", { tab, ...session.dims() });
    say(resumed ? "" : "essa conversa nunca chegou a falar — abrimos uma nova no mesmo lugar");
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
  if (cmd && e.shiftKey && e.key.toLowerCase() === "a" && openWs) {
    e.preventDefault();
    hooks.archive(openWs, true);
  }
  if (cmd && e.key === "b") {
    e.preventDefault();
    toggleRail();
  }
  const fs = openWs ? files(openWs) : null;
  if (cmd && e.key === "w" && fs?.active) {
    e.preventDefault();
    closeFile(fs.active);
  } else if (cmd && e.key === "w" && fs?.diff) {
    e.preventDefault();
    closeChanges();
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
  ["dfold", "chevron-up"],
] as const) {
  $(id).innerHTML = icon(name);
}

session.initTerminal((m) => say(m, true));
viewer.init((m) => say(m, true));
dock.init($("dockterm"));
drawDock();
state = await invoke<Board>("load_board");
showBoard();
