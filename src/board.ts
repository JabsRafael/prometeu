import { avatar, icon, stageIcon } from "./icons";
import * as menu from "./menu";
import * as rename from "./rename";
import { LABEL, fmtTokens, heaviest, statusOf, worst, type Board, type Status, type Workspace } from "./types";
import { h } from "./util";

export type Hooks = {
  open: (ws: Workspace) => void;
  setStage: (id: string, stage: string) => void;
  /// Tira do quadro de vez — o worktree e a branch ficam, a referência não.
  drop: (id: string) => void;
  /// `title` nulo é desistência: só devolve a linha ao normal.
  rename: (id: string, title: string | null) => void;
  archive: (id: string, archived: boolean) => void;
  pin: (id: string, pinned: boolean) => void;
  unread: (id: string, unread: boolean) => void;
  reveal: (id: string) => void;
  copyPath: (ws: Workspace) => void;
  toBoard: () => void;
  addProject: () => void;
  newWorkspace: (projectId?: string) => void;
};

let openId: string | null = null;
export function setOpen(id: string | null) {
  openId = id;
}

export function render(board: Board, hooks: Hooks) {
  renderRail(board, hooks);
  // Arquivado não conta em lugar nenhum: é trabalho que você tirou da frente.
  const live = board.workspaces.filter((w) => !w.archived);
  renderPulse(live);
  renderColumns(board, live, hooks);
}

const el = (id: string) => document.getElementById(id)!;

/* ---------- renomear e menu ---------- */

/// Tudo que se faz com um workspace, num lugar só. A etapa entra aqui como
/// propriedade — escolher no submenu é o que arrastar o card fazia, sem precisar
/// do quadro aberto para poder mexer.
function wsMenu(ws: Workspace, board: Board, hooks: Hooks, label: HTMLElement, kind: string): menu.Item[] {
  const total = board.stages.length;
  const at = board.stages.indexOf(ws.stage);
  return [
    ws.unread
      ? { label: "Marcar como lido", glyph: icon("mail-open"), run: () => hooks.unread(ws.id, false) }
      : { label: "Marcar como não lido", glyph: icon("mail"), run: () => hooks.unread(ws.id, true) },
    ws.pinned
      ? { label: "Desafixar", glyph: icon("pin-off"), run: () => hooks.pin(ws.id, false) }
      : { label: "Fixar no topo", glyph: icon("pin"), run: () => hooks.pin(ws.id, true) },
    {
      label: "Definir etapa",
      glyph: stageIcon(at, total),
      sub: board.stages.map((name, i) => ({
        label: name,
        glyph: stageIcon(i, total),
        checked: name === ws.stage,
        run: () => hooks.setStage(ws.id, name),
      })),
    },
    {
      label: "Renomear",
      glyph: icon("pencil"),
      run: () => rename.start(label, ws.title, (title) => hooks.rename(ws.id, title), kind),
    },
    { label: "Copiar caminho", glyph: icon("copy"), run: () => hooks.copyPath(ws) },
    { label: "Abrir no Finder", glyph: icon("external-link"), run: () => hooks.reveal(ws.id) },
    "sep",
    ws.archived
      ? {
          label: "Desarquivar",
          glyph: icon("archive-restore"),
          run: () => hooks.archive(ws.id, false),
        }
      : {
          label: "Arquivar",
          glyph: icon("archive"),
          // O atalho só vale para o workspace aberto; escrever nos outros mentiria.
          hint: ws.id === openId ? "⌘⇧A" : undefined,
          run: () => hooks.archive(ws.id, true),
        },
    {
      label: "Tirar do quadro",
      glyph: icon("x"),
      danger: true,
      run: () => hooks.drop(ws.id),
    },
  ];
}

function onMenu(node: HTMLElement, ws: Workspace, board: Board, hooks: Hooks, label: HTMLElement, kind: string) {
  node.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu.openAt({ x: e.clientX, y: e.clientY }, wsMenu(ws, board, hooks, label, kind));
  });
}

/* ---------- sidebar: Criar · Quadro · Projetos · workspaces por etapa ---------- */

/// Grupo recolhido gruda: quem não olha "Feito" hoje não olha amanhã.
const FOLD = "prometheus:grupo:";
const folded = (name: string) => localStorage.getItem(FOLD + name) === "1";

