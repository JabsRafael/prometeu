import { invoke } from "./ipc";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import * as alert from "./alert";
import * as appmenu from "./appmenu";
import * as archived from "./archived";
import * as sidebar from "./sidebar";
import { openCleanup } from "./cleanup";
import { openInbox } from "./inbox";
import * as dock from "./dock";
import * as dockbar from "./dockbar";
import { icon } from "./icons";
import * as links from "./links";
import { current, fromBack, paint, t } from "./i18n";
import * as issues from "./issues";
import * as mcp from "./mcp";
import * as plugins from "./plugins";
import { dropFiles, installed, loadAgents, openLauncher, type Draft } from "./launcher";
import * as menu from "./menu";
import * as news from "./news";
import * as rename from "./rename";
import * as session from "./session";
import * as settings from "./settings";
import * as statusbar from "./statusbar";
import * as team from "./team";
import "./style.css";
import type { Board, Issue, Workspace } from "./types";
import * as update from "./update";
import { $ } from "./util";
import * as viewer from "./viewer";
import * as ws from "./workspace";

// Navegador puro (sem Tauri): back falso, só para mexer na UI.
if (!("__TAURI_INTERNALS__" in window)) await import("./mock");

let state: Board = { stages: [], projects: [], workspaces: [] };

/// O estado como a tela o vê: o do Rust mais os workspaces que os colegas
/// compartilharam, que só existem aqui. Quem desenha e quem procura um
/// workspace por id olha para este; o que fala com o back olha para `state`.
const view = (): Board => {
  const remotes = team.remotes();
  return remotes.length ? { ...state, workspaces: [...state.workspaces, ...remotes] } : state;
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

/* ---------- navegação ---------- */

const hooks: sidebar.Hooks = {
  open: (w) => openWorkspace(w),
  setStage: ws.setStage,
  drop: (id) => {
    if (ws.id() === id) showIssues();
    invoke("remove_workspace", { id });
  },
  rename: ws.renameWorkspace,
  // Arquivar o que está aberto na tela deixaria você dentro do que acabou de
  // sair da lista; Issues é a tela inicial para onde se volta.
  archive: (id, archived) => {
    if (archived && ws.id() === id) showIssues();
    invoke("archive_workspace", { id, archived }).catch((e) => say(fromBack(e), true));
  },
  finish: (id) => ws.finish(id),
  cleanup: () => openCleanup(say),
  inbox: () =>
    openInbox((workspace, note) => {
      const target = view().workspaces.find((w) => w.id === workspace);
      if (!target) return say(t("err.team.noShare"), true);
      void openWorkspace(target).then(() => ws.showNote(note));
    }),
  pin: (id, pinned) => invoke("pin_workspace", { id, pinned }),
  unread: (id, unread) => invoke("set_unread", { id, unread }),
  reveal: (id) => invoke("reveal", { id }).catch((e) => say(fromBack(e), true)),
  copyPath: (w) => {
    navigator.clipboard.writeText(w.worktree);
    say(t("say.copied", { path: w.worktree }));
  },
  toIssues: () => showIssues(),
  toArchived: () => showArchived(),
  issues: () => issues.count(),
  addProject: async () => {
    const dir = await open({ directory: true, title: t("say.pickRepo") });
    if (typeof dir !== "string") return;
    invoke("add_project", { path: dir }).catch((e) => say(fromBack(e), true));
  },
  newWorkspace: (projectId) => launch(projectId),
};

/// Quadro que chegou enquanto o menu estava aberto e não foi desenhado. Sem
/// isto, marcar um plugin no seletor da conversa não mudava nada na tela — o
/// rodapé continuava dizendo o de antes até o próximo evento do back, que numa
/// conversa parada podia não vir nunca.
let missed = false;

function draw() {
  // A barra é redesenhada a cada ferramenta que o agente usa. Refazer a linha
  // com um campo de renomear ou menu aberto apaga o texto ou tira o menu do
  // lugar no meio do clique.
  if (rename.editing() || menu.isOpen()) {
    missed = true;
    return;
  }
  missed = false;
  sidebar.render(view(), hooks);
  archived.draw();
  if (ws.id()) ws.draw();
}

menu.onClose(() => missed && draw());

/* Histórico ← →: telas e workspaces visitados, como as setas do Conductor. Os
   ids das telas não colidem com id de workspace nenhum. */
const SETTINGS = "@configurações";
const ISSUES = sidebar.ISSUES;
const ARCHIVED = sidebar.ARCHIVED;
const pages = new Set([SETTINGS, ISSUES, ARCHIVED]);
const hist: string[] = [];
let at = -1;
function visit(to: string) {
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
  } else if (hist[at] === ARCHIVED) {
    showArchived(false);
  } else {
    const target = view().workspaces.find((w) => w.id === hist[at]);
    target ? openWorkspace(target, false) : showIssues(false);
  }
  drawNav();
}
$("back").addEventListener("click", () => travel(-1));
$("fwd").addEventListener("click", () => travel(1));

