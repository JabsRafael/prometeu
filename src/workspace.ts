import { invoke } from "@tauri-apps/api/core";
import * as board from "./board";
import * as diff from "./diff";
import * as dockbar from "./dockbar";
import { avatar, icon, stageIcon } from "./icons";
import { fromBack, stage as stageName, t, tn } from "./i18n";
import * as menu from "./menu";
import * as rename from "./rename";
import * as session from "./session";
import * as tree from "./tree";
import { fmtTokens, label, merged, statusOf, type Board, type Change, type Tab, type Workspace } from "./types";
import { $, debounce } from "./util";
import * as viewer from "./viewer";

/// A tela de um workspace: migalha, abas, o que está no centro (conversa,
/// arquivo ou diff) e o painel da direita. O quadro é o outro lado do app e
/// mora no `board`.

export type Ctx = {
  say: (text: string, isError?: boolean) => void;
  board: () => Board;
  /// Redesenha o app inteiro — quadro e workspace.
  redraw: () => void;
  /// Sai para o quadro. Workspace que some debaixo de você não pode deixar a
  /// tela num lugar que não existe mais.
  toBoard: () => void;
};

let ctx: Ctx;
let openWs: string | null = null;

export const id = () => openWs;
const current = () => ctx.board().workspaces.find((w) => w.id === openWs);

export function init(context: Ctx) {
  ctx = context;

  tree.init({ openFile, workspace: id });
  dockbar.init({ workspace: id, say: ctx.say, openFile, newTab });

  $("tab-files").addEventListener("click", () => setSidePane("files"));
  $("tab-diff").addEventListener("click", () => {
    // Já no painel de Mudanças, clicar de novo traz o diff para o centro. É o
    // caminho de volta depois de fechar a aba — sem ele, quem fechou só voltaria
    // clicando num arquivo da lista.
    const changes = openWs ? (changesOf.get(openWs)?.length ?? 0) : 0;
    if (sidePane === "diff" && changes) showChanges();
    else setSidePane("diff");
  });
  $("reveal").addEventListener("click", () => {
    if (openWs) invoke("reveal", { id: openWs }).catch((e) => ctx.say(fromBack(e), true));
  });
  $("dfold").addEventListener("click", () => {
    if (!openWs) return;
    diff.foldAll((changesOf.get(openWs) ?? []).map((c) => c.path));
    drawChanges(openWs);
  });

  $("pr").innerHTML = `${icon("git-pull-request", 14)}<span></span>`;
  $("pr").querySelector("span")!.textContent = t("ws.pr");
  // Um botão só, três estados: com o PR mergeado ele conclui em vez de pedir
  // mais commit. Quem decide é o que o quadro sabe do PR na hora do clique.
  $("pr").addEventListener("click", () => {
    const ws = current();
    if (!ws) return;
    if (merged(ws)) finish(ws.id);
    else void openPr();
  });

  // Só o número e a seta: quem diz "PR" é o botão ao lado, e dois botões com o
  // mesmo rótulo na mesma barra é o que fazia a barra ficar ambígua.
  $("prlink").innerHTML = `<span></span>${icon("external-link", 12)}`;
  $("prlink").addEventListener("click", () => {
    if (openWs) invoke("open_pr", { id: openWs }).catch((e) => ctx.say(fromBack(e), true));
  });

  // Duplo clique renomeia, como no nome do workspace na migalha. Escuta na barra
  // e não no botão: o primeiro clique troca de aba, a troca refaz a barra, e o
  // botão em que o gesto começou já não existe quando o duplo clique chega.
  $("tabbar").addEventListener("dblclick", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".tab[data-tab]");
    if (b?.dataset.tab) editTab(b.dataset.tab);
  });
}

/* ---------- entrar e sair ---------- */

export async function open(ws: Workspace) {
  const first = ws.tabs.find((t) => t.id === ws.active) ?? ws.tabs[0];
  // Abrir é ler: a novidade deste workspace morre aqui, e o que acontecer nele
  // enquanto ele estiver na tela não vira novidade nova.
  invoke("look_at", { id: ws.id });
  board.setOpen((openWs = ws.id));
  tree.reset();
  dockbar.reset();
  $("boardView").hidden = true;
  $("wsView").hidden = false;
  $("wsctl").hidden = false;
  // Worktree devolvido: não há processo para ligar nem arquivo para ler. O que
  // sobrou é o que está escrito, e é isso que a tela mostra.
  if (ws.cleaned) {
    session.detach();
    draw();
    return;
  }
  // attach primeiro: é ele quem define a sessão corrente que as abas marcam.
  if (first) await session.attach(first.id);
  // Volta para onde parou: arquivo aberto continua aberto, diff continua na tela.
  const fs = files(ws.id);
  if (fs.diff) showChanges();
  else if (fs.active) await showFile();
  else showTerm();
  ctx.redraw();
}

