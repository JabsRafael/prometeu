import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import * as board from "./board";
import * as dock from "./dock";
import * as dockbar from "./dockbar";
import { icon } from "./icons";
import { current, fromBack, paint, t } from "./i18n";
import * as issues from "./issues";
import { dropFiles, openLauncher, type Draft } from "./launcher";
import * as menu from "./menu";
import * as rename from "./rename";
import * as session from "./session";
import * as settings from "./settings";
import "./style.css";
import type { Board, Issue, Question, Workspace } from "./types";
import * as update from "./update";
import { $ } from "./util";
import * as viewer from "./viewer";
import * as ws from "./workspace";

// Navegador puro (sem Tauri): back falso, só para mexer na UI.
if (!("__TAURI_INTERNALS__" in window)) await import("./mock");

let state: Board = { stages: [], projects: [], workspaces: [] };

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

/* ---------- navegação ---------- */

const hooks: board.Hooks = {
  open: (w) => openWorkspace(w),
  setStage: ws.setStage,
  drop: (id) => {
    if (ws.id() === id) showBoard();
    invoke("remove_workspace", { id });
  },
  rename: ws.renameWorkspace,
  // Arquivar o que está aberto na tela deixaria você dentro do que acabou de
  // sair da lista; o quadro é para onde se volta.
  archive: (id, archived) => {
    if (archived && ws.id() === id) showBoard();
    invoke("archive_workspace", { id, archived }).catch((e) => say(fromBack(e), true));
  },
  pin: (id, pinned) => invoke("pin_workspace", { id, pinned }),
  unread: (id, unread) => invoke("set_unread", { id, unread }),
  reveal: (id) => invoke("reveal", { id }).catch((e) => say(fromBack(e), true)),
  copyPath: (w) => {
    navigator.clipboard.writeText(w.worktree);
    say(t("say.copied", { path: w.worktree }));
  },
  toBoard: () => showBoard(),
  toIssues: () => showIssues(),
  issues: () => issues.count(),
  openIssue: (url) => invoke("linear_open", { url }).catch((e) => say(fromBack(e), true)),
  addProject: async () => {
    const dir = await open({ directory: true, title: t("say.pickRepo") });
    if (typeof dir !== "string") return;
    invoke("add_project", { path: dir }).catch((e) => say(fromBack(e), true));
  },
  newWorkspace: (projectId) => launch(projectId),
};

function draw() {
  // Campo de renomear, menu aberto ou card sendo arrastado: o quadro é
  // redesenhado a cada ferramenta que o agente usa, e refazer a linha debaixo
  // do que você está usando apaga o que foi digitado, tira o menu do lugar no
  // meio do clique, ou some com o card de debaixo do mouse.
  if (rename.editing() || menu.isOpen() || board.dragging()) return;
  board.render(state, hooks);
  if (ws.id()) ws.draw();
}

/* Histórico ← →: quadro, configurações e workspaces visitados, como as setas
   do Conductor. `null` é o quadro; `SETTINGS` é a tela de configurações, que
   não colide com id de workspace nenhum. */
const SETTINGS = "@configurações";
const ISSUES = board.ISSUES;
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
  if (hist[at] === SETTINGS) {
    showSettings(false);
  } else if (hist[at] === ISSUES) {
    showIssues(false);
  } else {
    const target = state.workspaces.find((w) => w.id === hist[at]);
    target ? openWorkspace(target, false) : showBoard(false);
  }
  drawNav();
}
$("back").addEventListener("click", () => travel(-1));
$("fwd").addEventListener("click", () => travel(1));

/// As telas que não são workspace nem quadro: uma de cada vez, e o quadro
/// fica escondido embaixo delas.
function showOnly(view: "settingsView" | "issuesView" | null) {
  $("boardView").hidden = view !== null;
  $("settingsView").hidden = view !== "settingsView";
  $("issuesView").hidden = view !== "issuesView";
  if (view !== "issuesView") issues.hide();
}

function showBoard(push = true) {
  if (push) visit(null);
  ws.leave();
  showOnly(null);
  $("crumb").replaceChildren(crumbLabel(t("crumb.board")));
  draw();
}

