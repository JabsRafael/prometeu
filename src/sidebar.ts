import { avatar, avatars, brand, icon, stageIcon } from "./icons";
import { stage as stageName, t, tn } from "./i18n";
import * as menu from "./menu";
import * as team from "./team";
import * as rename from "./rename";
import { hasWorktree, label, repoLabel, stateLabel, statusOf, tabLabel, type Board, type Status, type Workspace } from "./types";
import { h, template } from "./util";

/// Ações disponíveis na lista lateral e no menu de um workspace.
export type Hooks = {
  /// A caixa "Para mim": os comentários abertos que marcaram você.
  inbox: () => void;
  open: (ws: Workspace, tab?: string) => void;
  activeTab: () => string | null;
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
  toDesk: () => void;
  toIssues: () => void;
  toArchived: () => void;
  /// Quantas issues a aba tem para mostrar — `null` é "sem Linear", e o
  /// número some.
  issues: () => number | null;
  addProject: () => void;
  removeProject: (id: string) => void;
  newWorkspace: (projectId?: string) => void;
};

/// O que fica "aberto" quando a tela é a mesa: nenhum workspace. Não colide
/// com id de workspace nenhum.
export const DESK = "@mesa";
/// A tela de issues, pela mesma regra.
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
const FOLD = "prometeu:grupo:";
const folded = (name: string) => localStorage.getItem(FOLD + name) === "1";

