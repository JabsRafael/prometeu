import { statusOf, worst, type Board, type Status, type Workspace } from "./types";

const LABEL: Record<Status, string> = {
  rodando: "rodando",
  querendo: "quer você",
  pronta: "pronta",
  desligada: "desligada",
};

const DOT: Record<Status, string> = {
  rodando: "var(--run)",
  querendo: "var(--wait)",
  pronta: "var(--done)",
  desligada: "var(--ink-3)",
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

/* ---------- rail: projeto → workspace ---------- */

function renderRail(board: Board, hooks: Hooks) {
  const rail = el("rail");
  rail.replaceChildren();

  const brand = document.createElement("div");
  brand.className = "railbrand";
  brand.textContent = "Prometheus";
  rail.append(brand);

  const quadro = document.createElement("button");
  quadro.className = "item" + (openId === null ? " on" : "");
  quadro.innerHTML = `<span></span><span class="n"></span>`;
  quadro.children[0].textContent = "Quadro";
  quadro.children[1].textContent = String(board.workspaces.length);
  quadro.addEventListener("click", hooks.toBoard);
  rail.append(quadro);

  const head = document.createElement("div");
  head.className = "lbl rowlbl";
  head.innerHTML = `<span>Projetos</span>`;
  const add = document.createElement("button");
  add.className = "mini";
  add.textContent = "+";
  add.title = "registrar um repositório";
  add.addEventListener("click", hooks.addProject);
  head.append(add);
  rail.append(head);

  if (!board.projects.length) {
    const hint = document.createElement("div");
    hint.className = "railhint";
    hint.textContent = "registre um repositório no + acima";
    rail.append(hint);
  }

  for (const project of board.projects) {
    const group = document.createElement("div");
    group.className = "grp";

    const row = document.createElement("div");
    row.className = "project";
    row.innerHTML = `<span></span>`;
    row.children[0].textContent = project.name;
    const plus = document.createElement("button");
    plus.className = "mini";
    plus.textContent = "+";
    // Criar workspace já dentro do projeto é o que torna começar algo rápido.
    plus.title = `novo workspace em ${project.name}`;
    plus.addEventListener("click", () => hooks.newWorkspace(project.id));
    row.append(plus);
    group.append(row);

    for (const ws of board.workspaces.filter((w) => w.project === project.id)) {
      const b = document.createElement("button");
      b.className = "item sub" + (ws.id === openId ? " on" : "");
      b.innerHTML = `<i class="dot"></i><span></span><span class="n"></span>`;
      (b.children[0] as HTMLElement).style.background = DOT[statusOf(ws)];
      b.children[1].textContent = ws.title;
      b.children[2].textContent = ws.tabs.length > 1 ? `${ws.tabs.length}` : "";
      b.title = `${ws.branch} · ${ws.tabs.length} conversa(s)`;
      b.addEventListener("click", () => hooks.open(ws));
      group.append(b);
    }
    rail.append(group);
  }
}

/* ---------- faixa de números ---------- */

function renderPulse(list: Workspace[]) {
  const by = (s: Status) => list.filter((w) => statusOf(w) === s).length;
  const stats: [string, number, string][] = [
    ["querem você", by("querendo"), "var(--wait)"],
    ["rodando", by("rodando"), "var(--run)"],
    ["prontas", by("pronta"), "var(--done)"],
    ["conversas", list.reduce((n, w) => n + w.tabs.length, 0), "var(--ink-2)"],
  ];
  el("pulse").replaceChildren(
    ...stats.map(([k, v, color]) => {
      const d = document.createElement("div");
      d.className = "stat";
      d.innerHTML = `<span class="v"></span><span class="k"></span>`;
      const val = d.children[0] as HTMLElement;
      val.textContent = String(v);
      val.style.color = color;
      d.children[1].textContent = k;
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

    const col = document.createElement("div");
    col.className = "col";
    col.innerHTML = `<div class="head"><span class="t"></span><span class="c"></span></div>`;
    col.querySelector(".t")!.textContent = name;
    col.querySelector(".c")!.textContent = String(mine.length);

    const drop = document.createElement("div");
    drop.className = "drop";
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

    if (!mine.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "arraste um card para cá";
      drop.append(empty);
    }
    for (const ws of mine) drop.append(card(ws, hooks));

    col.append(drop);
    cols.append(col);
  }
}

function card(ws: Workspace, hooks: Hooks): HTMLElement {
  const status = statusOf(ws);
  const el = document.createElement("button");
  el.className = "card" + (ws.id === openId ? " here" : "");
  el.draggable = true;
  el.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/plain", ws.id));
  el.addEventListener("click", () => hooks.open(ws));

  const repo = document.createElement("div");
  repo.className = "repo";
  repo.textContent = `${ws.repo_name} · ${ws.branch}`;

  const title = document.createElement("div");
  title.className = "ttl";
  title.textContent = ws.title;

  el.append(repo, title);

  // A linha de atividade vem da aba mais urgente — ou o que o agente está
  // rodando agora, ou o que ele perguntou e está esperando.
  const note = worst(ws)?.note;
  if (note) {
    const line = document.createElement("div");
    line.className = "act" + (status === "querendo" ? " ask" : "");
    line.textContent = note;
    el.append(line);
  }

  const foot = document.createElement("div");
  foot.className = "foot";
  const chip = document.createElement("span");
  chip.className = `chip s-${status}`;
  chip.innerHTML = `<i class="dot"></i>`;
  chip.append(LABEL[status]);
  foot.append(chip);

  if (ws.tabs.length > 1) {
    const tabs = document.createElement("span");
    tabs.className = "chip s-desligada";
    tabs.textContent = `${ws.tabs.length} conversas`;
    foot.append(tabs);
  }

  const x = document.createElement("span");
  x.className = "x";
  x.textContent = "×";
  x.title = "tirar do quadro (worktree e branch ficam)";
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    hooks.drop(ws.id);
  });
  foot.append(x);

  el.append(foot);
  return el;
}