export function leave() {
  session.detach();
  invoke("look_at", { id: null });
  board.setOpen((openWs = null));
  $("boardView").hidden = false;
  $("wsView").hidden = true;
  $("wsctl").hidden = true;
}

/* ---------- desenho ---------- */

export function draw() {
  const ws = current();
  if (!ws) return ctx.toBoard();

  // Migalha como no Conductor: avatar do projeto › nome do workspace › branch.
  const crumb = $("crumb");
  crumb.innerHTML =
    `${avatar(ws.repo_name)}<span></span><span class="sep">${icon("chevron-right", 12)}</span><span></span>` +
    `<button class="branch" hidden>${icon("git-branch", 12)}<span></span></button>`;
  crumb.children[1].textContent = ws.repo_name;
  const name = crumb.children[3] as HTMLElement;
  name.textContent = ws.title;
  // Na migalha não tem lápis: nada ali é clicável, então o duplo clique é livre.
  name.title = t("ws.rename");
  name.addEventListener("dblclick", () =>
    rename.start(name, ws.title, (title) => renameWorkspace(ws.id, title), "crumb"),
  );

  const st = statusOf(ws);
  const chip = $("wsstatus");
  chip.className = `chip s-${st}`;
  chip.innerHTML = `<i class="dot"></i>`;
  chip.append(label(st));

  // A etapa é o mesmo submenu do botão direito, ancorado no botão: um lugar só
  // para escolher, esteja você no quadro ou dentro da conversa.
  const stages = ctx.board().stages;
  const stage = $("wsstage");
  stage.innerHTML = `${stageIcon(stages.indexOf(ws.stage), stages.length, 14)}<span></span>`;
  stage.children[1].textContent = stageName(ws.stage);
  stage.onclick = () => {
    const at = stage.getBoundingClientRect();
    menu.openAt(
      { x: at.left, y: at.bottom + 4 },
      stages.map((name, i) => ({
        label: stageName(name),
        glyph: stageIcon(i, stages.length),
        checked: name === ws.stage,
        run: () => setStage(ws.id, name),
      })),
    );
  };

  $("offpath").textContent = ws.worktree;
  drawBranch(ws);
  drawPr(ws);
  drawTabs(ws);
  reloadChanges(ws.id);
  if (sidePane === "files") tree.redrawSoon();
  // O agente edita; o arquivo na tela acompanha, sem polling.
  const file = files(ws.id).active;
  if (file) viewer.show(ws.id, file);

  const tab = ws.tabs.find((t) => t.id === session.currentSession());
  // Terminal mudo confunde; a saída fica escrita na tela. Worktree devolvido é
  // o mesmo painel com a outra história — e sem o botão de retomar, que não
  // teria para onde voltar.
  $("offline").hidden = !ws.cleaned && tab?.status !== "desligada";
  $("offtitle").textContent = t(ws.cleaned ? "gone.title" : "offline.title");
  $("offbody").textContent = t(ws.cleaned ? "gone.body" : "offline.body");
  $("resume").hidden = ws.cleaned;
  // Sem worktree não há aba para trocar, arquivo para abrir nem script para
  // rodar: o que sobra na tela é o que ainda quer dizer alguma coisa.
  $("tabbar").hidden = ws.cleaned;
  $("side").hidden = ws.cleaned;
  $("sidetoggle").hidden = ws.cleaned;
  $("wsstage").hidden = ws.cleaned;
}

/* ---------- ações do workspace ---------- */

export function renameWorkspace(id: string, title: string | null) {
  ctx.redraw();
  if (title) invoke("rename_workspace", { id, title }).catch((e) => ctx.say(fromBack(e), true));
}

export const setStage = (id: string, stage: string) => invoke("set_stage", { id, stage });

/// Pede o PR à conversa ativa: injeta o prompt que o back monta olhando o git
/// deste worktree. Vai como paste — entre \x1b[200~ e \x1b[201~ — para as
/// quebras de linha não virarem Enter no meio do texto; o Enter de verdade vai
/// sozinho logo depois, quando a TUI já engoliu o paste.
async function openPr() {
  const ws = current();
  if (!ws) return;
  const tab = ws.tabs.find((t) => t.id === session.currentSession()) ?? ws.tabs[0];
  if (!tab) return;
  if (tab.status === "desligada") {
    return ctx.say(t("ws.pr.offline"), true);
  }
  try {
    const prompt = await invoke<string>("pr_prompt", { id: ws.id });
    await invoke("pty_write", { session: tab.id, data: `\x1b[200~${prompt}\x1b[201~` });
    // O pedido foi para a conversa; a tela vai atrás dele.
    if (tab.id !== session.currentSession()) await session.attach(tab.id);
    showTerm();
    drawTabs(ws);
    session.focus();
    setTimeout(() => {
      invoke("pty_write", { session: tab.id, data: "\r" }).catch((e) => ctx.say(fromBack(e), true));
    }, 150);
  } catch (err) {
    ctx.say(fromBack(err), true);
  }
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
  chip.title = t("ws.branch.title");
  chip.onclick = () => {
    navigator.clipboard.writeText(name);
    ctx.say(t("ws.copied", { name }));
  };
}

