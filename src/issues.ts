import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { icon } from "./icons";
import { fromBack, paint, t } from "./i18n";
import * as settings from "./settings";
import type { Board, Issue, Issues, LinearStatus, Workspace } from "./types";
import { $, h } from "./util";

/// As issues do Linear no seu nome — a porta de entrada que não é um
/// repositório. Cada linha é uma issue; "Criar workspace" abre o lançador já
/// com ela dentro, e você só escolhe projeto, modelo e esforço. Uma issue que
/// já virou workspace mostra o caminho para ele em vez do botão de criar.
///
/// A lista vem do back, que guarda um cache de dois minutos: abrir a aba
/// várias vezes é uma chamada só, e o botão de atualizar ignora o cache. A
/// última lista boa fica na tela mesmo se a próxima busca falhar.

type Ctx = {
  say: (text: string, isError?: boolean) => void;
  board: () => Board;
  /// A rail mostra a contagem; ela precisa saber quando muda.
  redraw: () => void;
  open: (ws: Workspace) => void;
  create: (issue: Issue) => void;
  toSettings: () => void;
};

/// Quanto tempo a lista na tela vale antes de a aba pedir outra ao abrir.
/// É o mesmo prazo do cache do back: pedir antes disso volta o mesmo.
const STALE = 120_000;

/// A ordem dos grupos, e o nome de cada um em português — o `name` do estado
/// é o que o time escolheu e vai na linha.
const KINDS: [string, string][] = [
  ["started", t("issues.kind.started")],
  ["unstarted", t("issues.kind.unstarted")],
  ["triage", t("issues.kind.triage")],
  ["backlog", t("issues.kind.backlog")],
];

/// Grupo recolhido gruda: quem tem 40 issues em "A fazer" fecha o grupo uma
/// vez e ele continua fechado amanhã. Buscar ignora isso — quem procura quer
/// ver o que achou.
const FOLD = "prometheus:issues:grupo:";
const folded = (kind: string) => localStorage.getItem(FOLD + kind) === "1";

let ctx: Ctx;
let got: Issues | null = null;
let loading = false;
let error = "";
let query = "";
let visible = false;
let find: HTMLInputElement;
let meta: HTMLElement;

export function init(context: Ctx) {
  ctx = context;
  buildBar();
  listen<LinearStatus>("linear", ({ payload }) => {
    if (!payload.connected) {
      got = null;
      error = "";
    } else if (!got) {
      void refresh(false);
    }
    ctx.redraw();
    draw();
  });
  if (settings.linear().connected) void refresh(false);
}

/// O número da rail. `null` é "sem Linear", e a rail esconde o número.
export const count = () => (settings.linear().connected && got ? got.issues.length : null);

/// A lista para o lançador. `null` é "sem Linear"; vazia com `busy()` é
/// "ainda não chegou".
export const list = () => (settings.linear().connected ? (got?.issues ?? []) : null);
export const busy = () => loading;

/// Busca se nunca buscou ou se a lista está velha; senão não faz nada. É o
/// que o lançador chama ao abrir o seletor.
export function load(): Promise<void> {
  if (!settings.linear().connected || loading) return Promise.resolve();
  const old = !got || Date.now() / 1000 - got.fetched_at > STALE / 1000;
  return old ? refresh(false) : Promise.resolve();
}

export function show() {
  visible = true;
  void load();
  draw();
  find.focus();
}

export function hide() {
  visible = false;
}

async function refresh(force: boolean) {
  loading = true;
  drawMeta();
  try {
    got = await invoke<Issues>("linear_issues", { force });
    error = "";
  } catch (e) {
    error = fromBack(e);
  }
  loading = false;
  ctx.redraw();
  draw();
}

/* ---------- a barra ---------- */

function buildBar() {
  const bar = $("ibar");
  bar.innerHTML = `
    <label class="ifind">${icon("search", 14)}<input spellcheck="false" /></label>
    <span class="spacer"></span>
    <span class="imeta" id="imeta"></span>
    <button class="ico" id="irefresh" data-t-title="issues.refresh">${icon("rotate")}</button>`;
  paint(bar);
  find = bar.querySelector("input")!;
  find.placeholder = t("issues.search");
  meta = bar.querySelector("#imeta")!;
  find.addEventListener("input", () => {
    query = find.value.trim().toLowerCase();
    drawList();
  });
  find.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      find.value = "";
      query = "";
      drawList();
    }
  });
  bar.querySelector("#irefresh")!.addEventListener("click", () => {
    if (settings.linear().connected && !loading) void refresh(true);
  });
}

function drawMeta() {
  meta.classList.toggle("err", !!error && !loading);
  meta.textContent = loading
    ? t("issues.busy")
    : error
      ? error
      : got
        ? t("issues.updated", { when: ago(got.fetched_at * 1000) })
        : "";
  ($("irefresh") as HTMLButtonElement).disabled = loading || !settings.linear().connected;
}

/* ---------- a lista ---------- */

export function draw() {
  if (!visible) return;
  drawMeta();
  drawList();
}

