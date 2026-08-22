import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
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

let found: Update | null = null;
let busy = false;

export async function init(say: (text: string, isError?: boolean) => void) {
  $("ver").textContent = `v${await getVersion()}`;

  const btn = $("update") as HTMLButtonElement;

  const look = async () => {
    // Já achou, ou já está baixando: perguntar de novo só atrapalharia.
    if (found || busy) return;
    try {
      found = await check();
    } catch {
      // Sem rede, GitHub fora do ar, manifesto ainda não publicado — nenhum
      // deles é problema seu. Quem quiser atualizar volta aqui em seis horas.
      return;
    }
    if (!found) return;
    btn.hidden = false;
    btn.textContent = `Atualizar para ${found.version}`;
    btn.title = found.body?.trim() || `Versão ${found.version} disponível`;
  };

  btn.addEventListener("click", async () => {
    if (!found || busy) return;

    // Segundo clique: o bundle já foi trocado no disco, falta trocar o que
    // está na memória. Reiniciar derruba as sessões — nenhuma sobrevive ao
    // fechamento do app de todo modo, mas quem escolhe a hora é você.
    if (btn.dataset.done) {
      await relaunch();
      return;
    }

    busy = true;
    btn.disabled = true;
    let total = 0;
    let got = 0;
    try {
      await found.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") got += e.data.chunkLength;
        btn.textContent = total ? `Baixando ${Math.round((got / total) * 100)}%` : "Baixando…";
      });
      btn.dataset.done = "1";
      btn.disabled = false;
      btn.classList.add("ready");
      btn.textContent = "Reiniciar para aplicar";
      btn.title = "As conversas abertas param — elas não sobrevivem ao reinício, e voltam de onde pararam";
    } catch (err) {
      // Aqui o silêncio não serve: foi você que clicou.
      busy = false;
      btn.disabled = false;
      btn.textContent = `Atualizar para ${found.version}`;
      say(`não deu para atualizar: ${err}`, true);
    }
  });

  void look();
  setInterval(look, EVERY);
}