function renderRail(board: Board, hooks: Hooks) {
  const rail = el("railbody");
  rail.replaceChildren();
  const live = board.workspaces.filter((w) => !w.archived);

  rail.append(h("div", "navitem brand", `${icon("flame")}<span>Prometheus</span>`));

  const create = h("button", "navitem", `${icon("plus")}<span>Criar</span>`);
  create.title = "Novo workspace  ⌘N";
  create.addEventListener("click", () => hooks.newWorkspace());
  rail.append(create);

  const quadro = h(
    "button",
    "navitem" + (openId === null ? " on" : ""),
    `${icon("kanban")}<span>Quadro</span><span class="n"></span>`,
  );
  quadro.querySelector(".n")!.textContent = String(live.length);
  quadro.addEventListener("click", hooks.toBoard);
  rail.append(quadro, document.createElement("hr"));

  const sect = h("div", "sect", `<span>Projetos</span>`);
  const add = h("button", "ico sm", icon("folder-plus"));
  add.title = "Registrar um repositório";
  add.addEventListener("click", hooks.addProject);
  sect.append(add);
  rail.append(sect);

  if (!board.projects.length) {
    rail.append(h("div", "railhint", "Registre um repositório no ícone acima."));
  }

  // Projeto agora é só a porta de entrada — o avatar, a conta e o + para criar
  // ali dentro. Quem organiza a lista é a etapa, não o repositório.
  for (const project of board.projects) {
    const mine = live.filter((w) => w.project === project.id);
    const row = h("div", "proj", `${avatar(project.name)}<span></span><span class="n"></span>`);
    row.children[1].textContent = project.name;
    row.children[2].textContent = mine.length ? String(mine.length) : "";
    const plus = h("button", "ico sm", icon("plus"));
    // Criar workspace já dentro do projeto é o que torna começar algo rápido.
    plus.title = `Novo workspace em ${project.name}`;
    plus.addEventListener("click", () => hooks.newWorkspace(project.id));
    row.append(plus);
    rail.append(row);
  }

  if (live.length || board.workspaces.length) rail.append(document.createElement("hr"));

  // Fixado sobe para o topo e sai do grupo da etapa: aparecer duas vezes na
  // mesma lista não ajuda ninguém.
  const pinned = live.filter((w) => w.pinned);
  if (pinned.length) renderGroup(rail, board, hooks, "Fixados", icon("pin", 14), pinned);

  // Um grupo por etapa, na ordem da lista. Etapa vazia não vira cabeçalho vazio.
  board.stages.forEach((name, i) => {
    const mine = live.filter((w) => w.stage === name && !w.pinned);
    if (mine.length) {
      renderGroup(rail, board, hooks, name, stageIcon(i, board.stages.length, 14), mine);
    }
  });

  const gone = board.workspaces.filter((w) => w.archived);
  if (gone.length) renderGroup(rail, board, hooks, "Arquivados", icon("archive", 14), gone);
}

function renderGroup(
  rail: HTMLElement,
  board: Board,
  hooks: Hooks,
  name: string,
  glyph: string,
  list: Workspace[],
) {
  const shut = folded(name);
  const head = h(
    "button",
    "group",
    `<span class="gg">${glyph}</span><span></span><span class="n"></span><span class="gc"></span>`,
  );
  head.children[1].textContent = name;
  head.children[2].textContent = String(list.length);
  head.children[3].innerHTML = icon(shut ? "chevron-right" : "chevron-down", 14);
  head.addEventListener("click", () => {
    localStorage.setItem(FOLD + name, shut ? "0" : "1");
    renderRail(board, hooks);
  });
  rail.append(head);
  if (shut) return;

  for (const ws of list) {
    const b = h(
      "button",
      "navitem sub" + (ws.id === openId ? " on" : "") + (ws.unread ? " unread" : ""),
      `<i class="dot"></i><span class="lbl"></span><span class="n"></span>`,
    );
    (b.children[0] as HTMLElement).style.background = `var(--dot-${statusOf(ws)})`;
    b.children[1].textContent = ws.title;
    b.children[2].textContent = ws.tabs.length > 1 ? `${ws.tabs.length}` : "";
    b.title = `${ws.repo_name} · ${ws.branch} · ${LABEL[statusOf(ws)]}`;
    b.addEventListener("click", () => hooks.open(ws));
    // Com dois repositórios na lista, o nome do workspace não diz de qual ele é.
    if (board.projects.length > 1) b.children[0].after(h("span", "av", avatar(ws.repo_name)));
    onMenu(b, ws, board, hooks, b, "sub");
    rail.append(b);
  }
}

