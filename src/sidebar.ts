import { avatar, icon, stageIcon } from "./icons";
import { stage as stageName, t } from "./i18n";
import * as menu from "./menu";
import * as team from "./team";
import * as rename from "./rename";
import { hasWorktree, stateLabel, statusOf, type Board, type Workspace } from "./types";
import { h } from "./util";

/// Ações disponíveis na lista lateral e no menu de um workspace.
export type Hooks = {
  /// A caixa "Para mim": as notas do time que marcaram você.
  inbox: () => void;
  open: (ws: Workspace) => void;
  setStage: (id: string, stage: string) => void;
  /// Remove o workspace de vez — o worktree e a branch ficam, a referência não.
  drop: (id: string) => void;
  /// `title` nulo é desistência: só devolve a linha ao normal.
  rename: (id: string, title: string | null) => void;
  archive: (id: string, archived: boolean) => void;
  /// Concluir: a última etapa e o arquivo, num gesto só. É o que se faz quando
  /// o PR entrou.
  finish: (id: string) => void;
  /// Abre a folha que devolve worktrees ao disco.
  cleanup: () => void;
  pin: (id: string, pinned: boolean) => void;
  unread: (id: string, unread: boolean) => void;
  reveal: (id: string) => void;
  copyPath: (ws: Workspace) => void;
  toIssues: () => void;
  toArchived: () => void;
  /// Quantas issues a aba tem para mostrar — `null` é "sem Linear", e o
  /// número some.
  issues: () => number | null;
  addProject: () => void;
  newWorkspace: (projectId?: string) => void;
};

/// O que fica "aberto" quando a tela é a de issues: nenhum workspace.
/// Não colide com id de workspace nenhum.
export const ISSUES = "@issues";
/// A tela dos arquivados, pela mesma regra.
export const ARCHIVED = "@arquivados";

let openId: string | null = null;
export function setOpen(id: string | null) {
  openId = id;
}

export function render(board: Board, hooks: Hooks) {
  renderRail(board, hooks);
}

const el = (id: string) => document.getElementById(id)!;

/* ---------- renomear e menu ---------- */

/// Tudo que se faz com um workspace, num lugar só. A etapa entra aqui como
/// propriedade e pode ser escolhida sem abrir a conversa.
function wsMenu(ws: Workspace, board: Board, hooks: Hooks, label: HTMLElement, kind: string): menu.Item[] {
  const total = board.stages.length;
  const at = board.stages.indexOf(ws.stage);
  return [
    ws.unread
      ? { label: t("ws.menu.read"), glyph: icon("mail-open"), run: () => hooks.unread(ws.id, false) }
      : { label: t("ws.menu.unread"), glyph: icon("mail"), run: () => hooks.unread(ws.id, true) },
    ws.pinned
      ? { label: t("ws.menu.unpin"), glyph: icon("pin-off"), run: () => hooks.pin(ws.id, false) }
      : { label: t("ws.menu.pin"), glyph: icon("pin"), run: () => hooks.pin(ws.id, true) },
    {
      label: t("ws.menu.stage"),
      glyph: stageIcon(at, total),
      sub: board.stages.map((name, i) => ({
        label: stageName(name),
        glyph: stageIcon(i, total),
        checked: name === ws.stage,
        run: () => hooks.setStage(ws.id, name),
      })),
    },
    {
      label: t("ws.menu.rename"),
      glyph: icon("pencil"),
      run: () => rename.start(label, ws.title, (title) => hooks.rename(ws.id, title), kind),
    },
    { label: t("ws.menu.copyPath"), glyph: icon("copy"), run: () => hooks.copyPath(ws) },
    { label: t("ws.menu.reveal"), glyph: icon("external-link"), run: () => hooks.reveal(ws.id) },
    "sep",
    // Concluir só existe enquanto há o que concluir: no arquivado o gesto já
    // aconteceu.
    ...(ws.archived
      ? []
      : [{ label: t("ws.menu.finish"), glyph: icon("check"), run: () => hooks.finish(ws.id) } as menu.Item]),
    ...(hasWorktree(ws)
      ? [{ label: t("ws.menu.cleanup"), glyph: icon("trash"), run: () => hooks.cleanup() } as menu.Item]
      : []),
    ws.archived
      ? {
          label: t("ws.menu.unarchive"),
          glyph: icon("archive-restore"),
          // Worktree devolvido: não há para onde desarquivar. O card fica como
          // histórico, e dizer isso é melhor que um item que não faz nada.
          disabled: ws.cleaned,
          hint: ws.cleaned ? t("ws.menu.gone") : undefined,
          run: () => hooks.archive(ws.id, false),
        }
      : {
          label: t("ws.menu.archive"),
          glyph: icon("archive"),
          // O atalho só vale para o workspace aberto; escrever nos outros mentiria.
          hint: ws.id === openId ? "⌘⇧A" : undefined,
          run: () => hooks.archive(ws.id, true),
        },
    {
      label: t("ws.menu.drop"),
      glyph: icon("x"),
      danger: true,
      run: () => hooks.drop(ws.id),
    },
  ];
}

