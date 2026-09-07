import { ChatView, type Info } from "./chat";
import { arrange } from "./desk-layout";
import { icon } from "./icons";
import { t } from "./i18n";
import { label, pending, tabLabel, type Board, type Tab, type Workspace } from "./types";
import { $, empty, h, template } from "./util";

/// A mesa: todas as conversas de uma vez, cada uma no seu quadro — para ver o
/// que cada agente está fazendo e responder sem entrar no workspace. Cada
/// quadro é um `ChatView` inteiro ligado na aba, o mesmo da tela do workspace.
/// A faixa de cima lista todas; recolher tira o quadro da mesa sem fechar
/// nada, e a faixa o traz de volta. Ordem, tamanho e o que está recolhido são
/// seus, e ficam neste Mac.
///
/// Arrastar e esticar são gestos de ponteiro escritos aqui, e não o `resize`
/// do CSS nem o drag do HTML: o WebKit do app não achava o canto nativo, e o
/// Tauri toma o drag do HTML para entregar arquivo de verdade (ver `main.ts`).

export type Ctx = {
  say: (text: string, isError?: boolean) => void;
  board: () => Board;
  /// O que a caixa de escrever de uma aba precisa saber (ver `chat.ts`).
  info: (tab: string) => Info;
  /// Entrar no workspace, já na aba do quadro.
  open: (ws: Workspace, tab: string) => void;
  /// O lançador: é o que a mesa vazia oferece.
  create: () => void;
  looked: () => void;
};

type Tile = { el: HTMLElement; head: HTMLElement; view: ChatView };
type Layout = { order: string[]; sizes: Record<string, [number, number]>; hidden: string[] };
type Pair = { w: Workspace; tab: Tab };

const STORE = "prometeu:mesa";
/// Menos que isto é clique, não arraste: o fantasma só nasce depois.
const DRAG_START = 4;

function load(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "");
    return {
      order: Array.isArray(raw.order) ? raw.order : [],
      sizes: raw.sizes ?? {},
      hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
    };
  } catch {
    return { order: [], sizes: {}, hidden: [] };
  }
}

let ctx: Ctx;
let layout: Layout;
let shown = false;
/// Um quadro sendo arrastado: o quadro do back que chegar no meio do gesto
/// não pode devolver os nós à ordem antiga.
let dragging = false;
/// Um quadro por aba. Quem sai da mesa é desligado e some da tela; a tela em
/// si fica no mapa até a aba sumir do quadro.
const tiles = new Map<string, Tile>();

const save = () => localStorage.setItem(STORE, JSON.stringify(layout));

export function init(context: Ctx) {
  ctx = context;
  layout = load();
}

/// As abas que vão para a mesa: as dos workspaces daqui que estão de pé.
/// Arquivado saiu da frente; limpo não tem processo; montando não tem aba; o
/// de um colega roda no Mac dele e tem a sua própria tela.
const live = (board: Board): Pair[] =>
  board.workspaces
    .filter((w) => !w.archived && !w.cleaned && !w.remote && !pending(w))
    .flatMap((w) => w.tabs.map((tab) => ({ w, tab })));

const wsOf = (tab: string) => ctx.board().workspaces.find((w) => w.tabs.some((x) => x.id === tab));

export const visible = (tab: string): boolean => shown && tiles.has(tab) && !tiles.get(tab)!.el.hidden;

export function show() {
  shown = true;
  $("deskView").hidden = false;
}

/// Sair da mesa desliga os quadros: uma conversa ligada em dois lugares é a
/// mesma linha desenhada duas vezes, e a tela do workspace já a tem.
export function hide() {
  if (!shown) return;
  shown = false;
  $("deskView").hidden = true;
  for (const { view } of tiles.values()) view.detach();
}

