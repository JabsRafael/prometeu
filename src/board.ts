import { avatar, icon } from "./icons";
import { statusOf, worst, type Board, type Status, type Workspace } from "./types";

const LABEL: Record<Status, string> = {
  rodando: "rodando",
  querendo: "quer você",
  pronta: "pronta",
  desligada: "desligada",
};

export type Hooks = {
  open: (ws: Workspace) => void;
  move: (id: string, column: string) => void;
  drop: (id: string) => void;
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
  renderPulse(board.workspaces);
  renderColumns(board, hooks);
}

const el = (id: string) => document.getElementById(id)!;

function h(tag: string, className: string, html = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.innerHTML = html;
  return node;
}

/* ---------- sidebar: Criar · Quadro · Projetos → workspaces ---------- */

function renderRail(board: Board, hooks: Hooks) {
  const rail = el("railbody");
  rail.replaceChildren();

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
  quadro.querySelector(".n")!.textContent = String(board.workspaces.length);
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

  for (const project of board.projects) {
    const mine = board.workspaces.filter((w) => w.project === project.id);

    const row = h("div", "proj", `${avatar(project.name)}<span></span><span class="n"></span>`);
    row.children[1].textContent = project.name;
    row.children[2].textContent = mine.length ? String(mine.length) : "";
    const plus = h("button", "ico sm", icon("plus"));
    // Criar workspace já dentro do projeto é o que torna começar algo rápido.
    plus.title = `Novo workspace em ${project.name}`;
    plus.addEventListener("click", () => hooks.newWorkspace(project.id));
    row.append(plus);
    rail.append(row);

    for (const ws of mine) {
      const b = h(
        "button",
        "navitem sub" + (ws.id === openId ? " on" : ""),
        `<i class="dot"></i><span></span><span class="n"></span>`,
      );
      (b.children[0] as HTMLElement).style.background = `var(--dot-${statusOf(ws)})`;
      b.children[1].textContent = ws.title;
      b.children[2].textContent = ws.tabs.length > 1 ? `${ws.tabs.length}` : "";
      b.title = `${ws.branch} · ${LABEL[statusOf(ws)]}`;
      b.addEventListener("click", () => hooks.open(ws));
      rail.append(b);
    }
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

function renderColumns(board: Board, hooks: Hooks) {
  const cols = el("cols");
  cols.replaceChildren();

  for (const name of board.columns) {
    const mine = board.workspaces.filter((w) => w.column === name);

    const col = h("div", "col", `<div class="head"><span class="t"></span><span class="c"></span></div>`);
    col.querySelector(".t")!.textContent = name;
    col.querySelector(".c")!.textContent = String(mine.length);

    const drop = h("div", "drop");
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const id = e.dataTransfer?.getData("text/plain");
      if (id) hooks.move(id, name);
    });

    if (!mine.length) drop.append(h("div", "empty", "arraste um card para cá"));
    for (const ws of mine) drop.append(card(ws, hooks));

    col.append(drop);
    cols.append(col);
  }
}

function card(ws: Workspace, hooks: Hooks): HTMLElement {
  const status = statusOf(ws);
  const el = h("button", "card" + (ws.id === openId ? " here" : ""));
  el.draggable = true;
  el.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/plain", ws.id));
  el.addEventListener("click", () => hooks.open(ws));

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

  const x = h("span", "x ico sm", icon("x"));
  x.title = "Tirar do quadro (worktree e branch ficam)";
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    hooks.drop(ws.id);
  });
  foot.append(x);

  el.append(foot);
  return el;
}
