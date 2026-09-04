import { openCleanup } from "./cleanup";
import type { AgentDescriptor } from "./agents";
import { brand, icon } from "./icons";
import { fromBack, t } from "./i18n";
import * as menu from "./menu";
import { invoke } from "./ipc";
import type { Board } from "./types";
import { $ } from "./util";

/// A faixa de baixo: o que os agentes já gastaram da cota, e o que o app está
/// custando à máquina.
///
/// Nada aqui é do workspace aberto. A cota é da conta, a memória é do app
/// inteiro, os terminais e as portas são de todos os workspaces — é o único
/// lugar da tela que não muda quando você troca de card, e é por isso que ela
/// atravessa a janela por baixo de tudo.
///
/// Na faixa cabe o número; o resto abre no clique. Um painel por assunto, e
/// nenhum deles com submenu: são poucas linhas, e todas cabem à vista.

export type Window = { kind: string; pct: number; resets: number; scope?: string; label?: string };
export type Agent = { windows: Window[]; at: number };
export type Usage = Record<string, Agent>;

export type Proc = { kind: string; name: string; detail: string; rss: number; cpu: number; hist: number[] };
export type Port = { id: string; title: string; port: number };
export type Machine = { rss: number; cpu: number; procs: Proc[]; terms: number; ports: Port[] };

/// Quanto da janela já foi antes de a barra sair do cinza. Abaixo disso o
/// número é informação; daqui para cima é aviso, e no fim é o que interrompe
/// o trabalho.
const WARN = 75;
const HOT = 90;

let usage: Usage = {};
/// Quais agentes desenhar, tenham leitura ou não. Até o back responder, o de
/// antes: o app era só o Claude Code.
let agents: Pick<AgentDescriptor, "id" | "label">[] = [{ id: "claude", label: "Claude" }];
let machine: Machine = { rss: 0, cpu: 0, procs: [], terms: 0, ports: [] };
let say: (text: string, isError?: boolean) => void = () => {};

/// Quando não deixar o Mac dormir. A escolha é deste Mac e fica nele, como a
/// do idioma — não é coisa que se sincronize entre máquinas.
type Awake = "on" | "agent" | "off";
const AWAKE_STORE = "prometeu:acordado";
const AWAKE: Awake[] = ["on", "agent", "off"];
let awake: Awake = read();
/// Há agente trabalhando agora. Sai do quadro, e é o que decide o modo
/// "enquanto trabalha".
let working = false;
/// O que o back já sabe. Sem isto, cada mudança de quadro mandaria um pedido.
let held: boolean | null = null;

/// Fora do navegador (vitest roda em node) não há `localStorage`: o módulo
/// continua de pé, desligado.
function read(): Awake {
  try {
    const saved = localStorage.getItem(AWAKE_STORE);
    return AWAKE.find((mode) => mode === saved) ?? "off";
  } catch {
    return "off";
  }
}

export function init(hooks: { say: (text: string, isError?: boolean) => void }) {
  say = hooks.say;
  hold();
}

/// O quadro mudou: pode ter começado ou parado de trabalhar alguém.
export function boardChanged(board: Board) {
  const next = board.workspaces.some((w) => w.tabs.some((tab) => tab.status === "rodando"));
  if (next === working) return;
  working = next;
  hold();
  draw();
}

/// Segurar ou soltar. Só fala com o back quando a resposta muda: o quadro se
/// republica a cada ferramenta que um agente roda.
function hold() {
  const want = awake === "on" || (awake === "agent" && working);
  if (want === held) return;
  held = want;
  invoke("set_awake", { on: want }).catch((err) => say(fromBack(err), true));
}

const holding = () => awake === "on" || (awake === "agent" && working);

export function showUsage(next: Usage) {
  usage = next;
  draw();
  if (open === "usage") fill();
}

/// Quais CLIs estão instalados nesta máquina.
export function showAgents(have: readonly AgentDescriptor[]) {
  agents = have.map(({ id, label }) => ({ id, label }));
  draw();
}

