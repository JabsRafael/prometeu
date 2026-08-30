/// Link para fora do app. A janela do Prometheus é o Prometheus: clicar num
/// link do texto do agente abre o navegador do computador, e não navega a tela
/// para longe do app. A aba de navegador de dentro (`browser.ts`) continua
/// sendo só o Run.
import { invoke } from "./ipc";
import { fromBack } from "./i18n";

/// O endereço a abrir de fora, ou `null` para o clique seguir seu caminho.
/// Só `http`/`https`: `#` é o que o markdown escreve quando recusa um link
/// (ver `markdown.ts`), e âncora dentro da página não é assunto do navegador.
export function external(href: string | null | undefined): string | null {
  return href && /^https?:\/\//i.test(href) ? href : null;
}

export function init(say: (m: string, err?: boolean) => void) {
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a");
    if (!a) return;
    // Nenhum link daqui navega a janela — nem o que este app não sabe abrir.
    e.preventDefault();
    const url = external(a.getAttribute("href"));
    if (url) invoke("open_external", { url }).catch((err) => say(fromBack(err), true));
  });
}