function drawList() {
  const list = $("ilist");
  list.replaceChildren();

  if (!settings.linear().connected) {
    list.append(
      empty(t("issues.off.title"), t("issues.off.body"), [t("issues.off.action"), ctx.toSettings]),
    );
    return;
  }
  if (!got) {
    if (!loading && error) {
      list.append(empty(t("issues.failed.title"), error, [t("issues.failed.action"), () => refresh(true)]));
    }
    return;
  }

  const hits = got.issues.filter(matches);
  if (!hits.length) {
    list.append(
      query
        ? empty(t("issues.noMatch.title"), t("issues.noMatch.body"))
        : empty(t("issues.empty.title"), t("issues.empty.body")),
    );
    return;
  }

  const kinds = [...KINDS, ...unknownKinds(hits)];
  for (const [kind, label] of kinds) {
    const mine = hits.filter((i) => i.state.kind === kind).sort(byUrgency);
    if (!mine.length) continue;
    const shut = !query && folded(kind);
    const head = h(
      "button",
      "igroup" + (shut ? " shut" : ""),
      `<span class="gc"></span><span class="t"></span><span class="c"></span>`,
    );
    head.children[0].innerHTML = icon(shut ? "chevron-right" : "chevron-down", 14);
    head.children[1].textContent = label;
    head.children[2].textContent = String(mine.length);
    head.title = t(shut ? "issues.group.show" : "issues.group.fold", { group: label });
    head.addEventListener("click", () => {
      localStorage.setItem(FOLD + kind, shut ? "0" : "1");
      drawList();
    });
    list.append(head);
    if (shut) continue;
    for (const issue of mine) list.append(row(issue));
  }
}

/// Um tipo de estado que o Linear inventar depois não pode sumir da lista.
function unknownKinds(list: Issue[]): [string, string][] {
  const known = new Set(KINDS.map(([k]) => k));
  const extra = new Set(list.map((i) => i.state.kind).filter((k) => !known.has(k)));
  return [...extra].map((k) => [k, k]);
}

/// Urgente primeiro, sem prioridade por último; empate é o mais recente.
function byUrgency(a: Issue, b: Issue) {
  const rank = (p: number) => (p === 0 ? 5 : p);
  return rank(a.priority) - rank(b.priority) || b.updated_at.localeCompare(a.updated_at);
}

function matches(i: Issue) {
  if (!query) return true;
  const hay = [i.identifier, i.title, i.project ?? "", i.team, i.state.name, i.description ?? ""]
    .join(" ")
    .toLowerCase();
  return query.split(/\s+/).every((word) => hay.includes(word));
}

function row(issue: Issue): HTMLElement {
  const el = h(
    "div",
    "irow",
    `<span class="prio p${Math.min(issue.priority, 4)}"><i></i><i></i><i></i></span>` +
      `<span class="iid"></span>` +
      `<span class="ititle"><b></b><span class="iproj"></span></span>` +
      `<span class="istate"><i class="dot"></i><span></span></span>` +
      `<span class="iact"></span>` +
      `<span class="iago"></span>`,
  );
  el.tabIndex = 0;
  el.title = issue.description ? issue.description.slice(0, 400) : issue.title;
  (el.querySelector(".prio") as HTMLElement).title = issue.priority_label;
  el.querySelector(".iid")!.textContent = issue.identifier;
  el.querySelector(".ititle b")!.textContent = issue.title;
  el.querySelector(".iproj")!.textContent = issue.project ?? "";
  (el.querySelector(".istate .dot") as HTMLElement).style.background = issue.state.color;
  el.querySelector(".istate span")!.textContent = issue.state.name;
  el.querySelector(".iago")!.textContent = ago(Date.parse(issue.updated_at));

  // Clicar na linha é abrir no Linear; os botões são o resto.
  const openLinear = () => invoke("linear_open", { url: issue.url }).catch((e) => ctx.say(fromBack(e), true));
  el.addEventListener("click", openLinear);
  el.addEventListener("keydown", (e) => e.key === "Enter" && openLinear());

  const act = el.querySelector(".iact")!;
  const owner = ctx.board().workspaces.find((w) => w.issue?.id === issue.id && !w.archived);
  const btn = h("button", owner ? "ghost sm" : "pri sm", t(owner ? "issues.open" : "issues.create"));
  btn.title = owner
    ? `${owner.title} · ${owner.branch}`
    : t("issues.create.title", { branch: issue.branch_name });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    owner ? ctx.open(owner) : ctx.create(issue);
  });
  act.append(btn);
  return el;
}

function empty(title: string, text: string, action?: [string, () => void]): HTMLElement {
  const box = h("div", "iempty", `<h3></h3><p></p>`);
  box.children[0].textContent = title;
  box.children[1].textContent = text;
  if (action) {
    const b = h("button", "outline md", action[0]);
    b.addEventListener("click", action[1]);
    box.append(b);
  }
  return box;
}

/// "agora", "há 5 min", "há 3 h", "há 2 d": o bastante para saber se a issue
/// está quente.
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t("ago.now");
  if (s < 3600) return t("ago.min", { n: Math.round(s / 60) });
  if (s < 86_400) return t("ago.hour", { n: Math.round(s / 3600) });
  return t("ago.day", { n: Math.round(s / 86_400) });
}