/* ---------- resumo, na linha das abas ---------- */

function renderPulse(list: Workspace[]) {
  const by = (s: Status) => list.filter((w) => statusOf(w) === s).length;
  const stats: [string, number, string][] = [
    ["querem você", by("querendo"), "var(--wait)"],
    ["rodando", by("rodando"), "var(--run)"],
    ["prontas", by("pronta"), "var(--done)"],
    ["conversas", list.reduce((n, w) => n + w.tabs.length, 0), "var(--fg-3)"],
  ];
  el("pulse").replaceChildren(
    ...stats.map(([k, v, color]) => {
      const d = h("span", "stat", `<i class="dot"></i><b></b><span></span>`);
      (d.children[0] as HTMLElement).style.background = color;
      d.children[1].textContent = String(v);
      d.children[2].textContent = k;
      return d;
    }),
  );
}

/* ---------- colunas ---------- */

function renderColumns(board: Board, live: Workspace[], hooks: Hooks) {
  const cols = el("cols");
  cols.replaceChildren();

  board.stages.forEach((name, i) => {
    const mine = live.filter((w) => w.stage === name);

    const col = h(
      "div",
      "col",
      `<div class="head"><span class="gg">${stageIcon(i, board.stages.length, 14)}</span>` +
        `<span class="t"></span><span class="c"></span></div>`,
    );
    col.querySelector(".t")!.textContent = name;
    col.querySelector(".c")!.textContent = String(mine.length);

    const drop = h("div", "drop");
    // Quem solta um card aqui lê daqui para onde ele foi (ver `grab`).
    drop.dataset.stage = name;

    if (!mine.length) drop.append(h("div", "empty", "arraste um card para cá"));
    for (const ws of mine) drop.append(card(ws, board, hooks));

    col.append(drop);
    cols.append(col);
  });
}

/* ---------- arrastar card entre colunas ---------- */

// Com o mouse, e não com o drag and drop do HTML: no macOS o Tauri toma para si
// o arraste da janela inteira, para entregar os arquivos que vêm do Finder
// (`onDragDropEvent`, em main.ts) — e com isso `dragover` e `drop` nunca chegam
// na página. Dava para desligar isso no tauri.conf.json, mas levaria junto o
// soltar arquivo no terminal.

/// Quanto o mouse anda antes de virar arraste — abaixo disso ainda é clique.
const SLACK = 6;

let lifted: HTMLElement | null = null;

/// Redesenhar o quadro no meio do arraste tiraria o card de debaixo do mouse.
export const dragging = () => lifted !== null;

function grab(el: HTMLElement, ws: Workspace, hooks: Hooks) {
  el.addEventListener("pointerdown", (down) => {
    // Botão direito é o menu; o x de arquivar e o campo de renomear são deles.
    if (down.button !== 0 || (down.target as Element).closest(".x, input")) return;
    const rect = el.getBoundingClientRect();
    const from = { x: down.clientX, y: down.clientY };
    let ghost: HTMLElement | null = null;
    let over: HTMLElement | null = null;
    let moved = false;

    const lift = () => {
      moved = true;
      ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add("ghost");
      ghost.style.width = `${rect.width}px`;
      document.body.append(ghost);
      document.body.classList.add("dragging");
      el.classList.add("lifted");
      lifted = el;
    };

    const settle = () => {
      ghost?.remove();
      ghost = null;
      over?.classList.remove("over");
      over = null;
      el.classList.remove("lifted");
      document.body.classList.remove("dragging");
      lifted = null;
    };

    const move = (e: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < SLACK) return;
        lift();
      }
      ghost!.style.transform = `translate(${rect.left + e.clientX - from.x}px, ${rect.top + e.clientY - from.y}px)`;
      // O fantasma não pega o mouse, então o que está embaixo dele é a coluna.
      const col = document.elementFromPoint(e.clientX, e.clientY)?.closest(".col");
      const under = col?.querySelector<HTMLElement>(".drop") ?? null;
      if (under === over) return;
      over?.classList.remove("over");
      over = under;
      over?.classList.add("over");
    };

    const end = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key);
      if (!moved) return;
      const stage = e.type === "pointerup" ? over?.dataset.stage : undefined;
      settle();
      // Soltar não é clicar: o click que o navegador dispara logo atrás do
      // pointerup abriria o workspace que você só queria mudar de coluna.
      const swallow = (c: Event) => c.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true));
      if (stage && stage !== ws.stage) hooks.setStage(ws.id, stage);
    };

    // Esc desiste: o card volta, e o soltar que vem depois não faz mais nada.
    const key = (e: KeyboardEvent) => e.key === "Escape" && settle();

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key);
  });
}

