import * as actions from "./actions";
import { invoke } from "./ipc";
import * as sidebar from "./sidebar";
import * as browser from "./browser";
import * as diff from "./diff";
import * as dockbar from "./dockbar";
import { avatar, icon, stageIcon, wave } from "./icons";
import { fromBack, stage as stageName, t, tn } from "./i18n";
import { agentOf, fitsEffort, modelGroups, modelLabel } from "./launcher";
import * as menu from "./menu";
import * as notes from "./notes";
import * as rename from "./rename";
import * as session from "./session";
import * as team from "./team";
import * as tree from "./tree";
import {
  fmtTokens,
  label,
  merged,
  prs,
  pending,
  tabLabel,
  type Board,
  type Choice,
  type GitStatus,
  type Tab,
  type Workspace,
} from "./types";
import { $, debounce, h, template } from "./util";
import * as viewer from "./viewer";
import * as changesUi from "./workspace-changes";

/// A tela de um workspace: migalha, abas, o que está no centro (conversa,
/// arquivo ou diff) e o painel da direita.

export type Ctx = {
  say: (text: string, isError?: boolean) => void;
  board: () => Board;
  /// Redesenha o app inteiro — barra lateral e workspace.
  redraw: () => void;
  /// Sai para a tela inicial. Workspace que some debaixo de você não pode deixar a
  /// tela num lugar que não existe mais.
  home: () => void;
  launchBranch: (project: string, base: string, branch?: string) => void;
  openGitWorkspace: (id: string) => void;
};

let ctx: Ctx;
let openWs: string | null = null;
/// Cada entrada/saída invalida toda continuação assíncrona da anterior. O id do
/// workspace sozinho não basta: sair e voltar para o mesmo id também precisa
/// matar o attach que começou na primeira visita.
let navigation = 0;

export const id = () => openWs;
const current = () => ctx.board().workspaces.find((w) => w.id === openWs);
const stillHere = (epoch: number, id: string) => navigation === epoch && openWs === id;

export function init(context: Ctx) {
  ctx = context;
  changesUi.init({
    workspace: current,
    refresh: async () => { if (openWs && hasDiff()) await loadChanges(openWs); },
    show: activateChanges,
    say: ctx.say,
    openFile: openChange,
    launchBranch: ctx.launchBranch,
    openWorkspace: ctx.openGitWorkspace,
  });

  tree.init({ openFile, workspace: id });
  dockbar.init({
    workspace: id,
    say: ctx.say,
    openFile,
    newTab,
    openBrowser: showWeb,
    enter: showShell,
    exit: showTerm,
    drawTabs: () => {
      const ws = current();
      if (ws) drawTabs(ws);
    },
  });
  browser.init((id) => invoke("open_run", { id }).catch((e) => ctx.say(fromBack(e), true)), ctx.say);
  notes.init({
    workspace: id,
    tab: session.currentSession,
    open: openComments,
    focus: session.focusAnchor,
    say: ctx.say,
  });

  $("tab-files").addEventListener("click", () => setSidePane("files"));
  $("tab-diff").addEventListener("click", () => {
    // Já no painel de Mudanças, clicar de novo traz o diff para o centro. É o
    // caminho de volta depois de fechar a aba — sem ele, quem fechou só voltaria
    // clicando num arquivo da lista.
    if (sidePane === "diff") changesUi.show("changes");
    else setSidePane("diff");
  });
  $("tab-comments").addEventListener("click", openComments);
  // Revisar é ler o diff inteiro de uma vez, no centro — o mesmo caminho do
  // segundo clique na aba de Mudanças, dito com todas as letras.
  $("review").innerHTML = `${icon("eye", 13)}<span></span>`;
  $("review").querySelector("span")!.textContent = t("side.review");
  $("review").addEventListener("click", () => {
    setSidePane("diff");
    changesUi.show("compare");
  });
  $("reveal").addEventListener("click", () => {
    if (openWs) invoke("reveal", { id: openWs }).catch((e) => ctx.say(fromBack(e), true));
  });
  // O diff acompanha o agente pelos eventos do quadro. Mas quem comita no dock,
  // ou num terminal de fora, não publica evento nenhum — e o painel continuava
  // mostrando como fora de commit o que você acabou de commitar. Voltar para a
  // janela e estar olhando as Mudanças são os dois momentos em que isso se nota.
  window.addEventListener("focus", () => {
    if (hasDiff()) reloadChanges(openWs!);
  });
  setInterval(() => {
    if (hasDiff() && document.hasFocus() && (sidePane === "diff" || files(openWs!).diff)) reloadChanges(openWs!);
  }, WATCH_EVERY);

  // A onda do painel de "montando" é desenhada uma vez: ela não muda, e o
  // `draw` roda a cada atualização dos workspaces.
  $("offwave").innerHTML = wave(22);

  // Um botão só, quatro estados — pedir o PR, atualizar, ir até ele, concluir.
  // Quem decide é `paintPr`, que é quem sabe o estado do git e o do PR.
  $("pr").innerHTML = `${icon("git-pull-request", 14)}<span></span>`;
  $("pr").querySelector("span")!.textContent = t("ws.pr");

  // Duplo clique renomeia, como no nome do workspace na migalha. Escuta na barra
  // e não no botão: o primeiro clique troca de aba, a troca refaz a barra, e o
  // botão em que o gesto começou já não existe quando o duplo clique chega.
  $("tabbar").addEventListener("dblclick", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".tab[data-tab]");
    if (b?.dataset.tab && !current()?.remote) editTab(b.dataset.tab);
  });
}