/// A migalha das telas que não são um workspace: uma palavra só, e é o nome da
/// tela — a do workspace é montada pelo `ws.draw`.
const crumbLabel = (text: string) =>
  Object.assign(document.createElement("span"), { textContent: text });

async function openWorkspace(target: Workspace, push = true) {
  if (push) visit(target.id);
  showOnly(null);
  await ws.open(target);
}

/// As issues do Linear no seu nome — de onde o trabalho sai.
function showIssues(push = true) {
  if (push) visit(ISSUES);
  ws.leave();
  board.setOpen(ISSUES);
  showOnly("issuesView");
  $("crumb").replaceChildren(crumbLabel(t("crumb.issues")));
  issues.show();
  draw();
}

/// A terceira tela. Sai do workspace como o quadro sai, mas o quadro fica
/// escondido embaixo — e nenhum item da barra acende, porque nenhum é ela.
function showSettings(push = true) {
  if (push) visit(SETTINGS);
  ws.leave();
  board.setOpen(SETTINGS);
  showOnly("settingsView");
  $("crumb").replaceChildren(crumbLabel(t("crumb.settings")));
  settings.draw();
  draw();
}
$("settings").addEventListener("click", () => showSettings());

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
  ws.forget(alive);
  drawNav();
  draw();
});

/// Script que morreu sozinho — terminou, ou quebrou. A aba volta para o botão
/// de começar sem ninguém perguntar de tempos em tempos.
listen<[string, number | null]>("pty-closed", ({ payload: [key] }) => dockbar.closed(key));

listen<{ session: string; payload: { tool_input?: { questions?: Question[] } } }>(
  "question",
  ({ payload }) => {
    const qs = payload.payload.tool_input?.questions;
    if (qs?.length) session.showQuestion(payload.session, qs);
  },
);

listen<{ session: string; plan?: string }>("plan", ({ payload }) => {
  session.showPlan(payload.session, payload.plan ?? "");
});