export function showMachine(next: Machine) {
  machine = next;
  draw();
  // O painel aberto envelheceria em cima da tela: quem está olhando a lista de
  // processos está olhando justamente o que muda a cada três segundos.
  if (open === "res") fill();
}

/// O nome da janela na faixa. Curto de propósito: é o rótulo que cabe ao lado
/// do número sem virar frase.
// `overage` é como versões anteriores guardaram a janela do Fable no disco.
const SHORT: Record<string, string> = {
  session: "5h",
  weekly: "7d",
  fable: "Fable",
  overage: "Fable",
};

function shortKind(what: string): string {
  const duration = /^duration:(\d+)$/.exec(what);
  return duration ? span(Number(duration[1])) : (SHORT[what] ?? what);
}

function draw() {
  const bar = $("status");
  bar.innerHTML = "";
  // Agente instalado e sem leitura continua na faixa, com um traço no lugar do
  // número. Sumir pareceria defeito justamente na estreia: até o primeiro poll
  // do back responder (ou a primeira conversa), não há número nenhum.
  for (const agent of agents) {
    const windows = usage[agent.id]?.windows ?? [];
    bar.append(
      chip(
        "usage",
        brand(agent.id) +
          (windows.length
            ? meter(Math.max(...windows.map((w) => w.pct))) +
              `<span class="utext">${windows
                .map((w) => `${shortKind(w.kind)} ${Math.round(w.pct)}%`)
                .join(" · ")}</span>`
            : '<span class="utext dim">—</span>'),
        windows.length ? t("status.usage") : t("status.usage.none"),
      ),
    );
  }
  const gap = document.createElement("span");
  gap.className = "spacer";
  bar.append(gap);
  bar.append(
    chip(
      "awake",
      icon("coffee", 13) +
        `<span class="utext">${t(`status.awake.${awake}`)}</span>` +
        `<span class="dot${holding() ? " on" : ""}"></span>`,
      t("status.awake"),
    ),
  );
  bar.append(
    chip("res", icon("memory", 13) + `<span class="utext">${bytes(machine.rss)}</span>`, t("status.res")),
  );
  bar.append(
    chip("term", icon("terminal", 13) + `<span class="utext">${machine.terms}</span>`, t("status.terms")),
  );
  bar.append(
    chip("port", icon("plug", 13) + `<span class="utext">${machine.ports.length}</span>`, t("status.ports")),
  );
}

function chip(which: Which, html: string, title: string): HTMLElement {
  const button = document.createElement("button");
  button.className = "uchip";
  button.title = title;
  button.innerHTML = html;
  button.addEventListener("click", (e) => toggle(which, e.currentTarget as HTMLElement, e));
  return button;
}

/// A barrinha. `pct` já vem de 0 a 100.
function meter(pct: number, wide = false): string {
  const level = pct >= HOT ? " hot" : pct >= WARN ? " warn" : "";
  return (
    `<span class="meter${wide ? " wide" : ""}${level}">` +
    `<i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></span>`
  );
}

