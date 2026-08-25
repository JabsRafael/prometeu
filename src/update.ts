import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { icon } from "./icons";
import { current as locale, t } from "./i18n";
import { $, h } from "./util";

/// Atualização sem reinstalar nada: o app pergunta a um manifesto público se
/// existe versão nova, baixa o bundle, confere a assinatura minisign com a
/// chave que está embutida nele e troca o `.app` no lugar. O `.dmg` continua
/// existindo, mas só serve para a primeira instalação.
///
/// Tudo em segundo plano e sem susto: nada é baixado sem você mandar, e nada é
/// aplicado sem você reiniciar. Isso aparece em dois lugares, com papéis
/// diferentes:
///
/// - o rodapé da barra lateral **avisa**. Fica escondido enquanto não há o que
///   fazer, e acende quando tem o que baixar ou reiniciar.
/// - a linha em Configurações **responde**. Está sempre lá, com a versão, o
///   resultado da última pergunta e o botão de perguntar de novo — que é o
///   "Check for Updates…" que todo app de Mac tem.
///
/// Uma fase só alimenta os dois: o mesmo verbo no botão dos dois lados.

/// De quanto em quanto tempo perguntar sozinho. O app fica aberto o dia
/// inteiro, e checar só no boot faria a atualização esperar o próximo reinício.
const EVERY = 6 * 60 * 60 * 1000;

/// Quanto esperar o app cair depois de pedir o reinício. O comando responde na
/// hora e o processo morre logo depois; se passou isso e ainda estamos aqui, o
/// reinício não aconteceu — e a pessoa precisa saber, em vez de clicar de novo.
const STUCK = 8_000;

/// O que o botão precisa saber de uma atualização encontrada. É o `Update` do
/// plugin, reduzido ao que se usa — e é isto que os testes fingem.
export type Found = Pick<Update, "version" | "body" | "downloadAndInstall">;

/// Por onde a atualização anda. Uma fase só, e não um par de booleanos: o
/// clique faz uma coisa em cada fase, e não existe combinação sem sentido.
/// Foi um `busy` esquecido em `true` depois do download que deixou o botão de
/// reiniciar sem fazer nada.
///
/// `quiet` é só o instante antes da primeira resposta. Depois dela a fase
/// sempre diz alguma coisa: `fresh` com a hora, `failed` com o motivo, ou uma
/// atualização a caminho.
export type Phase =
  | { at: "quiet" }
  | { at: "checking" }
  | { at: "fresh"; when: string }
  | { at: "failed"; why: string }
  | { at: "found"; update: Found }
  | { at: "downloading"; update: Found; got: number; total: number }
  | { at: "ready"; version: string }
  | { at: "restarting"; version: string };

/// O que os dois lugares mostram numa fase. `footer` é o que o rodapé faz com
/// isso: só aparece quando o botão tem serventia. `note` e `tone` são a linha
/// de Configurações, que fala mesmo quando não há nada a fazer.
export type View = {
  text: string;
  title: string;
  disabled: boolean;
  /// A cor cheia: a partir daí o clique reinicia o app, e o botão tem que
  /// parecer isso.
  ready: boolean;
  footer: boolean;
  note: string;
  tone: "plain" | "ok" | "bad";
};

/// O botão parado: "pergunte de novo". Vale nas três fases em que não há
/// download nem reinício a caminho, e é onde o texto é sempre o mesmo.
const ask = () => ({
  text: t("update.ask"),
  title: t("update.ask.title"),
  disabled: false,
  ready: false,
  footer: false,
});

export function view(phase: Phase): View {
  switch (phase.at) {
    case "quiet":
      return { ...ask(), note: "", tone: "plain" };
    case "checking":
      return {
        text: t("update.checking"),
        title: "",
        disabled: true,
        ready: false,
        footer: false,
        note: t("update.checking.note"),
        tone: "plain",
      };
    case "fresh":
      // Sem tom: estar em dia é o normal, e o verde fica valendo para quando
      // alguma coisa de fato aconteceu.
      return { ...ask(), note: t("update.fresh", { when: phase.when }), tone: "plain" };
    case "failed":
      return { ...ask(), note: t("update.failedCheck", { why: phase.why }), tone: "bad" };
    case "found":
      return {
        text: t("update.found", { version: phase.update.version }),
        title: phase.update.body?.trim() || t("update.found.title", { version: phase.update.version }),
        disabled: false,
        ready: false,
        footer: true,
        note: t("update.found.note", { version: phase.update.version }),
        tone: "plain",
      };
    case "downloading":
      return {
        text: phase.total
          ? t("update.downloading", { pct: Math.round((phase.got / phase.total) * 100) })
          : t("update.downloading.unknown"),
        title: "",
        disabled: true,
        ready: false,
        footer: true,
        note: t("update.downloading.note", { version: phase.update.version }),
        tone: "plain",
      };
    case "ready":
      return {
        text: t("update.ready"),
        title: t("update.ready.title", { version: phase.version }),
        disabled: false,
        ready: true,
        footer: true,
        note: t("update.ready.note", { version: phase.version }),
        tone: "ok",
      };
    case "restarting":
      return {
        text: t("update.restarting"),
        title: "",
        disabled: true,
        ready: true,
        footer: true,
        note: t("update.restarting"),
        tone: "plain",
      };
  }
}