/// O quadro alcança a mesa: quadro novo para aba nova, fora o de aba que
/// sumiu, e o resto só atualiza o cabeçalho e a caixa. Recolhido fica no DOM
/// escondido e desligado — não custa nada até voltar.
export function draw() {
  if (!shown) return;
  const host = $("tiles");
  const board = ctx.board();
  const pairs = live(board);
  const byTab = new Map(pairs.map((p) => [p.tab.id, p]));
  const alive = new Set(board.workspaces.flatMap((w) => w.tabs.map((tab) => tab.id)));
  for (const [id, tile] of tiles) {
    if (byTab.has(id)) continue;
    tile.view.dispose(!alive.has(id));
    tile.el.remove();
    tiles.delete(id);
    delete layout.sizes[id];
  }
  layout.order = arrange([...byTab.keys()], layout.order);
  layout.hidden = layout.hidden.filter((id) => byTab.has(id));
  const hidden = new Set(layout.hidden);
  for (const id of layout.order) {
    const { w, tab } = byTab.get(id)!;
    let tile = tiles.get(id);
    if (!tile) tile = mount(id);
    tile.el.hidden = hidden.has(id);
    if (tile.el.hidden) {
      if (tile.view.current()) tile.view.detach();
      continue;
    }
    if (!tile.view.current()) void tile.view.attach(id);
    paintHead(tile.head, w, tab);
    tile.view.refresh();
  }
  // Só mexe nos nós quando a ordem da tela não é a da mesa — na primeira vez,
  // ou quando uma aba guardada voltou. Mover um nó tira o foco de quem está
  // escrevendo nele, e o quadro redesenha a cada ferramenta que o agente usa.
  const have = [...host.querySelectorAll<HTMLElement>(".tile")].map((el) => el.dataset.tab);
  if (!dragging && layout.order.some((id, i) => id !== have[i])) {
    host.append(...layout.order.map((id) => tiles.get(id)!.el));
  }
  drawBar(byTab, hidden);
  host.querySelector(".iempty")?.remove();
  if (!pairs.length) host.append(empty(t("desk.empty"), t("desk.empty.hint"), [t("rail.create"), ctx.create]));
  save();
}

/// A faixa de cima: todas as conversas, na ordem da mesa, acesa a que está
/// nela. Clicar recolhe ou traz de volta. É a barra de abas do workspace,
/// com o mesmo desenho — a aba aqui é uma conversa, e não um arquivo.
function drawBar(byTab: Map<string, Pair>, hidden: Set<string>) {
  $("deskbar").replaceChildren(
    ...layout.order.map((id) => {
      const { w, tab } = byTab.get(id)!;
      const off = hidden.has(id);
      const b = template("button", "tab" + (off ? "" : " on"), `<i class="dot"></i><span></span><span class="n"></span>`);
      (b.children[0] as HTMLElement).style.background = `var(--dot-${tab.status})`;
      b.children[1].textContent = w.title;
      b.children[2].textContent = tabLabel(w, tab);
      b.title = t(off ? "desk.chip.show" : "desk.chip.hide");
      b.dataset.tab = id;
      b.addEventListener("click", () => toggle(id));
      return b;
    }),
  );
}

function toggle(id: string) {
  const hidden = new Set(layout.hidden);
  if (!hidden.delete(id)) hidden.add(id);
  layout.hidden = [...hidden];
  draw();
  ctx.looked();
}

function mount(id: string): Tile {
  const el = template(
    "div",
    "tile",
    `<div class="tile-head"><i class="dot"></i><b></b><span class="ttab"></span><span class="spacer"></span><button class="ico sm tmin"></button><button class="ico sm topen"></button></div><div class="chatwrap"></div>`,
  );
  el.dataset.tab = id;
  const head = el.querySelector<HTMLElement>(".tile-head")!;
  const min = head.querySelector<HTMLElement>(".tmin")!;
  min.innerHTML = icon("chevron-down", 14);
  min.title = t("desk.min");
  min.addEventListener("click", () => toggle(id));
  const open = head.querySelector<HTMLElement>(".topen")!;
  open.innerHTML = icon("arrow-right", 14);
  open.title = t("desk.open");
  open.addEventListener("click", () => {
    const w = wsOf(id);
    if (w) ctx.open(w, id);
  });
  const size = layout.sizes[id];
  if (size) {
    el.style.width = `${size[0]}px`;
    el.style.height = `${size[1]}px`;
  }
  const view = new ChatView();
  view.open(el.querySelector<HTMLElement>(".chatwrap")!, { say: ctx.say, info: () => ctx.info(id) });
  drag(el, head);
  grip(el, id);
  $("tiles").append(el);
  const tile = { el, head, view };
  tiles.set(id, tile);
  return tile;
}