/* ---------- entrar e sair ---------- */

export async function open(ws: Workspace, tab?: string) {
  if (tab && openWs === ws.id) return selectTab(ws.id, tab);
  const epoch = ++navigation;
  // Ir de um workspace a outro não passa pelo `leave`: sem isto, a webview do
  // que ficou para trás continuaria por cima do que você abriu.
  browser.hide();
  session.detach();
  const first = ws.tabs.find((t) => t.id === (tab ?? ws.active)) ?? ws.tabs[0];
  sidebar.setOpen((openWs = ws.id));
  changesUi.enter();
  $("wsView").hidden = false;
  $("wsctl").hidden = false;
  // Workspace de um colega: nada dele está neste disco — sem arquivos, sem
  // dock, sem novidade para marcar no back. É a conversa com os comentários
  // ao lado.
  if (ws.remote) {
    showTerm();
    if (first && !(await session.attach(first.id, ws.id))) return;
    if (!stillHere(epoch, ws.id)) return;
    ctx.redraw();
    return;
  }
  // Abrir é ler: a novidade deste workspace morre aqui, e o que acontecer nele
  // enquanto ele estiver na tela não vira novidade nova.
  invoke("look_at", { id: ws.id });
  tree.reset();
  dockbar.reset();
  // A pasta ainda está sendo montada — ou a montagem não deu. Não há aba a que
  // ligar o terminal, arquivo para ler nem diff para pedir: o que a tela mostra
  // é o painel. Quando a aba nascer, é o `catchUp` do `draw` que liga.
  if (pending(ws)) {
    showTerm();
    ctx.redraw();
    return;
  }
  // Worktree devolvido: não há processo para ligar nem arquivo para ler. O que
  // sobrou é o que está escrito, e é isso que a tela mostra.
  if (ws.cleaned) {
    ctx.redraw();
    return;
  }
  // attach primeiro: é ele quem define a sessão corrente que as abas marcam.
  if (first && !(await session.attach(first.id))) return;
  if (!stillHere(epoch, ws.id)) return;
  if (tab && first) invoke("focus_tab", { workspace: ws.id, tab: first.id });
  // Volta para onde parou: arquivo aberto continua aberto, diff continua na tela.
  const fs = files(ws.id);
  if (tab) showTerm();
  else if (fs.web) await showWeb();
  else if (fs.diff) showChanges();
  else if (fs.active) await showFile();
  else showTerm();
  if (!stillHere(epoch, ws.id)) return;
  ctx.redraw();
}

/// O terminal liga na aba assim que ela existir.
///
/// Quem abre um workspace pronto liga no `open`. Isto é para quem entrou
/// enquanto o worktree montava: a aba nasce alguns segundos depois, num
/// `publish` que só chama `draw`, e a tela não pode depender de você sair e
/// voltar para ver a conversa. `term.attach` marca a sessão corrente antes do
/// primeiro `await`, então dois `draw` seguidos não ligam duas vezes.
function catchUp(ws: Workspace) {
  if (ws.remote || ws.cleaned || pending(ws) || session.currentSession()) return;
  const first = ws.tabs.find((t) => t.id === ws.active) ?? ws.tabs[0];
  if (first) {
    const epoch = navigation;
    void session.attach(first.id).then((attached) => {
      if (attached && stillHere(epoch, ws.id)) ctx.redraw();
    });
  }
}

export function leave() {
  navigation++;
  browser.hide();
  session.detach();
  invoke("look_at", { id: null });
  sidebar.setOpen((openWs = null));
  $("wsView").hidden = true;
  $("wsctl").hidden = true;
}

/* ---------- desenho ---------- */