function renderRail(board: Board, hooks: Hooks) {
  const rail = el("railbody");
  rail.replaceChildren();
  const live = board.workspaces.filter((w) => !w.archived && !w.remote);

  rail.append(template("div", "navitem brand", `${icon("flame")}<span>Prometeu</span>`));

  const create = template("button", "navitem", `${icon("plus")}<span></span>`);
  create.children[1].textContent = t("rail.create");
  create.title = t("rail.create.title");
  create.addEventListener("click", () => hooks.newWorkspace());
  rail.append(create);

  // A mesa: todas as conversas de uma vez. É a tela inicial.
  const desk = template("button", "navitem" + (openId === DESK ? " on" : ""), `${icon("terminal")}<span></span>`);
  desk.children[1].textContent = t("rail.desk");
  desk.title = t("rail.desk.title");
  desk.addEventListener("click", hooks.toDesk);
  rail.append(desk);

  // As issues no seu nome, do Linear: de onde o trabalho sai.
  const issues = template(
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

  // Alguém do time te marcou num comentário: é o único lugar da tela que espera
  // resposta sua e não está dentro de uma sessão.
  const waiting = team.inboxCount();
  if (waiting) {
    const mine = template("button", "navitem mentions", `${icon("at-sign")}<span></span><span class="n"></span>`);
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

  const sect = template("div", "sect", `<span></span>`);
  sect.children[0].textContent = t("rail.projects");
  const add = template("button", "ico sm", icon("folder-plus"));
  add.title = t("rail.addProject");
  add.addEventListener("click", hooks.addProject);
  sect.append(add);
  rail.append(sect);

  if (!board.projects.length) {
    rail.append(h("div", "railhint", t("rail.noProjects")));
  }

  // Um grupo por projeto: com vários repos começando com a mesma letra, o
  // avatar sozinho não dizia de qual workspace era — o cabeçalho diz.
  const stageAt = (ws: Workspace) => board.stages.indexOf(ws.stage);
  // Quem atravessa repositórios não é de um projeto só: mora nos conjuntos,
  // logo abaixo.
  const single = live.filter((w) => !w.pinned && w.repos.length < 2);
  for (const project of board.projects) {
    const mine = single.filter((w) => w.project === project.id);
    // Dentro do projeto quem ordena é a etapa: o que está andando fica em cima.
    mine.sort((a, b) => stageAt(a) - stageAt(b));
    const plus = template("button", "ico sm", icon("plus"));
    // Criar workspace já dentro do projeto é o que torna começar algo rápido.
    plus.title = t("rail.newIn", { project: project.name });
    plus.addEventListener("click", (e) => {
      e.stopPropagation();
      hooks.newWorkspace(project.id);
    });
    const more = template("button", "ico sm", icon("ellipsis"));
    more.title = t("rail.projectActions", { project: project.name });
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const at = more.getBoundingClientRect();
      menu.openAt({ x: at.left, y: at.bottom + 4 }, [
        {
          label: t("rail.removeProject"),
          glyph: icon("x"),
          danger: true,
          run: () => hooks.removeProject(project.id),
        },
      ]);
    });
    renderGroup(rail, board, hooks, project.name, avatar(project.name), mine, `@proj:${project.id}`, {
      extra: [more, plus],
    });
  }

  // Conjuntos: um grupo por combinação de repositórios com workspace de pé.
  // Não é projeto — nasce do launcher e some com o último workspace —, então
  // o cabeçalho não tem o + nem o menu. O avatar é o dos projetos, fatiado.
  const sets = new Map<string, Workspace[]>();
  for (const w of live) {
    if (w.pinned || w.repos.length < 2) continue;
    sets.set(repoLabel(w), [...(sets.get(repoLabel(w)) ?? []), w]);
  }
  if (sets.size) {
    rail.append(document.createElement("hr"));
    const head = template("div", "sect", `<span></span>`);
    head.children[0].textContent = t("rail.sets");
    rail.append(head);
    for (const [name, mine] of sets) {
      mine.sort((a, b) => stageAt(a) - stageAt(b));
      renderGroup(rail, board, hooks, name, avatars(mine[0].repos.map((r) => r.name)), mine, `@set:${name}`);
    }
  }

  // Workspace de um projeto que saiu da lista não pode sumir da barra junto.
  const known = new Set(board.projects.map((p) => p.id));
  const loose = single.filter((w) => !known.has(w.project));
  if (loose.length) {
    renderGroup(rail, board, hooks, t("rail.loose"), icon("folder", 14), loose, "@soltos", { avatars: true });
  }

  // Arquivado não é lista na barra: é uma linha com o número, e a tela é
  // outra. Trabalho que saiu da frente se consulta de vez em quando, e trinta
  // deles abertos aqui empurravam os projetos para fora da tela.
  const gone = board.workspaces.filter((w) => w.archived).length;
  if (gone) {
    rail.append(document.createElement("hr"));
    const arch = template(
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
    /// Grupo que mistura repositórios (fixados, soltos): ali o
    /// avatar ainda é o que diz de qual projeto a linha é.
    avatars?: boolean;
    /// Botões do cabeçalho — ações de baixa frequência e criação.
    extra?: HTMLElement[];
  } = {},
) {
  const shut = folded(key);
  // Div, e não botão: o + do projeto mora no cabeçalho, e `button` dentro de
  // `button` é HTML inválido. O `tabindex` devolve o que o botão dava de graça.
  const head = template(
    "div",
    "group",
    `<span class="gg">${glyph}</span><span></span><span class="n"></span><span class="gc"></span>`,
  );
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", String(!shut));
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
  if (opts.extra) head.append(...opts.extra);
  rail.append(head);
  if (shut) return;

  for (const ws of list) {
    const card = h("div", "railworkspace" + (ws.id === openId ? " on" : ""));
    card.dataset.workspace = ws.id;
    const owner = ws.remote ? team.nameOf(ws.remote.owner) : null;
    const status = ws.remote && !ws.remote.online ? "desligada" : statusOf(ws);
    const b = template(
      "button",
      "navitem sub" + (ws.unread ? " unread" : ""),
      `<span class="wsidentity"><span class="lbl"></span><span class="wsbranch"></span></span>`,
    );
    b.prepend(statusDot(ws.preparing ? "rodando" : status, ws.remote ? label(status) : stateLabel(ws)));
    if (ws.failed) b.querySelector(".rail-status")!.classList.add("failed");
    const title = b.querySelector<HTMLElement>(".lbl")!;
    title.textContent = ws.title;
    b.querySelector(".wsbranch")!.textContent = ws.branch;
    b.title = [owner, repoLabel(ws), ws.branch].filter(Boolean).join(" · ");
    b.addEventListener("click", () => hooks.open(ws));
    if (owner || opts.avatars) b.children[0].after(template("span", "av", owner ? avatar(owner) : avatars(ws.repos.map((r) => r.name))));
    if (ws.remote && !ws.remote.online) card.classList.add("off");
    if (!ws.remote) attachMenu(b, ws, board, hooks, title, "sub");
    card.append(b);

    if (ws.tabs.length) {
      const key = `@ws:${ws.id}`;
      // Um agente só não tem o que recolher: a linha "1 agente" seria só
      // altura. Ele entra direto embaixo do card.
      const shut = ws.tabs.length > 1 && folded(key);
      const toggle = template("button", "railagents-toggle", `<span></span>${icon(shut ? "chevron-right" : "chevron-down", 12)}`);
      toggle.children[0].textContent = tn(ws.tabs.length, "rail.agents");
      toggle.setAttribute("aria-expanded", String(!shut));
      toggle.setAttribute("aria-controls", `railagents-${ws.id}`);
      const agents = h("div", "railagents");
      agents.id = `railagents-${ws.id}`;
      agents.hidden = shut;
      toggle.addEventListener("click", () => {
        agents.hidden = !agents.hidden;
        localStorage.setItem(FOLD + key, agents.hidden ? "1" : "0");
        toggle.setAttribute("aria-expanded", String(!agents.hidden));
        toggle.lastElementChild!.outerHTML = icon(agents.hidden ? "chevron-right" : "chevron-down", 12);
      });
      for (const tab of ws.tabs) {
        const provider = tab.choice?.agent ?? ws.agent;
        const status = ws.remote && !ws.remote.online ? "desligada" : tab.status;
        // O relay não anuncia o provider; a identidade remota é o dono.
        // Duas linhas, como o card acima: o nome (ou o modelo) e, embaixo, o
        // que o agente está fazendo agora — a ferramenta, ou a pergunta que
        // ele espera responder. Parada, a aba fica numa linha só.
        const agent = template(
          "button",
          "railagent",
          `<span class="provider">${owner ? avatar(owner) : brand(provider, 15)}</span><span class="wsidentity"><span class="lbl"></span><span class="note" hidden></span></span>`,
        );
        agent.prepend(statusDot(status));
        agent.dataset.tab = tab.id;
        const name = tabLabel(ws, tab);
        agent.querySelector(".lbl")!.textContent = name;
        const note = agent.querySelector<HTMLElement>(".note")!;
        note.textContent = tab.note ?? "";
        note.hidden = !tab.note;
        agent.title = [name, owner ?? t(`model.${provider}`), label(status), tab.note].filter(Boolean).join(" · ");
        agent.setAttribute("aria-label", agent.title);
        if (ws.id === openId && tab.id === hooks.activeTab()) {
          agent.classList.add("on");
          agent.setAttribute("aria-current", "true");
        }
        agent.addEventListener("click", () => hooks.open(ws, tab.id));
        agents.append(agent);
      }
      if (ws.tabs.length > 1) card.append(toggle);
      card.append(agents);
    }
    rail.append(card);
  }
}

function statusDot(status: Status, text = label(status)) {
  const dot = h("span", "rail-status");
  dot.dataset.status = status;
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", text);
  dot.title = text;
  return dot;
}
