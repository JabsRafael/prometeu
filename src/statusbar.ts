import { brand } from "./icons";
import { t } from "./i18n";
import { $ } from "./util";

/// A faixa de baixo: quanto da cota de cada agente já foi.
///
/// O número não é da conversa aberta nem do workspace — é da conta, e vale
/// para o app inteiro. Quem o recolhe é o back (`usage.rs`), a cada resposta
/// de qualquer aba; aqui só se desenha o que chegou.
///
/// Na faixa cabe o essencial: a janela mais cheia vira a barrinha, e as duas
/// aparecem como `5h 16% · 7d 50%`. Quando cada uma zera é o que se lê no
/// painel, que abre no clique — porque é a pergunta que se faz uma vez por
/// dia, e não a cada olhada para o rodapé.

export type Window = { kind: string; pct: number; resets: number };
export type Agent = { windows: Window[]; at: number };
export type Usage = Record<string, Agent>;

/// Quanto da janela já foi antes de a barra sair do cinza. Abaixo disso o
/// número é informação; daqui para cima é aviso, e no fim é o que interrompe
/// o trabalho.
const WARN = 75;
const HOT = 90;

let usage: Usage = {};

export function show(next: Usage) {
  usage = next;
  draw();
}

/// O nome da janela na faixa. Curto de propósito: é o rótulo que cabe ao lado
/// do número sem virar frase.
const SHORT: Record<string, string> = { session: "5h", weekly: "7d", overage: "+" };

function draw() {
  const bar = $("status");
  bar.innerHTML = "";
  for (const [agent, data] of Object.entries(usage)) {
    if (!data.windows.length) continue;
    const chip = document.createElement("button");
    chip.className = "uchip";
    chip.title = t("status.usage");
    chip.innerHTML =
      brand(agent) +
      meter(Math.max(...data.windows.map((w) => w.pct))) +
      `<span class="utext">${data.windows
        .map((w) => `${SHORT[w.kind] ?? w.kind} ${Math.round(w.pct)}%`)
        .join(" · ")}</span>`;
    chip.addEventListener("click", (e) => open(e.currentTarget as HTMLElement, e));
    bar.append(chip);
  }
  bar.hidden = !bar.childElementCount;
}

/// A barrinha. `pct` já vem de 0 a 100.
function meter(pct: number, wide = false): string {
  const level = pct >= HOT ? " hot" : pct >= WARN ? " warn" : "";
  return (
    `<span class="meter${wide ? " wide" : ""}${level}">` +
    `<i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></span>`
  );
}

/* ---------- o painel ---------- */

let panel: HTMLElement | null = null;

export function close() {
  panel?.remove();
  panel = null;
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

/// Abre em cima da faixa, encostado no chip que foi clicado. Todos os agentes
/// no mesmo painel: um submenu por agente seria um clique a mais para ver dois
/// números que cabem juntos.
function open(at: HTMLElement, e: MouseEvent) {
  if (panel) return close();
  e.stopPropagation();
  panel = document.createElement("div");
  panel.className = "upop";
  panel.innerHTML = `<div class="uhead">${t("status.usage")}</div>` + body();
  document.body.append(panel);
  const box = at.getBoundingClientRect();
  const mine = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(box.left, innerWidth - mine.width - 8))}px`;
  panel.style.top = `${box.top - mine.height - 6}px`;
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
}

function body(): string {
  return Object.entries(usage)
    .map(
      ([agent, data]) =>
        `<div class="uagent">${brand(agent)}<span class="uname">${label(agent)}</span>` +
        `<span class="uwhen">${ago(data.at)}</span></div>` +
        data.windows
          .map(
            (w) =>
              `<div class="urow"><span class="ukind">${kind(w.kind)}</span>` +
              meter(w.pct, true) +
              `<span class="upct">${Math.round(w.pct)}%</span>` +
              `<span class="ureset">${t("status.resets", { when: until(w.resets) })}</span></div>`,
          )
          .join(""),
    )
    .join("");
}

/// Nome do agente é nome próprio: não passa pelo catálogo.
const label = (agent: string) => (agent === "codex" ? "Codex" : "Claude");

function kind(name: string): string {
  if (name === "session") return t("status.window.session");
  if (name === "weekly") return t("status.window.weekly");
  if (name === "overage") return t("status.window.overage");
  return name;
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