function card(ws: Workspace, board: Board, hooks: Hooks): HTMLElement {
  const status = statusOf(ws);
  // Div, e não botão: o campo de renomear nasce no lugar do título, dentro do
  // card — e `input` dentro de `button` é HTML inválido. O `tabindex` devolve o
  // que o botão dava de graça: chegar no card pelo teclado.
  const el = h("div", "card" + (ws.id === openId ? " here" : "") + (ws.unread ? " unread" : ""));
  el.tabIndex = 0;
  grab(el, ws, hooks);
  el.addEventListener("click", () => hooks.open(ws));
  el.addEventListener("keydown", (e) => e.key === "Enter" && hooks.open(ws));

  const repo = h("div", "repo");
  repo.textContent = `${ws.repo_name} · ${ws.branch}`;
  const title = h("div", "ttl");
  title.textContent = ws.title;
  el.append(repo, title);

  // A linha de atividade vem da aba mais urgente — ou o que o agente está
  // rodando agora, ou o que ele perguntou e está esperando.
  const note = worst(ws)?.note;
  if (note) {
    const line = h("div", "act" + (status === "querendo" ? " ask" : ""));
    line.textContent = note;
    el.append(line);
  }

  const foot = h("div", "foot");
  const chip = h("span", `chip s-${status}`, `<i class="dot"></i>`);
  chip.append(LABEL[status]);
  foot.append(chip);

  if (ws.tabs.length > 1) {
    const tabs = h("span", "chip");
    tabs.textContent = `${ws.tabs.length} conversas`;
    foot.append(tabs);
  }

  // Sem worktree o agente mexe no clone de sempre; isso não pode ser invisível.
  if (ws.worktree === ws.repo) {
    const here = h("span", "chip");
    here.textContent = "no repo";
    here.title = "Sem worktree: esta conversa mexe no próprio repositório";
    foot.append(here);
  }

  // Modelo fora do padrão é coisa que se quer saber olhando o quadro: "esse
  // está no haiku" explica muita resposta.
  if (ws.model) {
    const model = h("span", "chip");
    model.textContent = ws.model;
    model.title = `As conversas daqui rodam com --model ${ws.model}`;
    foot.append(model);
  }

  if (ws.pinned) {
    const tack = h("span", "chip", icon("pin", 13));
    tack.title = "Fixado no topo da lista";
    foot.append(tack);
  }

  // Quão cheia está a janela, no canto direito: à esquerda fica o que o agente
  // está fazendo, à direita o quanto isso já custou de contexto. Explica "por
  // que ficou lento" e avisa que uma compactação vem aí — o número cai com ela.
  const heavy = heaviest(ws);
  if (heavy?.tokens) {
    const tok = h("span", "chip tok", `Tokens: <b></b>`);
    tok.children[0].textContent = `~${fmtTokens(heavy.tokens)}`;
    tok.title =
      `${heavy.tokens.toLocaleString("pt-BR")} tokens de contexto na última resposta` +
      (ws.tabs.length > 1 ? ` (${heavy.title})` : "");
    foot.append(tok);
  }

  // Arquivar, e não tirar do quadro: some da frente sem perder o caminho de
  // volta. Remover de vez está no menu do botão direito.
  const box = h("span", "x ico sm", icon("archive"));
  box.title = "Arquivar (worktree e branch ficam)";
  box.addEventListener("click", (e) => {
    e.stopPropagation();
    hooks.archive(ws.id, true);
  });
  foot.append(box);

  el.append(foot);
  onMenu(el, ws, board, hooks, title, "ttl");
  return el;
}