/// As telas que não são workspace: uma de cada vez.
function showOnly(view: "settingsView" | "issuesView" | "archivedView" | null) {
  $("settingsView").hidden = view !== "settingsView";
  $("issuesView").hidden = view !== "issuesView";
  $("archivedView").hidden = view !== "archivedView";
  if (view !== "issuesView") issues.hide();
  if (view !== "archivedView") archived.hide();
}

/// A migalha das telas que não são um workspace: uma palavra só, e é o nome da
/// tela — a do workspace é montada pelo `ws.draw`.
const crumbLabel = (text: string) =>
  Object.assign(document.createElement("span"), { textContent: text });

async function openWorkspace(target: Workspace, push = true) {
  if (push) visit(target.id);
  showOnly(null);
  await ws.open(target);
  alert.looked();
}

/// As issues do Linear no seu nome — de onde o trabalho sai.
function showIssues(push = true) {
  if (push) visit(ISSUES);
  ws.leave();
  sidebar.setOpen(ISSUES);
  showOnly("issuesView");
  $("crumb").replaceChildren(crumbLabel(t("crumb.issues")));
  issues.show();
  draw();
}

/// Os arquivados: o que saiu da frente, com busca, e de onde se devolve o
/// disco.
function showArchived(push = true) {
  if (push) visit(ARCHIVED);
  ws.leave();
  sidebar.setOpen(ARCHIVED);
  showOnly("archivedView");
  $("crumb").replaceChildren(crumbLabel(t("crumb.archived")));
  archived.show();
  draw();
}

/// Configurações não acende nenhum item da barra lateral.
function showSettings(push = true) {
  if (push) visit(SETTINGS);
  ws.leave();
  sidebar.setOpen(SETTINGS);
  showOnly("settingsView");
  $("crumb").replaceChildren(crumbLabel(t("crumb.settings")));
  settings.draw();
  draw();
}
$("settings").addEventListener("click", () => showSettings());

/* ---------- eventos do back ---------- */

listen<Board>("board", ({ payload }) => {
  state = payload;
  team.boardChanged(state);
  alert.boardChanged(state);
  refresh();
});

/// Os workspaces mudaram — os do Rust ou os que os colegas compartilham. O histórico
/// perde o que sumiu, e a tela é refeita.
function refresh() {
  // Workspace removido sai do histórico; duas paradas iguais seguidas viram uma.
  const alive = new Set(view().workspaces.map((w) => w.id));
  for (let i = hist.length - 1; i >= 0; i--) {
    const id = hist[i];
    if ((!pages.has(id) && !alive.has(id)) || (i > 0 && id === hist[i - 1])) {
      hist.splice(i, 1);
      if (i <= at) at--;
    }
  }
  ws.forget(alive);
  session.forget(new Set(view().workspaces.flatMap((w) => w.tabs.map((t) => t.id))));
  // Só o quadro local decide se este Mac fica acordado. Um agente trabalhando
  // num workspace compartilhado está rodando no Mac de outra pessoa.
  statusbar.boardChanged(state);
  drawNav();
  draw();
}
team.onChange(refresh);
team.onChange(alert.teamChanged);
alert.init({ looking: ws.id });

/// Script que morreu sozinho — terminou, ou quebrou. A aba volta para o botão
/// de começar sem ninguém perguntar de tempos em tempos.
listen<[string, number | null]>("pty-closed", ({ payload: [key] }) => dockbar.closed(key));

