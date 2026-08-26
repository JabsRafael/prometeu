/// A aba de navegador. A página é uma webview do sistema — a mesma que desenha
/// o app — que o back põe por cima do centro (ver `browser.rs`). O DOM só tem
/// o lugar dela, `#webbody`, e uma view nativa não sabe o que o CSS fez: é a
/// medida desse lugar que vai para o back toda vez que ele muda.
import { invoke } from "@tauri-apps/api/core";
import { $ } from "./util";

/// Workspace cuja webview está na tela agora.
let shown: string | null = null;

export function init(external: (id: string) => void) {
  $("wreload").addEventListener("click", () => shown && invoke("browser_reload", { id: shown }));
  $("wext").addEventListener("click", () => shown && external(shown));
  // Rail recolhendo, coluna da direita sumindo, janela mudando de tamanho:
  // tudo isso muda o buraco, e o observer pega os três.
  new ResizeObserver(place).observe($("webbody"));
}

/// Mostra a webview do workspace no centro, criando na primeira vez. Devolve a
/// porta, que é o que a aba escreve.
export async function show(id: string): Promise<number> {
  const port = await invoke<number>("browser_open", { id });
  shown = id;
  $("wcrumb").textContent = `http://localhost:${port}`;
  place();
  return port;
}

/// Some sem fechar: outra coisa no centro, ou outro workspace. A página fica
/// onde estava para quando você voltar.
export function hide() {
  if (!shown) return;
  invoke("browser_hide", { id: shown });
  shown = null;
}

export function close(id: string) {
  if (shown === id) shown = null;
  invoke("browser_close", { id });
}

function place() {
  if (!shown) return;
  const r = $("webbody").getBoundingClientRect();
  if (!r.width || !r.height) return;
  invoke("browser_bounds", { id: shown, x: r.left, y: r.top, w: r.width, h: r.height });
}