/// Bytes como a gente fala: "822.8 MB", "1.2 GB". Base 1024, que é a que o
/// Activity Monitor mostra ao lado.
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let at = 0;
  while (value >= 1024 && at < units.length - 1) {
    value /= 1024;
    at++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[at]}`;
}

/* ---------- os painéis ---------- */

type Which = "usage" | "res" | "term" | "port" | "awake";

let panel: HTMLElement | null = null;
let open: Which | null = null;

export function close() {
  panel?.remove();
  panel = null;
  open = null;
  document.removeEventListener("mousedown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", close);
}

function onDown(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".upop")) close();
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  close();
}

/// Abre em cima do chip que foi clicado, crescendo para cima — a faixa está no
/// fundo da janela, e para baixo não há para onde. Clicar de novo fecha; o
/// terminal não tem painel nenhum, o número já é a resposta inteira.
function toggle(which: Which, at: HTMLElement, e: MouseEvent) {
  const was = open;
  close();
  if (was === which || which === "term") return;
  e.stopPropagation();
  // São três linhas com uma explicação cada: é menu, e menu o app já tem.
  if (which === "awake") {
    const box = at.getBoundingClientRect();
    return menu.openAt(
      { x: box.left, y: box.top - 6, above: true },
      AWAKE.map((mode) => ({
        label: t(`status.awake.${mode}`),
        hint: t(`status.awake.${mode}.note`),
        checked: awake === mode,
        run: () => pick(mode),
      })),
      "awake",
    );
  }
  open = which;
  panel = document.createElement("div");
  panel.className = `upop ${which}`;
  document.body.append(panel);
  fill();
  const box = at.getBoundingClientRect();
  const mine = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(box.left, innerWidth - mine.width - 8))}px`;
  panel.style.top = `${box.top - mine.height - 6}px`;
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
}

function pick(mode: Awake) {
  awake = mode;
  try {
    localStorage.setItem(AWAKE_STORE, mode);
  } catch {
    // Sem onde guardar, a escolha vale só até fechar. Não é motivo para não
    // atender ao clique.
  }
  hold();
  draw();
}

/// O conteúdo do painel aberto. Separado do `toggle` porque a lista de
/// processos se refaz a cada tique enquanto ela está na frente.
function fill() {
  if (!panel) return;
  panel.innerHTML = open === "usage" ? usagePanel() : open === "res" ? resPanel() : portPanel();
  if (open === "res") {
    panel.querySelector("#u-clean")?.addEventListener("click", () => {
      close();
      openCleanup(say);
    });
  }
  for (const row of panel.querySelectorAll<HTMLElement>("[data-port]")) {
    row.addEventListener("click", () => {
      invoke("open_external", { url: `http://localhost:${row.dataset.port}` }).catch((err) =>
        say(fromBack(err), true),
      );
      close();
    });
  }
}

const head = (title: string, aside = "") =>
  `<div class="uhead">${title}<span class="spacer"></span><span class="uaside">${aside}</span></div>`;

function usagePanel(): string {
  return (
    head(t("status.usage")) +
    agents.map((agent) => card(agent, usage[agent.id])).join("")
  );
}

/// Um agente no painel: o nome, de quando é a leitura, e uma linha por janela.
/// Sem leitura, a frase que explica por que ainda não há número.
function card(agent: Pick<AgentDescriptor, "id" | "label">, data?: Agent): string {
  const head =
    `<div class="uagent">${brand(agent.id)}<span class="uname">${agent.label}</span>` +
    `<span class="uwhen">${data ? ago(data.at) : ""}</span></div>`;
  if (!data?.windows.length) return head + `<div class="uempty">${t("status.usage.none")}</div>`;
  const grouped = data.windows.some((window) => window.scope)
    ? groups(data.windows)
        .map(
          ([scope, windows]) =>
            `<div class="ugroup">${esc(scopeTitle(scope, windows[0]?.label))}</div>` + rows(windows),
        )
        .join("")
    : rows(data.windows);
  return head + grouped;
}

function rows(windows: Window[]): string {
  return windows
    .map(
      (w) =>
        `<div class="urow"><span class="ukind">${kind(w.kind)}</span>` +
        meter(w.pct, true) +
        `<span class="upct">${Math.round(w.pct)}%</span>` +
        `<span class="ureset">${t("status.resets", { when: until(w.resets) })}</span></div>`,
    )
    .join("");
}

/// Mantém a ordem entregue pelo backend e reúne as janelas do mesmo bucket.
/// Exportada para testar a compatibilidade com snapshots antigos sem `scope`.
export function groups(windows: Window[]): [string, Window[]][] {
  const grouped = new Map<string, Window[]>();
  for (const window of windows) {
    const scope = window.scope ?? "general";
    grouped.set(scope, [...(grouped.get(scope) ?? []), window]);
  }
  return [...grouped];
}