export function draw() {
  const ws = current();
  if (!ws) return ctx.home();
  catchUp(ws);

  // Migalha como no Conductor: avatar do projeto › nome do workspace › branch.
  // No workspace de um colega, o primeiro pedaço é ele — é o que diz de quem
  // é a conversa que está na tela.
  const remote = ws.remote;
  const owner = remote ? team.nameOf(remote.owner) : null;
  const crumb = $("crumb");
  // O quadro muda a cada ferramenta do agente. A identidade, não: reconstruir
  // esta árvore em todo evento fazia a branch e o título piscarem e também
  // acumulava listeners. Ela só nasce de novo quando muda o workspace (ou o
  // nome de um dono remoto); os redraws seguintes apenas atualizam valores.
  const crumbKey = `${ws.id}\u0000${owner ?? ws.repo_name}`;
  if (crumb.dataset.workspace !== crumbKey || !crumb.querySelector(".nm")) {
    crumb.dataset.workspace = crumbKey;
    crumb.innerHTML =
      `${avatar(owner ?? ws.repo_name)}<span class="who"></span><button class="repos" hidden></button>` +
      `<span class="sep">${icon("chevron-right", 12)}</span><span class="nm"></span>` +
      `<button class="branch" hidden>${icon("git-branch", 12)}<span></span></button>`;
  }
  // Com mais de um repositório os nomes emendados comiam a barra, e ainda
  // repetiam o que as seções de Mudanças já dizem. Fica quantos são, e o clique
  // leva a cada um deles.
  const many = !owner && ws.repos.length > 1;
  const who = crumb.querySelector<HTMLElement>(".who")!;
  const repos = crumb.querySelector<HTMLElement>(".repos")!;
  who.hidden = many;
  who.textContent = owner ?? ws.repo_name;
  repos.hidden = !many;
  if (many) {
    repos.innerHTML = `${icon("folder", 12)}<span></span>`;
    repos.children[1].textContent = tn(ws.repos.length, "diff.repos");
    repos.title = ws.repos.map((r) => r.name).join(" · ");
    repos.onclick = () => {
      const at = repos.getBoundingClientRect();
      menu.openAt({ x: at.left, y: at.bottom + 4 }, repoItems(ws));
    };
  }
  const name = crumb.querySelector<HTMLElement>(".nm")!;
  name.textContent = ws.title;
  if (!remote) {
    // Na migalha não tem lápis: nada ali é clicável, então o duplo clique é livre.
    name.title = t("ws.rename");
    name.ondblclick = () => rename.start(name, ws.title, (title) => renameWorkspace(ws.id, title), "crumb");
  } else {
    name.title = "";
    name.ondblclick = null;
  }
  // A branch gravada dá a primeira pintura, sem abrir um buraco enquanto o
  // Git responde. `drawBranch` abaixo a corrige caso o agente a tenha trocado.
  paintBranchName(branchOf.get(ws.id) ?? ws.branch);

  drawTabs(ws);
  const tab = ws.tabs.find((t) => t.id === session.currentSession());
  drawShare(ws, tab);
  drawMore(ws);
  // A caixa de escrever diz o estado da aba: desligada, de um colega offline.
  session.refresh();
  const collaborative = !!team.status().config && (ws.shared || !!remote);
  $("tab-comments").hidden = !collaborative;
  if (!collaborative && sidePane === "comments") setSidePane("files");
  notes.draw();

  if (remote) {
    // A branch é a que o dono contou; não há git aqui para perguntar. E o PR,
    // o diff, a árvore e o dock são do disco dele — nada disso existe aqui.
    // Sobra a conversa e os comentários; quem diz que ele está offline
    // é a caixa de escrever.
    paintBranchName(ws.branch);
    $("prsplit").hidden = true;
    $("offline").hidden = true;
    $("tabbar").hidden = false;
    $("side").hidden = false;
    $("sidetoggle").hidden = false;
    $("tab-files").hidden = true;
    $("tab-diff").hidden = true;
    $("review").hidden = true;
    $("collapse").hidden = true;
    $("reveal").hidden = true;
    $("dock").hidden = true;
    setSidePane("comments");
    return;
  }

  // Montando, ou montagem que não deu. Não existe pasta, então não existe
  // arquivo, diff, dock nem aba — e oferecer qualquer um deles seria oferecer
  // um caminho que erra. Sobra o painel, que é o que há para dizer.
  if (pending(ws)) {
    paintBranchName(ws.branch);
    $("prsplit").hidden = true;
    $("dock").hidden = true;
    $("tabbar").hidden = true;
    $("side").hidden = true;
    $("sidetoggle").hidden = true;
    $("offline").hidden = false;
    $("offwave").hidden = !!ws.failed;
    $("offtitle").textContent = t(ws.failed ? "build.failed.title" : "build.title");
    // Preparando não tem corpo: a onda e o título dizem o que há para dizer, e
    // um parágrafo explicando o que dura dois segundos é ruído. O que falhou,
    // sim — e vem do back no formato do `i18n`, como qualquer outro erro.
    $("offbody").hidden = !ws.failed;
    if (ws.failed) $("offbody").textContent = fromBack(ws.failed);
    $("offpath").textContent = ws.worktree;
    return;
  }

  $("prsplit").hidden = false;
  $("tab-files").hidden = false;
  $("tab-diff").hidden = false;
  $("collapse").hidden = false;
  $("reveal").hidden = false;
  $("dock").hidden = false;
  $("offpath").textContent = ws.worktree;
  drawBranch(ws);
  drawPr(ws);
  reloadChanges(ws.id);
  if (sidePane === "files") tree.redrawSoon();
  // O agente edita; o arquivo na tela acompanha, sem polling.
  const file = files(ws.id).active;
  if (file) viewer.show(ws.id, file);

  // Conversa desligada não é parede: a conversa fica na tela e escrever
  // retoma. Worktree devolvido, sim — não há para onde voltar, e o painel
  // conta o que ficou.
  $("offline").hidden = !ws.cleaned;
  $("offwave").hidden = true;
  $("offbody").hidden = false;
  $("offtitle").textContent = t("gone.title");
  $("offbody").textContent = t("gone.body");
  // Sem worktree não há aba para trocar, arquivo para abrir nem script para
  // rodar: o que sobra na tela é o que ainda quer dizer alguma coisa.
  $("tabbar").hidden = ws.cleaned;
  $("side").hidden = ws.cleaned;
  $("sidetoggle").hidden = ws.cleaned;
}