function drawBranch(ws: Workspace) {
  paintBranch(ws.id);
  askBranch(ws.id);
}

/// Perguntar ao git em que branch o worktree está é barato, mas não de graça, e
/// a resposta quase nunca muda entre duas ferramentas do agente.
const askBranch = debounce(400, async (id: string) => {
  // Nome vazio é HEAD solto, e dizer isso é melhor do que não dizer nada: um
  // worktree em detached HEAD é justamente onde um commit se perde.
  const name = (await invoke<string | null>("workspace_branch", { id })) ?? t("ws.branch.detached");
  branchOf.set(id, name);
  if (openWs === id) paintBranch(id);
});

/* ---------- PR da branch ---------- */

/// O PR governa o botão da esquerda, e são três estados: sem PR, "Open PR", que
/// pede o PR ao agente; com PR aberto, "Atualizar PR" — commitar e empurrar
/// continua sendo o que mais se faz depois que o PR existe; com PR mergeado,
/// "Concluir", porque o que vem depois de mergear não é mais um commit, é sair
/// da frente. Ao lado, o `#42` leva até ele no navegador.
///
/// Quem guarda a resposta é o quadro (`ws.pr`), e não esta tela: é o mesmo dado
/// que pinta o selo do card. Daqui só sai o pedido de perguntar de novo, e não
/// mais que uma vez a cada `PR_EVERY` — `draw()` acontece a cada ferramenta que
/// o agente usa, e a resposta é de quem fala com a rede.
const prAt = new Map<string, number>();
const PR_EVERY = 20_000;

function paintPr(ws: Workspace) {
  const done = merged(ws);
  const ask = $("pr");
  ask.hidden = ws.cleaned;
  ask.querySelector("span")!.textContent = done ? t("ws.finish") : ws.pr ? t("ws.pr.update") : t("ws.pr");
  ask.title = done ? t("top.finish") : ws.pr ? t("top.pr.update") : t("top.pr");
  ask.classList.toggle("done", done);
  ask.firstElementChild!.outerHTML = icon(done ? "check" : "git-pull-request", 14);

  const link = $("prlink");
  link.hidden = !ws.pr;
  if (!ws.pr) return;
  const { number: n, title, isDraft, state } = ws.pr;
  link.querySelector("span")!.textContent = `#${n}`;
  link.title = t(state === "MERGED" ? "ws.pr.merged" : isDraft ? "ws.pr.draft" : "ws.pr.view", { n, title });
}

function drawPr(ws: Workspace) {
  paintPr(ws);
  askPr(ws);
}

/// Worktree devolvido não tem branch para perguntar por: o que se sabe do PR é
/// o que ficou gravado.
function askPr(ws: Workspace) {
  const now = Date.now();
  if (ws.cleaned || now - (prAt.get(ws.id) ?? 0) < PR_EVERY) return;
  prAt.set(ws.id, now);
  // A resposta entra no quadro pelo back, e é o redesenho que a mostra.
  invoke("pr_open", { id: ws.id }).catch(() => {});
}

/// Concluir do jeito curto: a etapa vai para a última e o workspace é
/// arquivado, com o agente e os docks caindo junto. É o botão da barra quando
/// o PR mergeou, e o item de menu em qualquer outra hora.
export function finish(id: string) {
  if (openWs === id) ctx.toBoard();
  invoke("finish_workspace", { id }).catch((e) => ctx.say(fromBack(e), true));
}

/* ---------- abas ---------- */

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
    b.title =
      label(tab.status) +
      (tab.tokens ? t("tab.tokens", { n: fmtTokens(tab.tokens) }) : "") +
      t("tab.rename");
    b.addEventListener("click", () => selectTab(ws.id, tab.id));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu.openAt({ x: e.clientX, y: e.clientY }, tabMenu(ws, tab));
    });

    if (ws.tabs.length > 1) {
      const x = document.createElement("span");
      x.className = "tabx ico sm";
      x.innerHTML = icon("x", 12);
      x.title = t("tab.close");
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
    b.children[1].textContent = t("tab.changes");
    b.children[2].textContent = changes.length ? String(changes.length) : "";
    b.title = t("tab.changes.title");
    b.addEventListener("click", () => showChanges());
    const x = document.createElement("span");
    x.className = "tabx ico sm";
    x.innerHTML = icon("x", 12);
    x.title = t(fs.diff ? "tab.changes.closeKey" : "tab.changes.close");
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
  add.title = t("tab.new");
  add.addEventListener("click", () => newTab());
  bar.append(add);
}