/// O que a máquina precisa do mundo: perguntar, reiniciar, ver que horas são,
/// desenhar e avisar. Em `init` é o Tauri e a tela; nos testes, é o que o teste
/// quiser.
export type Io = {
  check: () => Promise<Found | null>;
  relaunch: () => Promise<void>;
  clock: () => string;
  show: (view: View) => void;
  say: (text: string, isError?: boolean) => void;
};

/// Fases em que perguntar de novo faz sentido: ninguém está esperando download
/// nem reinício.
const idle = (phase: Phase) => phase.at === "quiet" || phase.at === "fresh" || phase.at === "failed";

export function updater(io: Io) {
  let phase: Phase = { at: "quiet" };
  const go = (next: Phase) => {
    phase = next;
    io.show(view(phase));
  };
  /// Em que fase estamos agora — depois de um `await`, e não antes dele. O
  /// TypeScript não vê o `go` mexer no `phase`, e continuaria acreditando na
  /// fase de quando a espera começou.
  const at = () => phase.at;

  /// `mine` é o clique seu. É o que decide o que fazer quando dá errado: se foi
  /// o relógio de seis horas que perguntou, sem rede não é problema seu e a
  /// linha continua dizendo o que dizia. Se foi você, você merece o motivo.
  const look = async (mine = false) => {
    if (!idle(phase)) return;
    const before = phase;
    go({ at: "checking" });
    let update: Found | null;
    try {
      update = await io.check();
    } catch (err) {
      // Sem rede, GitHub fora do ar, manifesto ainda não publicado — nenhum
      // deles precisa de barulho se ninguém pediu.
      go(mine ? { at: "failed", why: String(err) } : before);
      return;
    }
    if (at() !== "checking") return;
    go(update ? { at: "found", update } : { at: "fresh", when: io.clock() });
  };

  const download = async (update: Found) => {
    go({ at: "downloading", update, got: 0, total: 0 });
    const progress = (e: DownloadEvent) => {
      if (phase.at !== "downloading") return;
      if (e.event === "Started") go({ ...phase, total: e.data.contentLength ?? 0 });
      if (e.event === "Progress") go({ ...phase, got: phase.got + e.data.chunkLength });
    };
    try {
      await update.downloadAndInstall(progress);
      go({ at: "ready", version: update.version });
    } catch (err) {
      // Aqui o silêncio não serve: foi você que clicou.
      go({ at: "found", update });
      io.say(t("update.failed", { err: String(err) }), true);
    }
  };

  // O bundle já foi trocado no disco, falta trocar o que está na memória.
  // Reiniciar derruba as sessões — nenhuma sobrevive ao fechamento do app de
  // todo modo, mas quem escolhe a hora é você.
  const restart = async (version: string) => {
    go({ at: "restarting", version });
    try {
      await io.relaunch();
    } catch (err) {
      go({ at: "ready", version });
      io.say(t("update.restartFailed", { err: String(err) }), true);
      return;
    }
    await new Promise((r) => setTimeout(r, STUCK));
    if (phase.at !== "restarting") return;
    go({ at: "ready", version });
    io.say(t("update.stuck", { version }), true);
  };

  const click = async () => {
    if (phase.at === "found") await download(phase.update);
    else if (phase.at === "ready") await restart(phase.version);
    else if (idle(phase)) await look(true);
  };

  return { look, click, phase: () => phase };
}

/* ---------- as duas telas ---------- */

let now: View = view({ at: "quiet" });
let ver = "";
let row: HTMLElement | null = null;
let click: () => void = () => {};

const clock = () => new Date().toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

function dress(btn: HTMLButtonElement) {
  btn.textContent = now.text;
  btn.title = now.title;
  btn.disabled = now.disabled;
}

function paintRow(el: HTMLElement) {
  const note = el.querySelector(".txt > span")!;
  note.textContent = now.note;
  note.className = now.tone === "plain" ? "" : now.tone;
  const btn = el.querySelector("button") as HTMLButtonElement;
  dress(btn);
  btn.className = now.ready ? "pri md" : "outline md";
}

function paint() {
  const foot = $("update") as HTMLButtonElement;
  foot.hidden = !now.footer;
  dress(foot);
  foot.classList.toggle("ready", now.ready);

  // A página de Configurações é redesenhada inteira a cada visita; a linha de
  // antes fica órfã, e pintar nela seria pintar no vazio.
  if (!row?.isConnected) row = null;
  else paintRow(row);
}

/// A linha de Configurações. Quem monta a página pede uma; ela se redesenha
/// sozinha enquanto estiver na tela.
export function settingsRow(): HTMLElement {
  const el = h(
    "div",
    "setrow",
    `<span class="glyph">${icon("rotate", 18)}</span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  el.querySelector("b")!.textContent = ver ? `Prometheus ${ver}` : "Prometheus";
  const btn = h("button", "outline md") as HTMLButtonElement;
  btn.addEventListener("click", () => click());
  el.querySelector(".act")!.append(btn);
  // Nasce já com a fase de agora — ela é mais velha que a página.
  paintRow(el);
  row = el;
  return el;
}

export async function init(say: Io["say"]) {
  ver = `v${await getVersion()}`;
  $("ver").textContent = ver;

  const up = updater({
    check,
    relaunch,
    clock,
    say,
    show: (next) => {
      now = next;
      paint();
    },
  });
  click = () => void up.click();

  $("update").addEventListener("click", () => click());
  // A primeira pergunta sai junto com o app: o primeiro estado que a linha de
  // Configurações mostra já é verdade, em vez de um "buscar" que ninguém pediu.
  void up.look();
  setInterval(() => void up.look(), EVERY);
}