/// O botão de compartilhar e os chips de quem está olhando a conversa aberta.
/// Só há botão com time, e só em workspace seu: o de um colega já é dele. O
/// clique abre a lista: o time inteiro, ou cada colega — e é o relay que faz a
/// escolha valer, não a tela.
function drawShare(ws: Workspace, tab?: Tab) {
  const btn = $("share") as HTMLButtonElement;
  const chips = $("watchers");
  chips.replaceChildren();
  // Inativo é uma ação no menu, não um estado permanente na barra. Quando o
  // workspace está compartilhado, o ícone verde e os avatares tornam a
  // colaboração ativa visível sem uma frase longa.
  if (ws.remote || ws.cleaned || !team.status().config || !ws.shared) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.className = "ico on";
  btn.innerHTML = icon("share-2", 14);
  btn.title = `${shareLabel(ws)} — ${t("share.off.title")}`;
  btn.onclick = () => {
    const at = btn.getBoundingClientRect();
    menu.openAt({ x: at.left, y: at.bottom + 4 }, shareItems(ws));
  };
  if (!tab) return;
  const watching = team.watchersOf(tab.id);
  for (const name of watching.slice(0, 3)) {
    const c = template("span", "watcher", avatar(name));
    c.title = t("share.watching", { name });
    chips.append(c);
  }
  if (watching.length > 3) {
    const rest = template("span", "watcher more", `+${watching.length - 3}`);
    rest.title = watching.slice(3).join(" · ");
    chips.append(rest);
  }
}

/// Ações de baixa frequência saem da faixa principal. Etapa já aparece na
/// sidebar; compartilhar só ganha presença própria no topo depois de ligado.
function drawMore(ws: Workspace) {
  const btn = $("wsmore") as HTMLButtonElement;
  const available = !ws.remote && !ws.cleaned && !pending(ws);
  btn.hidden = !available;
  if (!available) return;

  btn.innerHTML = icon("ellipsis", 16);
  const stages = ctx.board().stages;
  const at = stages.indexOf(ws.stage);
  const items: menu.Item[] = [
    {
      label: t("ws.menu.stage"),
      glyph: stageIcon(at, stages.length),
      hint: stageName(ws.stage),
      sub: stages.map((name, i) => ({
        label: stageName(name),
        glyph: stageIcon(i, stages.length),
        checked: name === ws.stage,
        run: () => setStage(ws.id, name),
      })),
    },
  ];
  if (team.status().config && !ws.shared) {
    items.unshift({ label: t("share.on"), glyph: icon("share-2", 14), sub: shareItems(ws) });
  }
  btn.onclick = () => {
    const box = btn.getBoundingClientRect();
    menu.openAt({ x: box.left, y: box.bottom + 4 }, items);
  };
}

function shareLabel(ws: Workspace): string {
  if (!ws.shared) return t("share.on");
  if (!ws.audience) return t("share.off");
  return tn(ws.audience.length, "share.some");
}

/// A lista do botão: "todo o time" e um item por colega, com o check em quem
/// vê. Clicar num colega liga ou desliga só ele; tirar o último é parar.
function shareItems(ws: Workspace): menu.Item[] {
  const me = team.status();
  const others = me.members.filter((m) => m.id !== me.you);
  const set = (audience: string[] | null | false) => team.share(ws.id, audience).catch((e) => ctx.say(fromBack(e), true));
  const all = ws.shared && !ws.audience;
  const some = ws.shared && ws.audience ? ws.audience : [];
  const items: menu.Item[] = [
    { label: t("share.all"), glyph: icon("users", 14), checked: all, run: () => set(all ? false : null) },
    "sep",
    ...others.map((m): menu.Item => {
      const on = some.includes(m.id);
      return {
        label: m.name,
        glyph: avatar(m.name),
        hint: m.online ? undefined : t("team.offline"),
        checked: on,
        run: () => set(on ? some.filter((id) => id !== m.id) : [...some, m.id]),
      };
    }),
  ];
  if (!others.length) items.push({ label: t("share.alone"), disabled: true });
  if (ws.shared) items.push("sep", { label: t("share.stop"), glyph: icon("x", 14), danger: true, run: () => set(false) });
  return items;
}

/// A lista do chip de repositórios: um por repo, com o que ele tem de mudança,
/// e o clique leva às Mudanças dele. O nome do repositório só é pergunta quando
/// se quer ver o que mudou nele — o resto do tempo ele ocupa a barra à toa.
function repoItems(ws: Workspace): menu.Item[] {
  const all = changesUi.statuses(ws.id) ?? [];
  return ws.repos.map((repo, index): menu.Item => {
    const status = all.find(item => item.repo === index);
    const count = status ? new Set([...status.staged, ...status.changes, ...status.conflicts].map(file => file.path)).size : 0;
    return { label: repo.name, glyph: avatar(repo.name), hint: count ? tn(count, "diff.files") : t("git.clean"), run: () => changesUi.selectRepo(index) };
  });
}

/* ---------- ações do workspace ---------- */

export function renameWorkspace(id: string, title: string | null) {
  ctx.redraw();
  if (title) invoke("rename_workspace", { id, title }).catch((e) => ctx.say(fromBack(e), true));
}

export const setStage = (id: string, stage: string) => invoke("set_stage", { id, stage });