export function attachMenu(node: HTMLElement, ws: Workspace, board: Board, hooks: Hooks, label: HTMLElement, kind: string) {
  node.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu.openAt({ x: e.clientX, y: e.clientY }, wsMenu(ws, board, hooks, label, kind));
  });
}

/* ---------- sidebar: Criar · Issues · workspaces por projeto ---------- */

/// Grupo recolhido gruda: quem não olha "Feito" hoje não olha amanhã.
const FOLD = "prometheus:grupo:";
const folded = (name: string) => localStorage.getItem(FOLD + name) === "1";

function renderRail(board: Board, hooks: Hooks) {
  const rail = el("railbody");
  rail.replaceChildren();
  const live = board.workspaces.filter((w) => !w.archived && !w.remote);

  rail.append(h("div", "navitem brand", `${icon("flame")}<span>Prometheus</span>`));

  const create = h("button", "navitem", `${icon("plus")}<span></span>`);
  create.children[1].textContent = t("rail.create");
  create.title = t("rail.create.title");
  create.addEventListener("click", () => hooks.newWorkspace());
  rail.append(create);

  // As issues no seu nome, do Linear. É a tela inicial: de onde o trabalho sai.
  const issues = h(
    "button",
    "navitem" + (openId === ISSUES ? " on" : ""),
    `${icon("inbox")}<span></span><span class="n"></span>`,
  );
  issues.children[1].textContent = t("rail.issues");
  const n = hooks.issues();
  issues.querySelector(".n")!.textContent = n === null ? "" : String(n);
  issues.title = n === null ? t("rail.issues.off") : t("rail.issues.title");
  issues.addEventListener("click", hooks.toIssues);
  rail.append(issues);

  // Alguém do time te marcou numa nota: é o único lugar da tela que espera
  // resposta sua e não está dentro de uma sessão.
  const waiting = team.inboxCount();
  if (waiting) {
    const mine = h("button", "navitem mentions", `${icon("at-sign")}<span></span><span class="n"></span>`);
    mine.children[1].textContent = t("inbox.title");
    mine.querySelector(".n")!.textContent = String(waiting);
    mine.addEventListener("click", hooks.inbox);
    rail.append(mine);
  }
  rail.append(document.createElement("hr"));

  // Fixado sobe para o topo e sai do grupo do projeto: aparecer duas vezes na
  // mesma lista não ajuda ninguém.
  const pinned = live.filter((w) => w.pinned);
  if (pinned.length) {
    renderGroup(rail, board, hooks, t("rail.pinned"), icon("pin", 14), pinned, "@fixados", { avatars: true });
  }

  // O que os colegas compartilharam. Antes dos projetos: não é de projeto
  // nenhum daqui, e é o que muda sem você fazer nada.
  const shared = board.workspaces.filter((w) => w.remote);
  if (shared.length) {
    renderGroup(rail, board, hooks, t("rail.team"), icon("users", 14), shared, "@time", { avatars: true });
  }

  const sect = h("div", "sect", `<span></span>`);
  sect.children[0].textContent = t("rail.projects");
  const add = h("button", "ico sm", icon("folder-plus"));
  add.title = t("rail.addProject");
  add.addEventListener("click", hooks.addProject);
  sect.append(add);
  rail.append(sect);

  if (!board.projects.length) {
    rail.append(h("div", "railhint", t("rail.noProjects")));
  }

  // Um grupo por projeto: a lista é do repositório, e a etapa vira o anel na
  // frente da linha. Com vários repos começando com a mesma letra, o avatar
  // sozinho não dizia de qual workspace era — o cabeçalho diz.
  const stageAt = (ws: Workspace) => board.stages.indexOf(ws.stage);
  for (const project of board.projects) {
    const mine = live.filter((w) => w.project === project.id && !w.pinned);
    // Dentro do projeto quem ordena é a etapa: o que está andando fica em cima.
    mine.sort((a, b) => stageAt(a) - stageAt(b));
    const plus = h("button", "ico sm", icon("plus"));
    // Criar workspace já dentro do projeto é o que torna começar algo rápido.
    plus.title = t("rail.newIn", { project: project.name });
    plus.addEventListener("click", (e) => {
      e.stopPropagation();
      hooks.newWorkspace(project.id);
    });
    renderGroup(rail, board, hooks, project.name, avatar(project.name), mine, `@proj:${project.id}`, { extra: plus });
  }

  // Workspace de um projeto que saiu da lista não pode sumir da barra junto.
  const known = new Set(board.projects.map((p) => p.id));
  const loose = live.filter((w) => !w.pinned && !known.has(w.project));
  if (loose.length) {
    renderGroup(rail, board, hooks, t("rail.loose"), icon("folder", 14), loose, "@soltos", { avatars: true });
  }

  // Arquivado não é lista na barra: é uma linha com o número, e a tela é
  // outra. Trabalho que saiu da frente se consulta de vez em quando, e trinta
  // deles abertos aqui empurravam os projetos para fora da tela.
  const gone = board.workspaces.filter((w) => w.archived).length;
  if (gone) {
    rail.append(document.createElement("hr"));
    const arch = h(
      "button",
      "navitem" + (openId === ARCHIVED ? " on" : ""),
      `${icon("archive")}<span></span><span class="n"></span>`,
    );
    arch.children[1].textContent = t("rail.archived");
    arch.querySelector(".n")!.textContent = String(gone);
    arch.title = t("rail.archived.title");
    arch.addEventListener("click", hooks.toArchived);
    rail.append(arch);
  }
}

