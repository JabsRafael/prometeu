import { invoke } from "@tauri-apps/api/core";
import * as sidebar from "./sidebar";
import * as browser from "./browser";
import * as diff from "./diff";
import * as dockbar from "./dockbar";
import { avatar, icon, stageIcon, wave } from "./icons";
import { fromBack, stage as stageName, t, tn } from "./i18n";
import * as menu from "./menu";
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
  repoLabel,
  stateLabel,
  statusOf,
  type Board,
  type Change,
  type RepoDiff,
  type Tab,
  type Workspace,
} from "./types";
import { $, debounce, h } from "./util";
import * as viewer from "./viewer";

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
};

let ctx: Ctx;
let openWs: string | null = null;

export const id = () => openWs;
const current = () => ctx.board().workspaces.find((w) => w.id === openWs);

export function init(context: Ctx) {
  ctx = context;

  tree.init({ openFile, workspace: id });
  dockbar.init({ workspace: id, say: ctx.say, openFile, newTab, openBrowser: showWeb });
  browser.init((id) => invoke("open_run", { id }).catch((e) => ctx.say(fromBack(e), true)), ctx.say);

  $("tab-files").addEventListener("click", () => setSidePane("files"));
  $("tab-diff").addEventListener("click", () => {
    // Já no painel de Mudanças, clicar de novo traz o diff para o centro. É o
    // caminho de volta depois de fechar a aba — sem ele, quem fechou só voltaria
    // clicando num arquivo da lista.
    const changes = openWs ? total(openWs) : 0;
    if (sidePane === "diff" && changes) showChanges();
    else setSidePane("diff");
  });
  // Revisar é ler o diff inteiro de uma vez, no centro — o mesmo caminho do
  // segundo clique na aba de Mudanças, dito com todas as letras.
  $("review").innerHTML = `${icon("eye", 13)}<span></span>`;
  $("review").querySelector("span")!.textContent = t("side.review");
  $("review").addEventListener("click", () => {
    setSidePane("diff");
    showChanges();
  });
  $("reveal").addEventListener("click", () => {
    if (openWs) invoke("reveal", { id: openWs }).catch((e) => ctx.say(fromBack(e), true));
  });
  $("dfold").addEventListener("click", () => {
    if (!openWs) return;
    diff.foldAll(diff.keys(visible(openWs)));
    drawChanges(openWs);
  });
  // Visto em tudo: leu, marcou, e o que o agente mudar depois é o que volta a
  // contar na aba.
  $("dseen").addEventListener("click", () => {
    if (!openWs) return;
    diff.seeAll(openWs, changesOf.get(openWs) ?? []);
    diff.invalidate();
    seenChanged(openWs);
    drawChanges(openWs);
  });

  // A onda do painel de "montando" é desenhada uma vez: ela não muda, e o
  // `draw` roda a cada atualização dos workspaces.
  $("offwave").innerHTML = wave(22);

  $("pr").innerHTML = `${icon("git-pull-request", 14)}<span></span>`;
  $("pr").querySelector("span")!.textContent = t("ws.pr");
  // Um botão só, três estados: com o PR mergeado ele conclui em vez de pedir
  // mais commit. Quem decide é o estado do PR na hora do clique.
  $("pr").addEventListener("click", () => {
    const ws = current();
    if (!ws) return;
    if (merged(ws)) finish(ws.id);
    else void openPr();
  });

  // Duplo clique renomeia, como no nome do workspace na migalha. Escuta na barra
  // e não no botão: o primeiro clique troca de aba, a troca refaz a barra, e o
  // botão em que o gesto começou já não existe quando o duplo clique chega.
  $("tabbar").addEventListener("dblclick", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".tab[data-tab]");
    if (b?.dataset.tab && !current()?.remote) editTab(b.dataset.tab);
  });
}

/* ---------- entrar e sair ---------- */