/// Pede o PR à conversa ativa: manda o prompt que o back monta olhando o git
/// deste worktree. Conversa desligada retoma sozinha com a fala.
async function openPr() {
  const ws = current();
  if (!ws) return;
  const configured = actions.catalog().commands.find(a => a.name === actions.catalog().pr_action && a.kind === "agent");
  if (configured) {
    try { await actions.start(ws.id, configured); } catch (error) { ctx.say(fromBack(error), true); }
    return;
  }
  const epoch = navigation;
  const tab = ws.tabs.find((t) => t.id === session.currentSession()) ?? ws.tabs[0];
  if (!tab) return;
  try {
    const prompt = await invoke<string>("pr_prompt", { id: ws.id });
    await invoke("chat_send", { session: tab.id, text: prompt });
    // O pedido foi para a conversa; a tela vai atrás dele.
    if (tab.id !== session.currentSession() && !(await session.attach(tab.id))) return;
    if (!stillHere(epoch, ws.id)) return;
    showTerm();
    drawTabs(ws);
    session.focus();
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
  paintBranchName(branchOf.get(id));
}

/// O chip da branch na migalha, com o nome que já se sabe — o que o git daqui
/// respondeu, ou o que o dono de um workspace remoto contou.
function paintBranchName(name: string | undefined) {
  const chip = $("crumb").querySelector<HTMLElement>(".branch");
  if (!chip || !name) return;
  chip.hidden = false;
  chip.children[1].textContent = name;
  chip.title = t("git.branches");
  chip.onclick = () => { if (current() && diffable(current()!)) changesUi.show("branches"); };
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

/// Só existe diff — e PR para pedir — de workspace que está neste disco e já
/// montado. O do colega mora no Mac dele, o devolvido não tem pasta, e o que
/// está montando não tem nem git ainda.
const diffable = (ws: Workspace) => !ws.remote && !ws.cleaned && !pending(ws);
const hasDiff = () => {
  const ws = current();
  return !!ws && ws.id === openWs && diffable(ws);
};

/* ---------- PR da branch ---------- */

/// O PR governa o botão da esquerda, e são quatro estados: sem PR, "Open PR",
/// que pede o PR ao agente; com PR aberto e coisa para mandar, "Atualizar PR";
/// com PR aberto e nada para mandar, quantos PRs há — e o clique leva até eles,
/// porque pedir para atualizar o que já está lá é pedir trabalho que não
/// existe; com tudo mergeado, "Concluir", que o que vem depois de mergear não é
/// mais um commit, é sair da frente. O ⌄ ao lado abre a lista, um item por
/// repositório: com três repos, três botões não cabiam na barra.
///
/// Quem guarda a resposta é o workspace (`ws.pr`), e não esta tela. Daqui só
/// sai o pedido de perguntar de novo, e não
/// mais que uma vez a cada `PR_EVERY` — `draw()` acontece a cada ferramenta que
/// o agente usa, e a resposta é de quem fala com a rede.
const prAt = new Map<string, number>();
const PR_EVERY = 20_000;

function paintPr(ws: Workspace) {
  const done = merged(ws);
  const all = prs(ws);
  const ask = $("pr");
  $("prsplit").hidden = !diffable(ws);
  // Com o PR aberto e nada para mandar, oferecer "Atualizar PR" é oferecer um
  // trabalho que não existe: o botão passa a dizer quantos PRs há, e leva a
  // eles. Enquanto o diff não chegou não se sabe, e o rótulo continua o de
  // pedir — dizer "tudo empurrado" antes de olhar é dizer o que não se sabe.
  const left = outstanding(ws.id);
  const quiet = all.length > 0 && !done && left !== null && !left.dirty && !left.unpushed;
  ask.querySelector("span")!.textContent = done
    ? t("ws.finish")
    : quiet
      ? tn(all.length, "ws.pr.open")
      : all.length
        ? t("ws.pr.update")
        : t("ws.pr");
  ask.title = done ? t("top.finish") : quiet ? t("top.pr.go") : all.length ? t("top.pr.update") : t("top.pr");
  ask.classList.toggle("done", done);
  ask.firstElementChild!.outerHTML = icon(done ? "check" : "git-pull-request", 14);
  ask.onclick = () => {
    if (done) return finish(ws.id);
    if (quiet) return all.length === 1 ? openIn(ws, all[0].repo) : prMenu(ws, ask);
    void openPr();
  };

  // Os PRs desta branch ficam num menu: um repositório a mais era um botão a
  // mais na barra, e três já não cabiam com o resto. O ⌄ só existe quando há
  // PR para listar.
  const pick = $("prpick");
  pick.hidden = !all.length;
  pick.innerHTML = icon("chevron-down", 14);
  pick.onclick = () => prMenu(ws, pick);
}

/// O menu dos PRs: um item por repositório que tem o seu, com o estado dele na
/// ponta. Abre no navegador — quem sabe onde cada um mora é o `gh`.
function prMenu(ws: Workspace, at: HTMLElement) {
  const many = ws.repos.length > 1;
  const box = at.getBoundingClientRect();
  menu.openAt(
    { x: box.left, y: box.bottom + 4 },
    prs(ws).map(({ repo, pr }) => ({
      label: many ? `${repo} · #${pr.number}` : `#${pr.number} ${pr.title}`,
      glyph: icon(pr.state === "MERGED" ? "check" : "git-pull-request", 14),
      hint: t(pr.state === "MERGED" ? "pr.merged" : pr.isDraft ? "pr.draft" : "pr.open"),
      run: () => openIn(ws, repo),
    })),
  );
}

const openIn = (ws: Workspace, repo: string) =>
  invoke("open_pr", { id: ws.id, repo }).catch((e) => ctx.say(fromBack(e), true));

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
  // A resposta entra no estado pelo back, e é o redesenho que a mostra.
  invoke("pr_open", { id: ws.id }).catch(() => {});
}

/// Concluir do jeito curto: a etapa vai para a última e o workspace é
/// arquivado, com o agente e os docks caindo junto. É o botão da barra quando
/// o PR mergeou, e o item de menu em qualquer outra hora.
export function finish(id: string) {
  if (openWs === id) ctx.home();
  invoke("finish_workspace", { id }).catch((e) => ctx.say(fromBack(e), true));
}

/* ---------- abas ---------- */

/// Abas sublinhadas: uma por conversa, depois as que você abriu — Mudanças,
/// navegador, terminais e arquivos — e o + logo depois da última.
function drawTabs(ws: Workspace) {
  // Refazer a barra com um campo de renomear aberto nela apaga o que foi
  // digitado — e o diff, que redesenha sozinho, chega aqui a toda hora.
  if (rename.editing()) return;
  const bar = $("tabbar");
  bar.replaceChildren();
  const fs = files(ws.id);
  const elsewhere = fs.diff || fs.active || fs.web || !!dockbar.front();

  const remote = !!ws.remote;
  for (const tab of ws.tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (!elsewhere && tab.id === session.currentSession() ? " on" : "");
    b.innerHTML = `<i class="dot"></i><span></span><span class="n tokens"></span>`;
    (b.children[0] as HTMLElement).style.background = `var(--dot-${tab.status})`;
    b.dataset.tab = tab.id;
    b.children[1].textContent = tabLabel(ws, tab);
    b.children[2].textContent = tab.tokens ? `~${fmtTokens(tab.tokens)}` : "";
    b.title =
      label(tab.status) +
      (tab.tokens ? t("tab.tokens", { n: fmtTokens(tab.tokens) }) : "") +
      // O modelo só é dito quando é outro que o das irmãs: numa barra em que
      // todas falam com o mesmo, repetir o nome em cada uma não informa nada.
      (tab.choice ? t("tab.model", { model: modelLabel(tab.choice.model, tab.choice.agent) }) : "") +
      t("tab.rename");
    b.addEventListener("click", () => selectTab(ws.id, tab.id));
    if (!remote) {
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        menu.openAt({ x: e.clientX, y: e.clientY }, tabMenu(ws, tab));
      });
    }

    if (ws.tabs.length > 1 && !remote) {
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

  // A aba de Mudanças é sua: ela existe depois que você a abriu, e some no ✕.
  // Worktree sujo não a traz de volta — com o agente editando, o worktree está
  // sujo quase sempre, e uma aba que renasce sozinha é a barra decidindo por
  // você. Que há o que ver está no contador do painel da direita.
  const changes = total(ws.id);
  if (fs.diffTab) {
    const b = document.createElement("button");
    b.className = "tab file" + (fs.diff ? " on" : "");
    b.innerHTML = `${icon("diff", 14)}<span></span><span class="n"></span>`;
    b.children[1].textContent = t("tab.changes");
    b.children[2].textContent = String(changes);
    b.children[2].classList.remove("fresh");
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

  // A aba de navegador existe enquanto você não a fechar: o Run pode cair e
  // subir por baixo dela, e a página continua a mesma.
  if (fs.webTab) {
    const b = document.createElement("button");
    b.className = "tab file" + (fs.web ? " on" : "");
    b.innerHTML = `${icon("globe", 14)}<span></span><span class="n"></span>`;
    b.children[1].textContent = t("tab.browser");
    b.children[2].textContent = fs.port ? `:${fs.port}` : "";
    b.title = t("tab.browser.title", { port: fs.port });
    b.addEventListener("click", () => void showWeb());
    const x = document.createElement("span");
    x.className = "tabx ico sm";
    x.innerHTML = icon("x", 12);
    x.title = t(fs.web ? "tab.browser.closeKey" : "tab.browser.close");
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeWeb();
    });
    b.append(x);
    bar.append(b);
  }

  // Os terminais livres: abas daqui como as outras, porque é onde se digita, e
  // digitar não cabe numa gaveta de 377px. Setup e Run continuam no painel da
  // direita — aquilo é saída para acompanhar de canto.
  if (!remote && !ws.cleaned && !pending(ws)) {
    for (const d of dockbar.tabs()) {
      const b = document.createElement("button");
      b.className = "tab file" + (d.on ? " on" : "");
      b.innerHTML = `${icon("terminal", 14)}<span></span>`;
      b.children[1].textContent = d.label;
      b.title = d.label;
      b.addEventListener("click", () => dockbar.select(d.kind));
      const x = document.createElement("span");
      x.className = "tabx ico sm";
      x.innerHTML = icon("x", 12);
      x.title = t("dock.closeTerm");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        dockbar.closeTab(d.kind);
      });
      b.append(x);
      bar.append(b);
    }
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

  // Conversa nova é no worktree, e o worktree é do dono.
  if (remote) return;
  // O "+" abre conversa com o modelo do workspace, que é o caso de sempre e o
  // que o ⌘T faz. A setinha ao lado abre a lista: é ali que se sai do modelo
  // das irmãs sem ter que abrir outro workspace para isso.
  const add = h("div", "tabadd");
  const plus = document.createElement("button");
  plus.className = "ico";
  plus.innerHTML = icon("plus");
  plus.title = t("tab.new");
  plus.addEventListener("click", () => void newTab());
  const pick = document.createElement("button");
  pick.className = "ico caret";
  pick.innerHTML = icon("chevron-down", 12);
  pick.title = t("tab.new.model");
  pick.addEventListener("click", () => pickModel(pick, ws));
  add.append(plus, pick);
  bar.append(add);
}

