/// A aba de navegador. A página é uma webview do sistema — a mesma que desenha
/// o app — que o back põe por cima do centro (ver `browser.rs`). O DOM só tem
/// o lugar dela, `#webbody`, e uma view nativa não sabe o que o CSS fez: é a
/// medida desse lugar que vai para o back toda vez que ele muda.
import { invoke } from "./ipc";
import { listen } from "@tauri-apps/api/event";
import { fromBack } from "./i18n";
import { $ } from "./util";

/// Workspace cuja webview está na tela agora.
let shown: string | null = null;

/// Um modal aberto (o `#veil`) é DOM, e a webview nativa fica por cima de todo
/// o DOM — z-index nenhum alcança ela. Enquanto o véu estiver na tela, a
/// webview se esconde; quando ele sai, volta onde estava.
let veiled = false;

/// Enquanto você está escrevendo, a barra é sua: nem o evento de navegação nem
/// a sondagem escrevem por cima do que está sendo digitado.
const bar = () => $("wurl") as HTMLInputElement;
const typing = () => document.activeElement === bar();

/// Rota de SPA troca a URL sem carregar página, e `on_navigation` não conta
/// essas. Perguntar de vez em quando é o que mantém a barra honesta.
let poll = 0;

export function init(external: (id: string) => void, say: (m: string, err?: boolean) => void) {
  // Voltar e avançar são do histórico da página, e não do histórico de telas do
  // app (as setas lá de cima): quem está testando o Run anda dentro do site.
  $("wback").addEventListener("click", () => shown && invoke("browser_back", { id: shown }));
  $("wfwd").addEventListener("click", () => shown && invoke("browser_forward", { id: shown }));
  $("wreload").addEventListener("click", () => shown && invoke("browser_reload", { id: shown }));
  $("wext").addEventListener("click", () => shown && external(shown));
  // Rail recolhendo, coluna da direita sumindo, janela mudando de tamanho:
  // tudo isso muda o buraco, e o observer pega os três.
  new ResizeObserver(place).observe($("webbody"));
  const veil = $("veil");
  new MutationObserver(() => {
    const now = !veil.hidden;
    if (now === veiled) return;
    veiled = now;
    if (!shown) return;
    if (veiled) invoke("browser_hide", { id: shown });
    else void invoke("browser_open", { id: shown }).then(place);
  }).observe(veil, { attributes: true, attributeFilter: ["hidden"] });

  bar().addEventListener("keydown", (e) => {
    if (e.key === "Enter") go(say);
    // Escape desiste da edição: a barra volta a dizer onde a página está.
    else if (e.key === "Escape") void refresh().then(() => bar().blur());
  });
  // Clicar na barra seleciona tudo: trocar de endereço é o que se faz nela, e
  // ninguém quer posicionar o cursor no meio de uma URL para apagá-la.
  bar().addEventListener("focus", () => bar().select());
  bar().addEventListener("blur", () => void refresh());

  listen<[string, string]>("browser:url", ({ payload: [id, url] }) => {
    if (id === shown && !typing()) bar().value = url;
  });
}

/// Mostra a webview do workspace no centro, criando na primeira vez. Devolve a
/// porta, que é o que a aba escreve.
export async function show(id: string): Promise<number> {
  const port = await invoke<number>("browser_open", { id });
  shown = id;
  // Aba aberta com um modal na frente: a webview espera o véu sair.
  if (veiled) invoke("browser_hide", { id });
  bar().value = `http://localhost:${port}`;
  place();
  void refresh();
  clearInterval(poll);
  poll = setInterval(refresh, 1000);
  return port;
}

/// Some sem fechar: outra coisa no centro, ou outro workspace. A página fica
/// onde estava para quando você voltar.
export function hide() {
  if (!shown) return;
  clearInterval(poll);
  invoke("browser_hide", { id: shown });
  shown = null;
}

export function close(id: string) {
  if (shown === id) {
    clearInterval(poll);
    shown = null;
  }
  invoke("browser_close", { id });
}

/// O que você escreveu. Endereço sem esquema é `http` — é o que se digita para
/// um servidor local, e exigir o prefixo seria pedantismo.
function go(say: (m: string, err?: boolean) => void) {
  const id = shown;
  if (!id) return;
  const typed = bar().value.trim();
  if (!typed) return void refresh();
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`;
  bar().blur();
  invoke("browser_navigate", { id, url }).catch((e) => {
    say(fromBack(e), true);
    void refresh();
  });
}

/// Escreve na barra onde a página está de verdade.
async function refresh() {
  if (!shown || typing()) return;
  const url = await invoke<string | null>("browser_url", { id: shown });
  if (url && !typing()) bar().value = url;
}

function place() {
  if (!shown) return;
  const r = $("webbody").getBoundingClientRect();
  if (!r.width || !r.height) return;
  invoke("browser_bounds", { id: shown, x: r.left, y: r.top, w: r.width, h: r.height });
}