/// Abre o campo no rótulo da aba que está na barra agora. Procurar o botão na
/// hora, em vez de guardar o de quando o gesto começou, é o que faz o renomear
/// sobreviver ao redesenho que a troca de aba dispara no caminho.
function editTab(tabId: string) {
  const ws = current();
  const tab = ws?.tabs.find((t) => t.id === tabId);
  const b = $("tabbar").querySelector<HTMLElement>(`.tab[data-tab="${CSS.escape(tabId)}"]`);
  if (!ws || !tab || !b) return;
  rename.start(
    b.children[1] as HTMLElement,
    tab.title,
    (title) => {
      ctx.redraw();
      if (title) {
        invoke("rename_tab", { workspace: ws.id, tab: tabId, title }).catch((e) =>
          ctx.say(fromBack(e), true),
        );
      }
    },
    "tab",
  );
}

/// Tudo que se faz com uma conversa, no botão direito — o mesmo lugar em que
/// moram as ações do workspace, em vez de um botãozinho por ação na aba.
function tabMenu(ws: Workspace, tab: Tab): menu.Item[] {
  const items: menu.Item[] = [
    { label: t("ws.menu.rename"), glyph: icon("pencil"), run: () => editTab(tab.id) },
  ];
  // A última conversa não fecha: um workspace sem conversa nenhuma é uma tela
  // vazia sem nada para clicar.
  if (ws.tabs.length > 1) {
    items.push("sep", {
      label: t("tab.close"),
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
  draw();
}

export async function newTab(prompt = "") {
  const ws = current();
  if (!ws) return;
  try {
    const tab = await invoke<{ id: string }>("new_tab", {
      workspace: ws.id,
      prompt,
      ...session.dims(),
    });
    showTerm();
    await session.attach(tab.id);
    draw();
  } catch (err) {
    ctx.say(fromBack(err), true);
  }
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

/// Workspace que saiu do quadro leva junto o que era só dele. Sem isto, cada
/// mapa aqui guardava para sempre o estado de tela de coisas que não existem.
export function forget(alive: Set<string>) {
  for (const map of [filesOf, changesOf, branchOf] as Map<string, unknown>[]) {
    for (const id of map.keys()) if (!alive.has(id)) map.delete(id);
  }
}

export async function openFile(path: string) {
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

/// ⌘W. Fecha o que está no centro, se for algo que se fecha — a conversa não é.
export function closeActive(): boolean {
  const fs = openWs && files(openWs);
  if (!fs) return false;
  if (fs.active) {
    closeFile(fs.active);
    return true;
  }
  if (fs.diff) {
    closeChanges();
    return true;
  }
  return false;
}

/* ---------- mudanças ---------- */

const changesOf = new Map<string, Change[]>();

/// Cada chamada é um `git diff` do worktree inteiro no back, e quem pede é o
/// evento do quadro — que chega a cada ferramenta que o agente usa. Juntar as
/// rajadas aqui é o que separa "o diff acompanha sozinho" de "a tela trava
/// enquanto o agente trabalha".
const reloadChanges = debounce(250, (id: string) => void loadChanges(id));

/// Descarta resposta de pedido velho: dois `workspace_diff` no ar podem voltar
/// fora de ordem, e o antigo sobrescreveria o novo.
let request = 0;

async function loadChanges(id: string) {
  const mine = ++request;
  const changes = await invoke<Change[]>("workspace_diff", { id });
  if (mine !== request) return;
  changesOf.set(id, changes);
  $("diffcount").textContent = changes.length ? String(changes.length) : "";
  // Worktree limpo esquece que a aba foi fechada: o que sujar depois é trabalho
  // novo, e não o diff que você mandou embora.
  if (!changes.length) files(id).hidDiff = false;

  const list = $("difflist");
  if (!changes.length) {
    const none = document.createElement("div");
    none.className = "none";
    none.textContent = t("diff.clean");
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
        row.children[1].textContent = f.new_file ? t("diff.new") : "";
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
  crumb.children[1].textContent = tn(changes.length, "diff.files");
  crumb.children[2].textContent = added ? `+${added}` : "";
  crumb.children[3].textContent = removed ? `−${removed}` : "";

  diff.render($("dlist"), id, changes, focus);
}

/* ---------- painel da direita ---------- */

let sidePane: "files" | "diff" = "files";

function setSidePane(pane: "files" | "diff") {
  sidePane = pane;
  $("tab-files").classList.toggle("on", pane === "files");
  $("tab-diff").classList.toggle("on", pane === "diff");
  $("tree").hidden = pane !== "files";
  $("difflist").hidden = pane !== "diff";
  if (pane === "files") tree.redraw();
}