/// A lista de modelos do "+": a mesma do lançador, com o do workspace marcado.
/// Escolher abre a conversa já falando com ele. É por aqui que se sai do CLI
/// das irmãs: trocar de modelo dentro de uma conversa (o rodapé da caixa) só
/// anda dentro do CLI que já está de pé, porque o transcript é de um só.
function pickModel(at: HTMLElement, ws: Workspace) {
  const box = at.getBoundingClientRect();
  const blocks = modelGroups();
  const items: menu.Item[] = [];
  blocks.forEach((block, n) => {
    if (n) items.push("sep");
    if (block.head && blocks.length > 1) items.push({ label: block.head, disabled: true });
    for (const [id, name] of block.items) {
      items.push({
        label: name,
        checked: id === ws.model,
        // O esforço do workspace só serve se a escada do modelo escolhido o
        // tiver: sair do Sol para um modelo que para no xhigh cai no xhigh.
        run: () => {
          const agent = agentOf(id);
          void newTab("", { agent, model: id, effort: fitsEffort(id, ws.effort, agent) });
        },
      });
    }
  });
  // Terminal novo mora aqui e não num "+" próprio: são dois botões com o mesmo
  // desenho lado a lado, e o comum — conversa — perderia o clique.
  items.push("sep", { label: t("dock.new"), glyph: icon("terminal", 14), run: dockbar.newTerm });
  menu.openAt({ x: box.left, y: box.bottom + 4 }, items);
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
  if (tab === session.currentSession() && !fs.diff && !fs.active && !fs.web && !dockbar.front()) return;
  const remote = team.isRemote(workspace);
  if (!remote) invoke("focus_tab", { workspace, tab });
  showTerm();
  const epoch = navigation;
  if (!(await session.attach(tab, remote ? workspace : undefined))) return;
  if (!stillHere(epoch, workspace)) return;
  ctx.redraw();
}

