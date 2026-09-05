import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "./icons";
import { parseConversationEvent } from "./conversation";
import { t } from "./i18n";
import * as team from "./team";
import type { Board } from "./types";
import { template } from "./util";

/// Avisar quem não está olhando: o agente parou e espera você (terminou, ou
/// travou numa pergunta), ou um colega escreveu um comentário te marcando.
///
/// Dois avisos, e nenhum deles é uma notificação do sistema: um "pling" curto,
/// e a bolinha no ícone do Dock com quantas coisas esperam resposta. O som
/// tem chavinha em Configurações (guardada neste Mac, `prometeu:som`); a
/// bolinha não — ela é o que o Dock já faz por qualquer app, e só some quando
/// não há nada esperando.
///
/// O som nasce dos eventos ao vivo da conversa, nunca de diferenças entre
/// snapshots do quadro. Uma pendência avisa uma vez até ser vista ou respondida;
/// atividade automática não rearma o sino.

const SOUND_KEY = "prometeu:som";

/// Ligado por padrão: quem não quer, desliga.
export const soundOn = () => localStorage.getItem(SOUND_KEY) !== "0";
export function setSound(on: boolean) {
  on ? localStorage.removeItem(SOUND_KEY) : localStorage.setItem(SOUND_KEY, "0");
}

/* ---------- estado ---------- */

type Ctx = {
  /// Abas visíveis no workspace ou na mesa; o foco da janela é conferido aqui.
  visible: (tab: string) => boolean;
};

let ctx: Ctx = { visible: () => false };
let owners = new Map<string, string>();
/// Aba que parou sem ser vista, ligada ao workspace para contar o Dock.
const pending = new Map<string, string>();
let unread = new Set<string>();
/// Os comentários da caixa que já passaram por aqui: o mesmo comentário chega
/// de novo a cada reconexão, e comentário velho não apita duas vezes.
const known = new Set<string>();

export function init(context: Ctx) {
  ctx = context;
  // WebKit deixa o áudio mudo até a primeira interação. O contexto nasce no
  // primeiro clique ou tecla, que sempre acontece muito antes de um agente
  // terminar alguma coisa.
  const wake = () => {
    audio();
    window.removeEventListener("pointerdown", wake);
    window.removeEventListener("keydown", wake);
  };
  window.addEventListener("pointerdown", wake);
  window.addEventListener("keydown", wake);
  // A janela voltou para a frente: o que está na tela foi visto.
  window.addEventListener("focus", looked);
}

/// Abrir uma conversa ou voltar à janela reconhece as pendências visíveis.
export function looked() {
  if (!pending.size || !document.hasFocus()) return;
  for (const tab of pending.keys()) if (ctx.visible(tab)) pending.delete(tab);
  badge();
}

/// O quadro só informa ownership e unread. Status pode oscilar ou chegar em
/// snapshots defasados de processos concorrentes; isso não é um novo aviso.
export function boardChanged(board: Board) {
  const local = board.workspaces.filter((w) => !w.archived && !w.cleaned && !w.remote);
  owners = new Map(local.flatMap((w) => w.tabs.map((tab) => [tab.id, w.id] as const)));
  unread = new Set(local.filter((w) => w.unread).map((w) => w.id));
  for (const tab of pending.keys()) if (!owners.has(tab)) pending.delete(tab);
  if (document.hasFocus()) {
    for (const tab of pending.keys()) if (ctx.visible(tab)) pending.delete(tab);
  }
  badge();
}

/// Somente o stream local ao vivo entra aqui. Snapshot e replay não notificam.
export function chatChanged(tab: string, line: string) {
  const workspace = owners.get(tab);
  if (!workspace) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  const event = parseConversationEvent(value);
  if (!event) return;
  if (event.type === "user.message" || event.type === "request.closed") {
    pending.delete(tab);
    badge();
    return;
  }
  if (event.type !== "turn.completed" && event.type !== "request.opened") return;
  if (event.type === "turn.completed" && event.outcome === "interrupted") return;
  if (document.hasFocus() && ctx.visible(tab)) return;
  if (pending.has(tab)) return;
  pending.set(tab, workspace);
  pling();
  badge();
}

/// O time mudou — talvez a caixa "para mim".
export function teamChanged() {
  let news = false;
  for (const item of team.inboxItems()) {
    if (known.has(item.id)) continue;
    known.add(item.id);
    news = true;
  }
  if (news) pling();
  badge();
}

/* ---------- a bolinha ---------- */

/// Quantas coisas esperam você: workspaces não lidos (pelo back ou por aqui)
/// mais comentários na caixa. Zero apaga a bolinha.
export const waiting = () => new Set([...unread, ...pending.values()]).size + team.inboxCount();

function badge() {
  getCurrentWindow()
    .setBadgeCount(waiting() || undefined)
    .catch((e) => {
      // Sem Dock (navegador puro) não há bolinha; a tela segue igual.
      console.warn("badge", e);
    });
}

/* ---------- o som ---------- */

let actx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  actx ??= new AudioContext();
  if (actx.state === "suspended") void actx.resume();
  return actx;
}

/// Um "pling" de sino de balcão: uma nota e um parcial agudo por cima, os dois
/// morrendo rápido. Sintetizado aqui — não há arquivo de som para carregar.
export function pling() {
  if (!soundOn()) return;
  const ac = audio();
  if (!ac) return;
  const at = ac.currentTime;
  const out = ac.createGain();
  out.gain.value = 0.5;
  out.connect(ac.destination);
  for (const [freq, gain, decay] of [
    [1046.5, 0.5, 0.55],
    [2637, 0.14, 0.25],
  ]) {
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + decay + 0.05);
  }
}

/* ---------- a linha de Configurações ---------- */

export function settingsRow(): HTMLElement {
  const row = template(
    "div",
    "setrow",
    `<span class="glyph">${icon("bell", 18)}</span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".txt b")!.textContent = t("settings.sound");
  row.querySelector(".txt span")!.textContent = t("settings.sound.body");
  const sw = template("button", "ghost sw", `<span></span><i class="knob"></i>`) as HTMLButtonElement;
  sw.setAttribute("role", "switch");
  const paint = () => {
    const on = soundOn();
    sw.classList.toggle("on", on);
    sw.setAttribute("aria-checked", String(on));
    sw.children[0].textContent = t(on ? "settings.sound.on" : "settings.sound.off");
  };
  sw.addEventListener("click", () => {
    setSound(!soundOn());
    paint();
    // Ligar toca uma vez: é a chance de ouvir como é antes de precisar.
    pling();
  });
  paint();
  row.querySelector(".act")!.append(sw);
  return row;
}