function renderGroup(
  rail: HTMLElement,
  board: Board,
  hooks: Hooks,
  name: string,
  glyph: string,
  list: Workspace[],
  /// O que grava o recolhido. Fica separado do rótulo porque o rótulo muda de
  /// idioma, e um grupo recolhido não pode se abrir sozinho por causa disso.
  key = name,
  opts: {
    /// Grupo que mistura repositórios (fixados, soltos, arquivados): ali o
    /// avatar ainda é o que diz de qual projeto a linha é.
    avatars?: boolean;
    /// Botão do cabeçalho — o + do projeto.
    extra?: HTMLElement;
  } = {},
) {
  const shut = folded(key);
  // Div, e não botão: o + do projeto mora no cabeçalho, e `button` dentro de
  // `button` é HTML inválido. O `tabindex` devolve o que o botão dava de graça.
  const head = h(
    "div",
    "group",
    `<span class="gg">${glyph}</span><span></span><span class="n"></span><span class="gc"></span>`,
  );
  head.tabIndex = 0;
  head.children[1].textContent = name;
  head.children[2].textContent = list.length ? String(list.length) : "";
  // Grupo vazio não recolhe: o cabeçalho está ali só pelo + de criar dentro.
  head.children[3].innerHTML = list.length ? icon(shut ? "chevron-right" : "chevron-down", 14) : "";
  const fold = () => {
    if (!list.length) return;
    localStorage.setItem(FOLD + key, shut ? "0" : "1");
    renderRail(board, hooks);
  };
  head.addEventListener("click", fold);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fold();
    }
  });
  if (opts.extra) head.append(opts.extra);
  rail.append(head);
  if (shut) return;

  const total = board.stages.length;
  for (const ws of list) {
    const b = h(
      "button",
      "navitem sub" + (ws.id === openId ? " on" : "") + (ws.unread ? " unread" : ""),
      `<i class="dot"></i><span class="lbl"></span><span class="n"></span>`,
    );
    (b.children[0] as HTMLElement).style.background = `var(--dot-${statusOf(ws)})`;
    b.children[1].textContent = ws.title;
    b.children[2].textContent = ws.tabs.length > 1 ? `${ws.tabs.length}` : "";
    b.addEventListener("click", () => hooks.open(ws));
    // Workspace de colega: o avatar é dele, e a etapa é a dele — não vira anel,
    // porque o anel é a posição na sua lista de etapas.
    if (ws.remote) {
      const owner = team.nameOf(ws.remote.owner);
      b.title = `${owner} · ${ws.repo_name} · ${ws.branch} · ${stateLabel(ws)}`;
      b.children[0].after(h("span", "av", avatar(owner)));
      if (!ws.remote.online) b.classList.add("off");
      rail.append(b);
      continue;
    }
    b.title = `${ws.repo_name} · ${ws.branch} · ${stageName(ws.stage)} · ${stateLabel(ws)}`;
    // A etapa saiu do cabeçalho e virou o anel da linha: o grupo é o projeto,
    // e continua dando para ler de longe o que está em qual etapa.
    const at = board.stages.indexOf(ws.stage);
    b.children[0].after(h("span", "st", stageIcon(at, total, 13)));
    if (opts.avatars) b.children[0].after(h("span", "av", avatar(ws.repo_name)));
    attachMenu(b, ws, board, hooks, b, "sub");
    rail.append(b);
  }
}