export async function open(ws: Workspace) {
  // Ir de um workspace a outro não passa pelo `leave`: sem isto, a webview do
  // que ficou para trás continuaria por cima do que você abriu.
  browser.hide();
  const first = ws.tabs.find((t) => t.id === ws.active) ?? ws.tabs[0];
  sidebar.setOpen((openWs = ws.id));
  $("wsView").hidden = false;
  $("wsctl").hidden = false;
  // Workspace de um colega: nada dele está neste disco — sem arquivos, sem
  // dock, sem novidade para marcar no back. É a conversa, e só — com as notas
  // dentro dela.
  if (ws.remote) {
    showTerm();
    if (first) await session.attach(first.id, ws.id);
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
    session.detach();
    showTerm();
    draw();
    return;
  }
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
  if (fs.web) await showWeb();
  else if (fs.diff) showChanges();
  else if (fs.active) await showFile();
  else showTerm();
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
  if (first) void session.attach(first.id).then(() => ctx.redraw());
}

export function leave() {
  team.detach();
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
  crumb.innerHTML =
    `${avatar(owner ?? ws.repo_name)}<span></span><span class="sep">${icon("chevron-right", 12)}</span><span></span>` +
    `<button class="branch" hidden>${icon("git-branch", 12)}<span></span></button>`;
  crumb.children[1].textContent = owner ?? repoLabel(ws);
  const name = crumb.children[3] as HTMLElement;
  name.textContent = ws.title;
  if (!remote) {
    // Na migalha não tem lápis: nada ali é clicável, então o duplo clique é livre.
    name.title = t("ws.rename");
    name.addEventListener("dblclick", () =>
      rename.start(name, ws.title, (title) => renameWorkspace(ws.id, title), "crumb"),
    );
  }

  // O cabeçalho usa o mesmo `stateLabel` da barra lateral: montando não
  // tem ponto de status porque não tem aba de onde ele sairia.
  const chip = $("wsstatus");
  chip.className = "chip" + (pending(ws) ? (ws.failed ? " failed" : "") : ` s-${statusOf(ws)}`);
  chip.innerHTML = pending(ws) ? (ws.failed ? "" : wave(12)) : `<i class="dot"></i>`;
  chip.append(stateLabel(ws));

  // A etapa é o mesmo submenu do botão direito, ancorado no botão: um lugar só
  // para escolher, esteja você na lista lateral ou dentro da conversa.
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

  drawTabs(ws);
  const tab = ws.tabs.find((t) => t.id === session.currentSession());
  drawShare(ws, tab);
  // A caixa de escrever diz o estado da aba: desligada, de um colega offline.
  session.refresh();

  if (remote) {
    // A branch é a que o dono contou; não há git aqui para perguntar. E o PR,
    // o diff, a árvore e o dock são do disco dele — nada disso existe aqui.
    // Sobra a conversa, e as notas dentro dela; quem diz que ele está offline
    // é a caixa de escrever.
    paintBranchName(ws.branch);
    $("pr").hidden = true;
    $("prlinks").hidden = true;
    $("offline").hidden = true;
    $("tabbar").hidden = false;
    $("side").hidden = true;
    $("sidetoggle").hidden = true;
    $("wsstage").hidden = true;
    $("dock").hidden = true;
    return;
  }

  // Montando, ou montagem que não deu. Não existe pasta, então não existe
  // arquivo, diff, dock nem aba — e oferecer qualquer um deles seria oferecer
  // um caminho que erra. Sobra o painel, que é o que há para dizer.
  if (pending(ws)) {
    paintBranchName(ws.branch);
    $("pr").hidden = true;
    $("prlinks").hidden = true;
    $("dock").hidden = true;
    $("tabbar").hidden = true;
    $("side").hidden = true;
    $("sidetoggle").hidden = true;
    $("wsstage").hidden = true;
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

  $("pr").hidden = false;
  $("tab-files").hidden = false;
  $("tab-diff").hidden = false;
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
  $("wsstage").hidden = ws.cleaned;
}

/// O botão de compartilhar e os chips de quem está olhando a conversa aberta.
/// Só há botão com time, e só em workspace seu: o de um colega já é dele. O
/// clique abre a lista: o time inteiro, ou cada colega — e é o relay que faz a
/// escolha valer, não a tela.
function drawShare(ws: Workspace, tab?: Tab) {
  const btn = $("share") as HTMLButtonElement;
  const chips = $("watchers");
  chips.replaceChildren();
  if (ws.remote || ws.cleaned || !team.status().config) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.className = "ghost md" + (ws.shared ? " on" : "");
  btn.innerHTML = `${icon("share-2", 14)}<span></span>`;
  btn.querySelector("span")!.textContent = shareLabel(ws);
  btn.title = t(ws.shared ? "share.off.title" : "share.on.title");
  btn.onclick = () => {
    const at = btn.getBoundingClientRect();
    menu.openAt({ x: at.left, y: at.bottom + 4 }, shareItems(ws));
  };
  if (!ws.shared || !tab) return;
  for (const name of team.watchersOf(tab.id)) {
    const c = h("span", "chip watcher", `${avatar(name)}<span class="nm"></span>`);
    c.querySelector(".nm")!.textContent = name;
    c.title = t("share.watching", { name });
    chips.append(c);
  }
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
  const tab = ws.tabs.find((t) => t.id === session.currentSession()) ?? ws.tabs[0];
  if (!tab) return;
  try {
    const prompt = await invoke<string>("pr_prompt", { id: ws.id });
    await invoke("chat_send", { session: tab.id, text: prompt });
    // O pedido foi para a conversa; a tela vai atrás dele.
    if (tab.id !== session.currentSession()) await session.attach(tab.id);
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
  ask.hidden = ws.cleaned;
  ask.querySelector("span")!.textContent = done ? t("ws.finish") : all.length ? t("ws.pr.update") : t("ws.pr");
  ask.title = done ? t("top.finish") : all.length ? t("top.pr.update") : t("top.pr");
  ask.classList.toggle("done", done);
  ask.firstElementChild!.outerHTML = icon(done ? "check" : "git-pull-request", 14);

  // Um link por PR — um por repositório que tem o seu. Só o número e a seta:
  // quem diz "PR" é o botão ao lado, e dois botões com o mesmo rótulo na mesma
  // barra é o que fazia a barra ficar ambígua. Com mais de um repo, o nome
  // dele vai no title.
  const links = $("prlinks");
  links.hidden = !all.length;
  links.replaceChildren(
    ...all.map(({ repo, pr }) => {
      const b = document.createElement("button");
      b.className = "ghost md";
      b.innerHTML = `<span></span>${icon("external-link", 12)}`;
      b.children[0].textContent = `#${pr.number}`;
      const what = t(pr.state === "MERGED" ? "ws.pr.merged" : pr.isDraft ? "ws.pr.draft" : "ws.pr.view", { n: pr.number, title: pr.title });
      b.title = ws.repos.length > 1 ? `${repo} · ${what}` : what;
      b.addEventListener("click", () => {
        invoke("open_pr", { id: ws.id, repo }).catch((e) => ctx.say(fromBack(e), true));
      });
      return b;
    }),
  );
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

/// Abas sublinhadas: uma por conversa, a de Mudanças, depois uma por arquivo
/// aberto, e o + logo depois da última.
function drawTabs(ws: Workspace) {
  // Refazer a barra com um campo de renomear aberto nela apaga o que foi
  // digitado — e o diff, que redesenha sozinho, chega aqui a toda hora.
  if (rename.editing()) return;
  const bar = $("tabbar");
  bar.replaceChildren();
  const fs = files(ws.id);
  const elsewhere = fs.diff || fs.active || fs.web;

  const remote = !!ws.remote;
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

  // A aba de Mudanças existe enquanto houver o que mostrar e você não a tiver
  // fechado — ou enquanto ela estiver aberta, para o worktree ficar limpo sem a
  // tela sumir debaixo de você.
  const changes = total(ws.id);
  if (fs.diff || (changes && !fs.hidDiff)) {
    const b = document.createElement("button");
    b.className = "tab file" + (fs.diff ? " on" : "");
    b.innerHTML = `${icon("diff", 14)}<span></span><span class="n"></span>`;
    b.children[1].textContent = t("tab.changes");
    const fresh = unseen(ws.id);
    b.children[2].textContent = fresh ? String(fresh) : "";
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
  if (tab === session.currentSession() && !fs.diff && !fs.active && !fs.web) return;
  const remote = team.isRemote(workspace);
  if (!remote) invoke("focus_tab", { workspace, tab });
  showTerm();
  await session.attach(tab, remote ? workspace : undefined);
  draw();
}

export async function newTab(prompt = "") {
  const ws = current();
  if (!ws || ws.remote) return;
  try {
    const tab = await invoke<{ id: string }>("new_tab", { workspace: ws.id, prompt });
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
  /// A aba de navegador: `webTab` é ela estar na barra, `web` é estar no centro.
  web: boolean;
  webTab: boolean;
  port: number;
};
const filesOf = new Map<string, Files>();

function files(id: string): Files {
  let f = filesOf.get(id);
  if (!f) filesOf.set(id, (f = { open: [], active: null, diff: false, hidDiff: false, web: false, webTab: false, port: 0 }));
  return f;
}

/// Workspace removido leva junto o que era só dele. Sem isto, cada
/// mapa aqui guardava para sempre o estado de tela de coisas que não existem.
export function forget(alive: Set<string>) {
  for (const [id, f] of filesOf) if (!alive.has(id) && f.webTab) browser.close(id);
  diff.pruneSeen(alive);
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

/// Tela de mudanças. `focus` vem do clique na lista da direita: é a mesma tela,
/// só rolada até aquele arquivo.
function showChanges(focus?: string) {
  const ws = current();
  if (!ws) return;
  const fs = files(ws.id);
  fs.active = null;
  fs.diff = true;
  fs.hidDiff = false;
  leaveWeb(fs);
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

function center(show: "chatwrap" | "viewer" | "diffview" | "webview") {
  for (const id of ["chatwrap", "viewer", "diffview", "webview"] as const) $(id).hidden = id !== show;
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

const changesOf = new Map<string, RepoDiff[]>();
/// Quantos arquivos mudaram, e quantos você ainda não leu — é o segundo que a
/// aba conta: o que interessa em acompanhar o agente é o que é novo para você.
const total = (id: string) => diff.keys(changesOf.get(id) ?? []).length;
const unseen = (id: string) => diff.unseen(id, changesOf.get(id) ?? []);

/// Só o que está fora de commit. É o chip no topo da lista, e vale para a
/// lista e para o centro.
let onlyDirty = false;

/// O que a tela mostra: tudo, ou só o que está fora de commit.
function visible(id: string): RepoDiff[] {
  const repos = changesOf.get(id) ?? [];
  return onlyDirty ? repos.map((r) => ({ ...r, files: r.files.filter((f) => f.dirty) })) : repos;
}

/// Cada chamada é um `git diff` por repositório no back, e quem pede é o
/// evento do quadro — que chega a cada ferramenta que o agente usa. Juntar as
/// rajadas aqui é o que separa "o diff acompanha sozinho" de "a tela trava
/// enquanto o agente trabalha".
const reloadChanges = debounce(250, (id: string) => void loadChanges(id));

/// Descarta resposta de pedido velho: dois `workspace_diff` no ar podem voltar
/// fora de ordem, e o antigo sobrescreveria o novo.
let request = 0;

async function loadChanges(id: string) {
  const mine = ++request;
  const repos = await invoke<RepoDiff[]>("workspace_diff", { id });
  if (mine !== request) return;
  changesOf.set(id, repos);
  const n = total(id);
  $("review").hidden = !n;
  // Branch limpa esquece que a aba foi fechada: o que sujar depois é trabalho
  // novo, e não o diff que você mandou embora.
  if (!n) files(id).hidDiff = false;
  drawList(id);

  const ws = current();
  if (ws?.id !== id) return;
  drawTabs(ws); // a aba de Mudanças aparece, some e conta junto com a lista
  if (files(id).diff) drawChanges(id);
}

/// Você marcou (ou desmarcou) um arquivo como visto: a lista e a aba contam
/// de novo. O centro já se pintou sozinho.
function seenChanged(id: string) {
  drawList(id);
  const ws = current();
  if (ws?.id === id) drawTabs(ws);
}

/// A lista da direita: o resumo no topo, e um arquivo por linha — em seção
/// por repositório quando há mais de um. Redesenhada a cada resposta do back
/// e a cada "visto", que muda o que a linha mostra.
function drawList(id: string) {
  const all = changesOf.get(id) ?? [];
  const repos = visible(id);
  const fresh = unseen(id);
  $("diffcount").textContent = fresh ? String(fresh) : "";

  const list = $("difflist");
  if (!diff.keys(all).length) {
    list.replaceChildren(nothing(t("diff.clean")));
    return;
  }
  const multi = all.length > 1;
  const rows = repos.flatMap((r) => {
    if (!r.files.length) return [];
    const rows = r.files.map((f) => diffRow(id, r.name, f));
    if (!multi) return rows;
    const k = `${id}/${r.name}`;
    for (const row of rows) {
      row.classList.add("in");
      row.hidden = shutRepos.has(k);
    }
    return [repoRow(k, r, rows), ...rows];
  });
  if (!diff.keys(repos).length) rows.push(nothing(t("diff.clean.filtered")));
  list.replaceChildren(summary(id, all), ...rows);
}

function nothing(text: string): HTMLElement {
  const none = document.createElement("div");
  none.className = "none";
  none.textContent = text;
  return none;
}

/// O resumo no topo da lista: quantos commits além da base, e o chip do que
/// está fora de commit — que também é o filtro.
function summary(id: string, repos: RepoDiff[]): HTMLElement {
  const box = h("div", "diffsum", `<span class="ahead"></span><button class="dirtyf"></button>`);
  const ahead = repos.reduce((n, r) => n + r.ahead, 0);
  const dirty = repos.reduce((n, r) => n + r.dirty, 0);
  // Com um repo a base tem nome; com mais de um, cada um tem a sua, e ela fica
  // no cabeçalho do repo.
  box.children[0].textContent =
    repos.length === 1 && repos[0].base ? tn(ahead, "diff.ahead", { base: repos[0].base }) : tn(ahead, "diff.commits");
  const chip = box.children[1] as HTMLElement;
  chip.hidden = !dirty && !onlyDirty;
  chip.innerHTML = `<span class="dot"></span><span></span>`;
  chip.children[1].textContent = t("diff.uncommitted", { n: dirty });
  chip.classList.toggle("on", onlyDirty);
  chip.title = t(onlyDirty ? "diff.onlyDirty" : "diff.onlyDirty.off");
  chip.addEventListener("click", () => {
    onlyDirty = !onlyDirty;
    drawList(id);
    if (files(id).diff) drawChanges(id);
  });
  return box;
}

/// Uma linha da lista: o índice da tela do centro — clicar rola até o arquivo.
/// O ponto é pedaço fora de commit; o check da ponta é "visto".
function diffRow(id: string, repo: string, f: Change): HTMLElement {
  const row = document.createElement("button");
  const seen = diff.isSeen(id, repo, f);
  row.className = "diffrow" + (seen ? " seen" : "");
  row.title = f.path;
  // O nome do arquivo em primeiro plano e a pasta atrás dele, como no
  // Conductor: numa lista de vinte arquivos é o nome que se procura.
  const cut = f.path.lastIndexOf("/");
  row.innerHTML =
    `<span class="p"><span class="dir"></span><span class="base"></span></span>` +
    `<span class="new"></span><span class="dot"></span><span class="a"></span><span class="r"></span><span class="chk"></span>`;
  row.querySelector(".dir")!.textContent = cut === -1 ? "" : f.path.slice(0, cut + 1);
  row.querySelector(".base")!.textContent = f.path.slice(cut + 1);
  row.children[1].textContent = f.new_file ? t("diff.new") : f.deleted ? t("diff.deleted") : "";
  const dot = row.children[2] as HTMLElement;
  dot.hidden = !f.dirty;
  dot.title = t("diff.dirty");
  row.children[3].textContent = f.added ? `+${f.added}` : "";
  row.children[4].textContent = f.removed ? `−${f.removed}` : "";
  row.children[5].innerHTML = seen ? icon("check", 13) : "";
  row.addEventListener("click", () => showChanges(diff.key(repo, f.path)));
  return row;
}

/// Quais repositórios estão recolhidos na lista. Sobrevive ao redesenho, que
/// chega a cada ferramenta que o agente usa — senão recolher não recolheria.
const shutRepos = new Set<string>();

/// O cabeçalho de um repositório na lista: nome, quantos arquivos, a soma; de
/// onde a branch saiu fica no title. Clique recolhe os arquivos dele.
function repoRow(k: string, r: RepoDiff, rows: HTMLElement[]): HTMLElement {
  const row = document.createElement("button");
  row.className = "diffrepo";
  row.title = r.base ? tn(r.ahead, "diff.ahead", { base: r.base }) : tn(r.ahead, "diff.commits");
  row.innerHTML = `<span class="tw"></span><span class="nm"></span><span class="cnt"></span><span class="a"></span><span class="r"></span>`;
  row.children[1].textContent = r.name;
  row.children[2].textContent = tn(r.files.length, "diff.files");
  const added = diff.sum(r.files, "added");
  const removed = diff.sum(r.files, "removed");
  row.children[3].textContent = added ? `+${added}` : "";
  row.children[4].textContent = removed ? `−${removed}` : "";
  const glyph = () => {
    row.children[0].innerHTML = icon(shutRepos.has(k) ? "chevron-right" : "chevron-down", 14);
  };
  row.addEventListener("click", () => {
    shutRepos.has(k) ? shutRepos.delete(k) : shutRepos.add(k);
    for (const f of rows) f.hidden = shutRepos.has(k);
    glyph();
  });
  glyph();
  return row;
}

/// Resumo na barra e o diff empilhado embaixo. Redesenhar é barato: a tela só é
/// refeita quando algum patch mudou de verdade.
function drawChanges(id: string, focus?: string) {
  const all = changesOf.get(id) ?? [];
  const repos = visible(id);
  const shown = repos.flatMap((r) => r.files);
  const added = diff.sum(shown, "added");
  const removed = diff.sum(shown, "removed");

  const crumb = $("dcrumb");
  crumb.innerHTML = `${icon("diff", 14)}<span class="nm"></span><span class="a"></span><span class="r"></span>`;
  const ahead = all.reduce((n, r) => n + r.ahead, 0);
  const head = all.length === 1 && all[0].base ? tn(ahead, "diff.ahead", { base: all[0].base }) : tn(ahead, "diff.commits");
  crumb.children[1].textContent = `${head} · ${tn(shown.length, "diff.files")}`;
  crumb.children[2].textContent = added ? `+${added}` : "";
  crumb.children[3].textContent = removed ? `−${removed}` : "";

  diff.render($("dlist"), {
    id,
    repos,
    focus,
    empty: t(onlyDirty ? "diff.clean.filtered" : "diff.clean.long"),
    onSeen: () => seenChanged(id),
  });
}

/* ---------- painel da direita ---------- */

type Pane = "files" | "diff";
let sidePane: Pane = "files";

function setSidePane(pane: Pane) {
  sidePane = pane;
  $("tab-files").classList.toggle("on", pane === "files");
  $("tab-diff").classList.toggle("on", pane === "diff");
  $("tree").hidden = pane !== "files";
  $("difflist").hidden = pane !== "diff";
  if (pane === "files") tree.redraw();
}

/// ⌘⇧M: nota citando o que está selecionado na conversa. A caixa de escrever
/// vira nota, já com a citação.
export function quoteSelection(): boolean {
  if (!openWs) return false;
  return session.quoteSelection();
}

/// Levar até uma nota — de onde a caixa "Para mim" leva.
export function showNote(id: string) {
  if (!openWs) return;
  showTerm();
  session.focusNote(id);
}