/// A cota mudou: alguma aba, de qualquer workspace, acabou de falar com um
/// agente. É a conta inteira, então a faixa de baixo se refaz sozinha.
listen<statusbar.Usage>("usage", ({ payload }) => statusbar.showUsage(payload));
invoke<statusbar.Usage>("usage").then(statusbar.showUsage).catch(() => {});

/// O que o app está custando à máquina, de três em três segundos. Só chega
/// quando muda: o quieto não redesenha nada.
listen<statusbar.Machine>("machine", ({ payload }) => statusbar.showMachine(payload));
statusbar.init({ say });
invoke<statusbar.Machine>("machine").then(statusbar.showMachine).catch(() => {});

/* ---------- arrastar arquivo para dentro da conversa ou do terminal ------ */

/// O Tauri come os eventos de drag do HTML para entregar caminho de arquivo de
/// verdade, então quem escuta é a webview, não o documento. Na conversa o
/// arquivo vira anexo da fala; no dock, o caminho ainda entra no pty como no
/// Terminal do macOS.
type Drag = { type: string; paths?: string[]; position?: { x: number; y: number } };

/// Caminho vai escapado como o Terminal escapa ao soltar um arquivo: barra
/// invertida em tudo que o shell leria como outra coisa.
const escapePath = (p: string) => p.replace(/([\s!"#$&'()*,:;<>?[\\\]^`{|}~])/g, "\\$1");

/// Onde o arquivo caiu: a conversa, o terminal do dock, ou lugar nenhum.
type Drop = { host: HTMLElement; put: (paths: string[]) => void } | null;
function targetFrom(el: Element | null): Drop {
  if (!el) return null;
  if (el.closest("#dock")) {
    const pty = dock.currentKey();
    if (!pty) return null;
    return {
      host: $("dock"),
      put: (paths) => {
        // Espaço no fim: o próximo arquivo, ou o que você for escrever, não cola.
        const text = paths.map(escapePath).join(" ") + " ";
        void invoke("pty_write", { session: pty, data: text }).then(dock.focus).catch((e) => say(fromBack(e), true));
      },
    };
  }
  if (el.closest("#chatwrap") && session.canAttachFiles()) return { host: $("chatwrap"), put: session.attachFiles };
  return null;
}

function dropTarget(at?: { x: number; y: number }): Drop {
  if (!at || !$("veil").hidden) return null;

  // No macOS a posição do evento nativo pode carregar o deslocamento da barra
  // da janela. O :hover vem da própria webview e, quando disponível, é a fonte
  // mais fiel; a coordenada física continua sendo o fallback e cobre o mock.
  const underMouse = [$("dock"), $("chatwrap")].find((el) => el.matches(":hover")) ?? null;
  const hovered = targetFrom(underMouse);
  if (hovered) return hovered;
  const dpr = window.devicePixelRatio || 1;
  return targetFrom(document.elementFromPoint(at.x / dpr, at.y / dpr));
}

let activeDrop: Drop = null;
function markDrop(target: Drop) {
  const host = target?.host ?? null;
  const dropHost = activeDrop?.host ?? null;
  if (dropHost === host) {
    activeDrop = target;
    return;
  }
  dropHost?.classList.remove("dropping");
  activeDrop = target;
  host?.classList.add("dropping");
}

getCurrentWebview().onDragDropEvent(({ payload }) => {
  const drag = payload as Drag;
  if (drag.type === "leave") return markDrop(null);

  // Lançador aberto: o arquivo vira anexo da primeira fala, e nada vai ao pty.
  if (!$("veil").hidden) {
    markDrop(null);
    if (drag.type === "drop" && $("veil").querySelector("#d-prompt")) dropFiles(drag.paths ?? []);
    return;
  }

  const target = dropTarget(drag.position);
  if (drag.type !== "drop") return markDrop(target);

  // O alvo que a moldura mostrou manda. O Tauri tem casos em que a posição do
  // `drop` final difere dos eventos `over`; recalculá-la e descartar o último
  // alvo válido fazia o mesmo gesto funcionar ou não conforme o ponto exato.
  const accepted = activeDrop ?? target;
  markDrop(null);
  const paths = drag.paths ?? [];
  if (!accepted || !paths.length) return;
  accepted.put(paths);
});

/* ---------- ações ---------- */

function launch(projectId?: string, seed?: Issue) {
  if (!state.projects.length) return hooks.addProject();
  openLauncher(state, {
    preset: projectId,
    seed,
    toSettings: () => showSettings(),
    // Criar volta em milissegundos: o workspace entra na lista na hora e o worktree
    // monta atrás (ver `create_workspace`). Sem recado na barra, então — quem
    // conta que está montando é a tela que abriu, e estado que a tela já mostra
    // não vira narração aqui em cima.
    go: async (draft: Draft) => {
      try {
        const created = await invoke<Workspace>("create_workspace", { draft, ...dock.dims() });
        // O back já publicou o estado com ele dentro, mas a resposta do comando
        // e o evento são duas mensagens, e nada garante qual chega primeiro.
        // Quem desenha procura o workspace aberto no estado que a tela tem: sem
        // isto, entrar nele podia cair no retorno a Issues do `draw` e voltar sozinho.
        // O próximo evento troca o estado inteiro e leva esta cópia junto.
        if (!state.workspaces.some((w) => w.id === created.id)) state.workspaces.push(created);
        openWorkspace(created);
      } catch (err) {
        say(fromBack(err), true);
      }
    },
  });
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

/// O que um atalho faz. Chamam daqui de baixo (o teclado) e do menu do Mac
/// (`appmenu.ts`), que é o caminho que sobra quando o foco está dentro da aba
/// de navegador — webview do sistema, que não manda tecla para este documento.
/// Devolve se fez alguma coisa: é o que decide se a tecla é engolida.
function act(a: appmenu.Action): boolean {
  const open = ws.id();
  // Num workspace de colega nada disto existe: nem aba nova, nem etapa, nem
  // dock. O atalho não faz nada, em vez de mandar ao back um id que ele não tem.
  const own = open && !team.isRemote(open) ? open : null;
  switch (a) {
    case "novoWorkspace":
      launch(state.workspaces.find((w) => w.id === open)?.project);
      return true;
    case "novaConversa":
      if (!own) return false;
      ws.newTab();
      return true;
    case "arquivar":
      if (!own) return false;
      hooks.archive(own, true);
      return true;
    // ⌘⇧D é concluir: a última etapa e o arquivo, que é o que se faz quando o PR
    // entrou — e o que se fazia em três passos antes de haver um gesto só.
    case "concluir":
      if (!own) return false;
      hooks.finish(own);
      return true;
    case "run":
      if (!own) return false;
      dockbar.toggleRun();
      return true;
    case "lateral":
      toggleRail();
      return true;
    // ⌘⇧M é a nota citando o que está selecionado na conversa: a mão já está no
    // mouse, tendo acabado de selecionar.
    case "nota":
      return !!open && ws.quoteSelection();
    // ⌘, é onde todo app do Mac guarda as preferências.
    case "ajustes":
      showSettings();
      return true;
    // O dock tem a primeira palavra: ⌘W com o cursor dentro dele fecha o
    // terminal que está ali, e não a aba do centro, que é o que ele fecharia
    // por baixo. Com o foco na aba de navegador, porém, o cursor do dock é o de
    // antes: `hasFocus` falso com a janela ativa é a página que está com ele, e
    // aí ⌘W é a aba — que é o que se quer fechar quando se está olhando para ela.
    case "fechar":
      return (document.hasFocus() && dockbar.closeFocused()) || ws.closeActive();
    case "voltar":
      travel(-1);
      return true;
    case "avancar":
      travel(1);
      return true;
  }
}

/// A tecla apertada, se for atalho. Minúscula porque com Shift o `key` vem
/// maiúsculo.
function shortcut(e: KeyboardEvent): appmenu.Action | null {
  const k = e.key.toLowerCase();
  if (e.shiftKey) {
    if (k === "a") return "arquivar";
    if (k === "d") return "concluir";
    if (k === "m") return "nota";
    return null;
  }
  if (k === "n") return "novoWorkspace";
  if (k === "t") return "novaConversa";
  if (k === "r") return "run";
  if (k === "b") return "lateral";
  if (k === ",") return "ajustes";
  if (k === "w") return "fechar";
  if (k === "[") return "voltar";
  if (k === "]") return "avancar";
  return null;
}

document.addEventListener("keydown", (e) => {
  // Atalho atendido é atalho engolido: sem o `preventDefault`, o acelerador do
  // menu dispara a mesma ação em seguida.
  const a = e.metaKey || e.ctrlKey ? shortcut(e) : null;
  if (a && act(a)) e.preventDefault();
  if (e.key === "Escape" && !$("veil").hidden) {
    $("veil").hidden = true;
    $("veil").replaceChildren();
  }
});

void appmenu.install(act);

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
  ["wback", "arrow-left"],
  ["wfwd", "arrow-right"],
  ["wreload", "rotate"],
  ["wext", "external-link"],
  ["collapse", "list-tree"],
  ["dock-again", "rotate"],
  ["run-pick", "chevron-down"],
  ["dseen", "check"],
  ["dfold", "chevron-up"],
  ["settings", "settings"],
] as const) {
  $(id).innerHTML = icon(name);
}

links.init(say);
void update.init(say);
// Quais agentes existem nesta máquina: é o que o lançador oferece no rodapé.
// Ninguém espera por isso para a tela aparecer — até a resposta chegar, o
// lançador mostra só o Claude Code, que é o que o app era.
void loadAgents().then(() => statusbar.showAgents(installed()));
// O time vem antes das configurações, que é onde ele aparece, e antes da barra
// lateral, que vai mostrar o que os colegas compartilham.
team.onError((m) => say(m, true));
await team.init();
// O hub de MCP: quem desenha a lista é Configurações, e quem a lê são os dois
// seletores (lançador e conversa). Carrega junto com a tela — é um arquivo
// pequeno, e um seletor vazio no primeiro clique seria pior que esperar.
mcp.init({ say });
void mcp.load();
// O hub de plugins, pela mesma razão e do mesmo jeito.
plugins.init({ say });
void plugins.load();
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
archived.init({ board: () => state, hooks: () => hooks });
ws.init({ say, board: view, redraw: draw, home: () => showIssues() });
// O que a caixa de escrever precisa saber da aba aberta: de quem é, se está
// desligada, se há time para deixar nota.
session.init(
  (m) => say(m, true),
  () => {
    const open = ws.id();
    const w = open ? view().workspaces.find((x) => x.id === open) : undefined;
    const tab = w?.tabs.find((t) => t.id === session.currentSession());
    return {
      workspace: open,
      status: tab?.status ?? null,
      mcp: w?.mcp ?? null,
      plugins: w?.plugins ?? null,
      pending: tab?.pending_prompt ?? null,
      worktree: w?.worktree ?? null,
      remote: w?.remote ? { name: team.nameOf(w.remote.owner), online: w.remote.online } : null,
      team: !!team.status().config && !!w && (w.shared || !!w.remote),
      // O modelo da aba, quando ela escolheu um; senão o do workspace. Quem
      // responde é ter ou não `choice`, e não o modelo estar preenchido:
      // modelo vazio é uma escolha (o padrão do CLI), não a falta de uma.
      model: tab?.choice ? tab.choice.model : (w?.model ?? ""),
      effort: tab?.choice ? tab.choice.effort : (w?.effort ?? ""),
    };
  },
);
viewer.init((m) => say(m, true), ws.fileSaved);
dock.init($("dockterm"));
state = await invoke<Board>("load_board");
showIssues();

// O que mudou desde a última vez que você abriu o app. Depois da primeira tela
// desenhada: a folha aparece sobre o app, e não no lugar dele.
void news.init();

// De onde vem o selo de mergeado: uma pergunta ao `gh` por repositório, e a
// resposta entra no estado. De minuto em minuto porque é rede, e porque o que
// muda ali é o PR de alguém — não algo que este app faça. A primeira vai agora:
// o app que sobe depois de um merge tem que já nascer sabendo.
const PR_SCAN = 60_000;
const scanPrs = () => void invoke("refresh_prs").catch(() => {});
scanPrs();
setInterval(scanPrs, PR_SCAN);