function paintHead(head: HTMLElement, w: Workspace, tab: Tab) {
  head.className = `tile-head s-${tab.status}`;
  head.querySelector("b")!.textContent = w.title;
  head.querySelector(".ttab")!.textContent = tabLabel(w, tab);
  head.title = `${label(tab.status)} · ${t("desk.head.title")}`;
}

/// Um gesto de ponteiro: o que fazer a cada movimento e ao soltar. Ouvido no
/// documento, e não com captura no nó — mover o quadro no DOM tira o nó da
/// árvore por um instante, e o Chrome solta a captura junto. Soltar o botão e
/// o sistema cancelar o ponteiro são o mesmo fim.
function gesture(move: (m: PointerEvent) => void, stop: () => void) {
  const end = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    stop();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
}

/// Arrastar pelo cabeçalho troca o quadro de lugar. Um fantasma do quadro
/// segue o cursor, e o quadro de verdade vira a vaga tracejada que mostra onde
/// ele vai cair — a vaga é que anda entre os outros. Enquanto arrasta, o
/// quadro não recebe ponteiro: é o que deixa `elementFromPoint` enxergar o
/// quadro debaixo dele.
function drag(el: HTMLElement, head: HTMLElement) {
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let ghost: HTMLElement | null = null;
    const start = () => {
      const box = el.getBoundingClientRect();
      ghost = h("div", "tile ghost");
      ghost.append(head.cloneNode(true));
      ghost.style.width = `${box.width}px`;
      ghost.style.height = `${box.height}px`;
      ghost.style.left = `${box.left}px`;
      ghost.style.top = `${box.top}px`;
      document.body.append(ghost);
      el.classList.add("dragging");
      dragging = true;
    };
    gesture(
      (m) => {
        if (!ghost) {
          if (Math.hypot(m.clientX - x0, m.clientY - y0) < DRAG_START) return;
          start();
        }
        ghost!.style.transform = `translate(${m.clientX - x0}px, ${m.clientY - y0}px)`;
        const over = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>(".tile");
        if (!over || over === el) return;
        const box = over.getBoundingClientRect();
        if (m.clientX < box.left + box.width / 2) over.before(el);
        else over.after(el);
      },
      () => {
        if (!ghost) return;
        ghost.remove();
        el.classList.remove("dragging");
        dragging = false;
        layout.order = [...$("tiles").querySelectorAll<HTMLElement>(".tile")].map((x) => x.dataset.tab!);
        save();
      },
    );
  });
}

/// A alça no canto de baixo: arrastar muda largura e altura, e o tamanho fica.
/// O mínimo é do CSS — o que se grava é o que a tela mediu depois dele. Duplo
/// clique volta ao tamanho padrão, como a alça do painel lateral.
function grip(el: HTMLElement, id: string) {
  const handle = template(
    "div",
    "tile-grip",
    `<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 1 1 9M9 5 5 9"/></svg>`,
  );
  handle.title = t("desk.grip");
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = el.offsetWidth;
    const h0 = el.offsetHeight;
    el.classList.add("sizing");
    gesture(
      (m) => {
        el.style.width = `${w0 + m.clientX - x0}px`;
        el.style.height = `${h0 + m.clientY - y0}px`;
      },
      () => {
        el.classList.remove("sizing");
        layout.sizes[id] = [el.offsetWidth, el.offsetHeight];
        save();
      },
    );
  });
  handle.addEventListener("dblclick", () => {
    el.style.width = "";
    el.style.height = "";
    delete layout.sizes[id];
    save();
  });
  el.append(handle);
}

/// Onde um arquivo solto sobre a mesa cai: no quadro debaixo do cursor, como
/// anexo da fala daquela conversa — a mesma regra do "+" da caixa. Fora de um
/// quadro, ou num quadro que não aceita anexo, não cai em lugar nenhum.
export function dropTarget(el: Element | null): { host: HTMLElement; put: (paths: string[]) => void; wait: () => () => void } | null {
  const id = el?.closest<HTMLElement>(".tile")?.dataset.tab;
  const tile = id ? tiles.get(id) : undefined;
  const target = tile?.view.fileDropTarget();
  return tile && target ? { host: tile.el, ...target } : null;
}