function scopeTitle(scope: string, label?: string): string {
  if (scope === "general") return t("status.scope.general");
  if (scope === "code_review") return t("status.scope.codeReview");
  return label || scope;
}

function kind(what: string): string {
  if (what === "session") return t("status.window.session");
  if (what === "weekly") return t("status.window.weekly");
  if (what === "fable" || what === "overage") return t("status.window.fable");
  const duration = /^duration:(\d+)$/.exec(what);
  if (duration) return t("status.window.duration", { when: span(Number(duration[1])) });
  return what;
}

function resPanel(): string {
  const rows = machine.procs
    .map(
      (p) =>
        `<div class="prow"><span class="pname">${esc(p.name)}` +
        (p.detail ? `<em>${esc(p.kind === "term" ? dock(p.detail) : p.detail)}</em>` : "") +
        `</span>${spark(p.hist)}<span class="pcpu">${p.cpu.toFixed(1)}%</span>` +
        `<span class="prss">${bytes(p.rss)}</span></div>`,
    )
    .join("");
  return (
    head(t("status.res"), `${machine.cpu.toFixed(1)}% · ${bytes(machine.rss)}`) +
    (rows || `<div class="uempty">${t("status.res.none")}</div>`) +
    `<button class="urow act" id="u-clean">${t("status.res.clean")}${icon("chevron-right", 14)}</button>`
  );
}

/// O nome da aba do dock, como o dock a chama.
function dock(what: string): string {
  if (what === "setup") return t("dock.setup");
  if (what === "run") return t("dock.run");
  const n = /^term(\d+)$/.exec(what)?.[1];
  return n ? t("dock.terminalN", { n }) : t("dock.terminal");
}

function portPanel(): string {
  const rows = machine.ports
    .map(
      (p) =>
        `<div class="prow port" data-port="${p.port}"><span class="pport">${p.port}</span>` +
        `<span class="pname">${esc(p.title)}</span>${icon("external-link", 12)}</div>`,
    )
    .join("");
  return (
    head(t("status.ports")) + (rows || `<div class="uempty">${t("status.ports.none")}</div>`)
  );
}

/// A linha do gráfico: as leituras de CPU do processo, a mais velha à esquerda.
/// A escala é a maior leitura da própria linha — o que se quer ver é se aquilo
/// ali subiu agora, e não como se compara com o vizinho.
function spark(hist: number[]): string {
  if (hist.length < 2) return '<span class="spark"></span>';
  const top = Math.max(...hist, 1);
  const step = 100 / (hist.length - 1);
  const points = hist
    .map((v, i) => `${(i * step).toFixed(1)},${(20 - (v / top) * 18).toFixed(1)}`)
    .join(" ");
  return (
    '<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">' +
    `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.4" ` +
    'vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>'
  );
}

/// Nome de workspace e de aba são texto de quem escreveu: entram como texto, e
/// não como HTML.
function esc(text: string): string {
  const box = document.createElement("span");
  box.textContent = text;
  return box.innerHTML;
}

/* ---------- relógio ---------- */

/// "3h 15m", "3d 4h", "12m". Duas casas bastam: quem lê quer saber se dá tempo
/// de tomar um café ou se é para ir dormir.
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/// Quanto falta para a janela zerar. Já zerou é "agora": o número na tela é de
/// antes, e o próximo turno o corrige.
export function until(unix: number, from = Date.now() / 1000): string {
  return unix <= from ? t("status.now") : span(unix - from);
}

/// Quando esta leitura chegou. Menos de um minuto é "agora mesmo" — o app
/// acabou de falar com o agente.
export function ago(unix: number, from = Date.now() / 1000): string {
  const seconds = from - unix;
  return seconds < 60 ? t("status.justNow") : t("status.ago", { when: span(seconds) });
}