/// `choice` é o modelo escolhido na setinha do "+". Sem ele — ⌘T, clique no
/// "+", conversa aberta por um script do dock — a conversa nasce com o do
/// workspace.
export async function newTab(prompt = "", choice: Choice | null = null) {
  const ws = current();
  if (!ws || ws.remote) return;
  const epoch = navigation;
  try {
    const tab = await invoke<{ id: string }>("new_tab", { workspace: ws.id, prompt, choice });
    if (!stillHere(epoch, ws.id)) return;
    showTerm();
    if (!(await session.attach(tab.id))) return;
    if (!stillHere(epoch, ws.id)) return;
    ctx.redraw();
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
  /// A aba de Mudanças está na barra. Como a de navegador, quem a põe lá é
  /// você — pela lista da direita ou pelo Revisar.
  diffTab: boolean;
  /// A aba de navegador: `webTab` é ela estar na barra, `web` é estar no centro.
  web: boolean;
  webTab: boolean;
  port: number;
};
const filesOf = new Map<string, Files>();

function files(id: string): Files {
  let f = filesOf.get(id);
  if (!f) filesOf.set(id, (f = { open: [], active: null, diff: false, diffTab: false, web: false, webTab: false, port: 0 }));
  return f;
}

/// Workspace removido leva junto o que era só dele. Sem isto, cada
/// mapa aqui guardava para sempre o estado de tela de coisas que não existem.
export function forget(alive: Set<string>) {
  for (const [id, f] of filesOf) if (!alive.has(id) && f.webTab) browser.close(id);
  diff.pruneSeen(alive);
  changesUi.forget(alive);
  for (const map of [filesOf, branchOf] as Map<string, unknown>[]) {
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
  leaveWeb(files(ws.id));
  center("viewer");
  await viewer.show(ws.id, path);
}

function showTerm() {
  const ws = current();
  if (ws) {
    files(ws.id).active = null;
    files(ws.id).diff = false;
    leaveWeb(files(ws.id));
  }
  center("chatwrap");
}

/// O terminal livre no centro. Quem escolhe qual é o `dockbar`; aqui só sai da
/// frente o que estava.
function showShell() {
  const ws = current();
  if (!ws) return;
  const fs = files(ws.id);
  fs.active = null;
  fs.diff = false;
  leaveWeb(fs);
  center("termview");
  drawTabs(ws);
}

/* ---------- navegador ---------- */

/// Se foi a aba de navegador que recolheu a coluna da direita. Recolhida por
/// você antes, ela continua recolhida depois.
let hidSide = false;

/// A aba de navegador no centro. A coluna da direita recolhe sozinha — a página
/// quer largura — e volta quando você sai da aba, se foi daqui que ela sumiu.
export async function showWeb() {
  const ws = current();
  if (!ws) return;
  const fs = files(ws.id);
  fs.active = null;
  fs.diff = false;
  fs.web = true;
  fs.webTab = true;
  if (!document.body.classList.contains("noside")) {
    document.body.classList.add("noside");
    hidSide = true;
  }
  center("webview");
  try {
    fs.port = await browser.show(ws.id);
  } catch (err) {
    ctx.say(fromBack(err), true);
    fs.webTab = false;
    showTerm();
  }
  drawTabs(ws);
}

/// A aba de navegador sai do centro: a webview some e a coluna da direita
/// volta, se foi ela que a recolheu.
function leaveWeb(fs: Files) {
  if (!fs.web) return;
  fs.web = false;
  browser.hide();
  if (hidSide) {
    document.body.classList.remove("noside");
    hidSide = false;
  }
}

/// Fechar a aba é destruir a webview — aba fechada não guarda página. Como na
/// de Mudanças, `web` fica ligado até o `showTerm` da vez desligar: é ele que
/// faz o `selectTab` entender que a tela precisa trocar.
async function closeWeb() {
  const ws = current();
  if (!ws) return;
  const fs = files(ws.id);
  const wasOpen = fs.web;
  fs.webTab = false;
  browser.close(ws.id);
  if (wasOpen) {
    const tab = session.currentSession();
    if (tab) await selectTab(ws.id, tab);
    else showTerm();
  }
  drawTabs(ws);
}

/// O painel de Git controla a seleção; workspace mantém o lifecycle da aba.
function showChanges() { changesUi.show(); }

function activateChanges() {
  const ws = current();
  if (!ws || !diffable(ws)) return;
  const fs = files(ws.id);
  fs.active = null;
  fs.diff = true;
  fs.diffTab = true;
  leaveWeb(fs);
  center("diffview");
  setSidePane("diff");
  drawTabs(ws);
}

/// Fechar a aba de Mudanças é tirá-la da barra, não só sair da tela: uma aba que
/// fica depois do x não foi fechada. Ela volta quando você abre o diff de novo
/// pela lista da direita ou pelo Revisar — e só assim.
async function closeChanges() {
  const ws = current();
  if (!ws) return;
  const fs = files(ws.id);
  const wasOpen = fs.diff;
  fs.diffTab = false;
  // `diff` fica ligado até o `showTerm` da vez desligar: é ele que faz o
  // `selectTab` entender que a tela precisa trocar.
  if (wasOpen) {
    const tab = session.currentSession();
    if (tab) await selectTab(ws.id, tab);
    else showTerm();
  }
  drawTabs(ws);
}

/// Uma coisa por vez no centro: a conversa, um arquivo, o diff, o navegador ou
/// um terminal. Sair do dock não mata nada — o processo segue, e a aba só
/// deixa de estar na frente.
function center(show: "chatwrap" | "viewer" | "diffview" | "webview" | "termview") {
  for (const id of ["chatwrap", "viewer", "diffview", "webview", "termview"] as const) $(id).hidden = id !== show;
  if (show !== "termview") dockbar.leave();
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
  if (fs.web) {
    closeWeb();
    return true;
  }
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

const total = changesUi.count;
const WATCH_EVERY = 5_000;
const reloadChanges = debounce(250, (id: string) => void loadChanges(id));
let request = 0;

async function loadChanges(id: string) {
  const mine = ++request;
  try {
    const repos = await invoke<GitStatus[]>("workspace_git_status", { id });
    if (mine !== request || openWs !== id) return;
    changesUi.update(id, repos);
    const n = total(id);
    $("review").hidden = !repos.some(repo => repo.has_head);
    $("diffcount").textContent = n ? String(n) : "";
    $("diffcount").classList.remove("fresh");
    const ws = current();
    if (ws?.id !== id) return;
    drawTabs(ws);
    paintPr(ws);
  } catch (error) {
    if (mine === request && openWs === id) changesUi.fail(id, error);
  }
}

export function fileSaved(id: string) {
  const ws = current();
  if (ws?.id === id && diffable(ws)) reloadChanges(id);
}

function outstanding(id: string): { dirty: number; unpushed: number } | null {
  const repos = changesUi.statuses(id);
  if (!repos || repos.some(repo => repo.error)) return null;
  return {
    dirty: repos.reduce((n, repo) => n + new Set([...repo.staged, ...repo.changes, ...repo.conflicts].map(file => file.path)).size, 0),
    unpushed: repos.reduce((n, repo) => n + (repo.upstream ? repo.ahead : Number(repo.has_head)), 0),
  };
}

/// Abre no viewer um arquivo que veio do diff. O caminho do diff é relativo ao
/// worktree do repositório dele, e o viewer parte do worktree do workspace —
/// que, com mais de um repositório, é a pasta que reúne todos. A diferença
/// entre os dois é o pedaço que falta na frente.
function openChange(repo: string, path: string) {
  const ws = current();
  if (!ws) return;
  const root = ws.worktree;
  const mine = ws.repos.find((r) => r.name === repo)?.worktree ?? root;
  const under = mine.startsWith(`${root}/`) ? `${mine.slice(root.length + 1)}/` : "";
  void openFile(`${under}${path}`);
}

/* ---------- painel da direita ---------- */

type Pane = "files" | "diff" | "comments";
let sidePane: Pane = "files";

function setSidePane(pane: Pane) {
  sidePane = pane;
  $("tab-files").classList.toggle("on", pane === "files");
  $("tab-diff").classList.toggle("on", pane === "diff");
  $("tab-comments").classList.toggle("on", pane === "comments");
  $("tree").hidden = pane !== "files";
  $("difflist").hidden = pane !== "diff";
  $("comments").hidden = pane !== "comments";
  $("side").classList.toggle("comments-open", pane === "comments");
  if (pane === "files") tree.redraw();
  if (pane === "comments") notes.draw();
}

function openComments() {
  document.body.classList.remove("noside");
  setSidePane("comments");
}

/// ⌘⇧M: comentário citando o que está selecionado na conversa.
export function quoteSelection(): boolean {
  if (!openWs) return false;
  return session.quoteSelection();
}

export const comment = (target: notes.Target) => notes.compose(target);

/// Levar até um comentário — de onde a caixa "Para mim" leva.
export function showNote(id: string) {
  if (!openWs) return;
  showTerm();
  notes.openThread(id);
}
