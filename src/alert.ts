import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "./icons";
import { t } from "./i18n";
import * as team from "./team";
import type { Board, Status } from "./types";
import { template } from "./util";

/// Avisar quem não está olhando: o agente parou e espera você (terminou, ou
/// travou numa pergunta), ou um colega escreveu uma nota te marcando.
///
/// Dois avisos, e nenhum deles é uma notificação do sistema: um "pling" curto,
/// e a bolinha no ícone do Dock com quantas coisas esperam resposta. O som
/// tem chavinha em Configurações (guardada neste Mac, `prometheus:som`); a
/// bolinha não — ela é o que o Dock já faz por qualquer app, e só some quando
/// não há nada esperando.
///
/// Novidade é parar sem você ver: a sessão que parou não é a que está na
/// tela, ou a janela está atrás de outra coisa. Você viu terminar na sua
/// frente: não precisa de aviso. O back guarda a primeira metade disso em
/// `ws.unread` (ele sabe qual workspace está na tela, não se a janela está na
/// frente); a segunda só a tela sabe, e fica aqui — até você olhar de novo.

const SOUND_KEY = "prometheus:som";

/// Ligado por padrão: quem não quer, desliga.
export const soundOn = () => localStorage.getItem(SOUND_KEY) !== "0";
export function setSound(on: boolean) {
  on ? localStorage.removeItem(SOUND_KEY) : localStorage.setItem(SOUND_KEY, "0");
}

/* ---------- o que é novidade ---------- */

const waits = (s: Status) => s === "pronta" || s === "querendo";

/// Compara o quadro que chegou com o status de cada aba no quadro anterior.
/// Devolve os workspaces em que alguma aba acabou de parar esperando alguém —
/// uma aba que já estava esperando (ou que nasceu assim) não é notícia — e o
/// mapa de status para a próxima comparação.
export function stopped(prev: Map<string, Status>, board: Board): { fresh: string[]; now: Map<string, Status> } {
  const now = new Map<string, Status>();
  const fresh: string[] = [];
  for (const ws of board.workspaces) {
    for (const tab of ws.tabs) {
      now.set(tab.id, tab.status);
      const was = prev.get(tab.id);
      if (was !== undefined && !waits(was) && waits(tab.status) && !fresh.includes(ws.id)) fresh.push(ws.id);
    }
  }
  return { fresh, now };
}

/* ---------- estado ---------- */

type Ctx = {
  /// O workspace que está na tela agora — o único em que parar não é notícia.
  looking: () => string | null;
};

let ctx: Ctx = { looking: () => null };
let statuses = new Map<string, Status>();
/// Workspaces que pararam sem você ver, e que você ainda não abriu com a
/// janela na frente. Somados aos `unread` do back, dão a bolinha.
const pending = new Set<string>();
let unread = new Set<string>();
/// As notas da caixa que já foram vistas passar por aqui: a mesma nota chega
/// de novo a cada reconexão, e nota velha não apita duas vezes.
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

/// Você está olhando o workspace na tela, com a janela na frente: ele deixa
/// de ser novidade. Chamado ao abrir um workspace e quando a janela ganha foco.
export function looked() {
  const id = ctx.looking();
  if (!id || !document.hasFocus() || !pending.delete(id)) return;
  badge();
}

/// O quadro do Rust mudou. Só ele: os workspaces dos colegas não são seus
/// para responder.
export function boardChanged(board: Board) {
  const { fresh, now } = stopped(statuses, board);
  statuses = now;
  unread = new Set(board.workspaces.filter((w) => w.unread).map((w) => w.id));
  const unseen = fresh.filter((id) => id !== ctx.looking() || !document.hasFocus());
  for (const id of unseen) pending.add(id);
  // Workspace que sumiu do quadro (removido, arquivado) não deve nada.
  const alive = new Set(board.workspaces.map((w) => w.id));
  for (const id of pending) if (!alive.has(id)) pending.delete(id);
  if (unseen.length) pling();
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
/// mais notas na caixa. Zero apaga a bolinha.
export const waiting = () => new Set([...unread, ...pending]).size + team.inboxCount();

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