listen<{ id: number; session: string; payload: { tool_name?: string; tool_input?: unknown } }>(
  "permission",
  ({ payload }) => {
    session.showPermission(
      payload.id,
      payload.session,
      payload.payload.tool_name ?? t("ask.tool"),
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

  // Lançador aberto: o arquivo vira anexo da primeira fala, e nada vai ao pty.
  if (!$("veil").hidden) {
    markDrop(null);
    if (drag.type === "drop") dropFiles(drag.paths ?? []);
    return;
  }

  const target = dropTarget(drag.position);
  if (drag.type !== "drop") return markDrop(target?.pty ? target.host : null);

  markDrop(null);
  const paths = drag.paths ?? [];
  if (!target?.pty || !paths.length) return;
  // Espaço no fim: o próximo arquivo, ou o que você for escrever, não cola.
  invoke("pty_write", { session: target.pty, data: paths.map(escapePath).join(" ") + " " })
    .then(() => target.focus())
    .catch((e) => say(fromBack(e), true));
});

/* ---------- ações ---------- */

function launch(projectId?: string, seed?: Issue) {
  if (!state.projects.length) return hooks.addProject();
  openLauncher(state, {
    preset: projectId,
    seed,
    toSettings: () => showSettings(),
    go: async (draft: Draft) => {
      say(t("say.creating"));
      try {
        const created = await invoke<Workspace>("create_workspace", { draft, ...session.dims() });
        say("");
        openWorkspace(created);
      } catch (err) {
        say(fromBack(err), true);
      }
    },
  });
}

$("resume").addEventListener("click", async () => {
  const tab = session.currentSession();
  if (!tab) return;
  say(t("say.resuming"));
  try {
    // Conversa vazia não tem transcript: o back abre uma nova no mesmo lugar, e
    // dizer isso é melhor do que deixar você procurar o histórico que não existe.
    const resumed = await invoke<boolean>("resume_tab", { tab, ...session.dims() });
    say(resumed ? "" : t("say.resumed"));
    await session.attach(tab);
  } catch (err) {
    say(fromBack(err), true);
  }
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

/* A borda esquerda do painel da direita é uma alça: arrastar muda a largura, e
   ela fica para as próximas aberturas; duplo clique volta ao padrão do CSS. O
   clamp segura o painel entre o mínimo útil e não engolir o centro. Os
   terminais se remedem sozinhos — cada um tem um ResizeObserver no host. */
const SIDE_W = "side-w";
let sideW = Number(localStorage.getItem(SIDE_W)) || 0;
const clampSide = (w: number) => Math.round(Math.max(280, Math.min(w, window.innerWidth * 0.6)));
function paintSide() {
  if (sideW) document.documentElement.style.setProperty("--side-w", `${sideW}px`);
  else document.documentElement.style.removeProperty("--side-w");
}
paintSide();
const grip = $("sideresize");
grip.addEventListener("pointerdown", (e) => {
  grip.setPointerCapture(e.pointerId);
  grip.classList.add("dragging");
});
grip.addEventListener("pointermove", (e) => {
  if (!grip.hasPointerCapture(e.pointerId)) return;
  sideW = clampSide(window.innerWidth - e.clientX);
  paintSide();
});
// O fim do gesto é a perda da captura — soltar o botão, ou o sistema cancelar
// o ponteiro no meio. Um caminho só para os dois finais.
grip.addEventListener("lostpointercapture", () => {
  grip.classList.remove("dragging");
  if (sideW) localStorage.setItem(SIDE_W, String(sideW));
});
grip.addEventListener("dblclick", () => {
  sideW = 0;
  paintSide();
  localStorage.removeItem(SIDE_W);
});

document.addEventListener("keydown", (e) => {
  const cmd = e.metaKey || e.ctrlKey;
  const open = ws.id();
  if (cmd && e.key === "n") {
    e.preventDefault();
    launch(state.workspaces.find((w) => w.id === open)?.project);
  }
  if (cmd && e.key === "t" && open) {
    e.preventDefault();
    ws.newTab();
  }
  if (cmd && e.shiftKey && e.key.toLowerCase() === "a" && open) {
    e.preventDefault();
    hooks.archive(open, true);
  }
  if (cmd && e.key === "r" && open) {
    e.preventDefault();
    dockbar.toggleRun();
  }
  if (cmd && e.key === "b") {
    e.preventDefault();
    toggleRail();
  }
  // ⌘, é onde todo app do Mac guarda as preferências.
  if (cmd && e.key === ",") {
    e.preventDefault();
    showSettings();
  }
  // O dock tem a primeira palavra: ⌘W com o cursor dentro dele fecha o terminal
  // que está ali, e não a aba do centro, que é o que ele fecharia por baixo.
  if (cmd && e.key === "w" && (dockbar.closeFocused() || ws.closeActive())) e.preventDefault();
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

// Os rótulos que estão escritos no `index.html`, no idioma da vez. Antes de
// qualquer desenho: o resto da tela nasce já traduzido, e o que está no HTML
// não pode ser a única coisa em português.
paint();
// O back escreve pouca coisa por inteiro — a linha de saída do dock, o aviso
// que entra na fala do agente, a página do fim do OAuth —, mas essa pouca
// coisa precisa saber em que idioma a tela está.
invoke("set_lang", { lang: current() });

for (const [id, name] of [
  ["railtoggle", "panel-left"],
  ["railshow", "panel-left"],
  ["back", "arrow-left"],
  ["fwd", "arrow-right"],
  ["sidetoggle", "panel-right"],
  ["reveal", "external-link"],
  ["collapse", "list-tree"],
  ["dock-again", "rotate"],
  ["run-pick", "chevron-down"],
  ["dfold", "chevron-up"],
  ["settings", "settings"],
] as const) {
  $(id).innerHTML = icon(name);
}

void update.init(say);
// A tela de issues pergunta às configurações se há Linear; elas respondem
// depois de saber, e por isso vêm antes.
await settings.init({ say });
issues.init({
  say,
  board: () => state,
  redraw: draw,
  open: (w) => openWorkspace(w),
  create: (issue) => launch(state.workspaces.find((w) => w.id === ws.id())?.project, issue),
  toSettings: () => showSettings(),
});
ws.init({ say, board: () => state, redraw: draw, toBoard: () => showBoard() });
session.initTerminal((m) => say(m, true));
viewer.init((m) => say(m, true));
dock.init($("dockterm"));
state = await invoke<Board>("load_board");
showBoard();
