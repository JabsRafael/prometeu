import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { t } from "./i18n";
import { $ } from "./util";

/// Atualização sem reinstalar nada: o app pergunta a um manifesto público se
/// existe versão nova, baixa o bundle, confere a assinatura minisign com a
/// chave que está embutida nele e troca o `.app` no lugar. O `.dmg` continua
/// existindo, mas só serve para a primeira instalação.
///
/// Tudo em segundo plano e sem susto: nada é baixado sem você mandar, e nada é
/// aplicado sem você reiniciar. O rodapé da barra lateral é onde isso aparece,
/// porque é onde a versão já estava.

/// De quanto em quanto tempo perguntar. O app fica aberto o dia inteiro, e
/// checar só no boot faria a atualização esperar o próximo reinício.
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
export type Phase =
  | { at: "quiet" }
  | { at: "found"; update: Found }
  | { at: "downloading"; update: Found; got: number; total: number }
  | { at: "ready"; version: string }
  | { at: "restarting"; version: string };

/// O que o botão mostra numa fase. `null` é botão escondido. `ready` é a cor
/// cheia: a partir daí o clique reinicia o app, e o botão tem que parecer isso.
export type Face = { text: string; title: string; disabled: boolean; ready: boolean } | null;

export function face(phase: Phase): Face {
  switch (phase.at) {
    case "quiet":
      return null;
    case "found":
      return {
        text: t("update.found", { version: phase.update.version }),
        title: phase.update.body?.trim() || t("update.found.title", { version: phase.update.version }),
        disabled: false,
        ready: false,
      };
    case "downloading":
      return {
        text: phase.total
          ? t("update.downloading", { pct: Math.round((phase.got / phase.total) * 100) })
          : t("update.downloading.unknown"),
        title: "",
        disabled: true,
        ready: false,
      };
    case "ready":
      return {
        text: t("update.ready"),
        title: t("update.ready.title", { version: phase.version }),
        disabled: false,
        ready: true,
      };
    case "restarting":
      return { text: t("update.restarting"), title: "", disabled: true, ready: true };
  }
}

/// O que a máquina precisa do mundo: perguntar, reiniciar, desenhar e avisar.
/// Em `init` é o Tauri e o botão; nos testes, é o que o teste quiser.
export type Io = {
  check: () => Promise<Found | null>;
  relaunch: () => Promise<void>;
  show: (face: Face) => void;
  say: (text: string, isError?: boolean) => void;
};

export function updater(io: Io) {
  let phase: Phase = { at: "quiet" };
  const go = (next: Phase) => {
    phase = next;
    io.show(face(phase));
  };

  const look = async () => {
    // Já achou, ou já está baixando: perguntar de novo só atrapalharia.
    if (phase.at !== "quiet") return;
    let update: Found | null;
    try {
      update = await io.check();
    } catch {
      // Sem rede, GitHub fora do ar, manifesto ainda não publicado — nenhum
      // deles é problema seu. Quem quiser atualizar volta aqui em seis horas.
      return;
    }
    if (update && phase.at === "quiet") go({ at: "found", update });
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
  };

  return { look, click, phase: () => phase };
}

export async function init(say: Io["say"]) {
  $("ver").textContent = `v${await getVersion()}`;

  const btn = $("update") as HTMLButtonElement;
  const up = updater({
    check,
    relaunch,
    say,
    show: (face) => {
      btn.hidden = !face;
      if (!face) return;
      btn.textContent = face.text;
      btn.title = face.title;
      btn.disabled = face.disabled;
      btn.classList.toggle("ready", face.ready);
    },
  });

  btn.addEventListener("click", () => void up.click());
  void up.look();
  setInterval(() => void up.look(), EVERY);
}
