import { invoke } from "@tauri-apps/api/core";
import { fromBack } from "./i18n";
import { highlight } from "./highlight";
import { fileIcon, icon } from "./icons";
import { $ } from "./util";

/// Viewer de arquivo no centro, como o editor do Conductor: migalha com o
/// caminho, gutter com número de linha, código colorido. Só leitura — quem
/// edita é o agente; você lê, seleciona e copia.

let shown: { id: string; path: string; text: string } | null = null;
let request = 0;

export function init(onError: (m: string) => void) {
  $("vcopy").innerHTML = icon("copy");
  $("vcopy").addEventListener("click", () => {
    if (!shown) return;
    navigator.clipboard.writeText(shown.path).catch((e) => onError(fromBack(e)));
  });
}

/// Desenha o arquivo. Chamado de novo a cada evento do quadro enquanto o
/// viewer está aberto, então o texto acompanha o agente editando; a rolagem
/// só é mexida quando o conteúdo mudou de verdade.
export async function show(id: string, path: string) {
  const currentRequest = ++request;
  const same = shown?.id === id && shown.path === path;
  let text: string;
  let error = "";
  try {
    text = await invoke<string>("read_file", { id, rel: path });
  } catch (e) {
    text = "";
    error = fromBack(e);
  }
  if (currentRequest !== request) return;
  if (same && shown!.text === text && !error) return;
  shown = { id, path, text };

  const cut = path.lastIndexOf("/");
  const crumb = $("vcrumb");
  crumb.innerHTML = `${fileIcon(path.slice(cut + 1), 14)}<span class="dir"></span><span class="nm"></span>`;
  crumb.children[1].textContent = cut === -1 ? "" : path.slice(0, cut + 1);
  crumb.children[2].textContent = path.slice(cut + 1);

  const pre = $("vpre");
  const gutter = $("vgutter");
  if (error) {
    gutter.textContent = "";
    pre.innerHTML = `<span class="h-c"></span>`;
    pre.children[0].textContent = error;
    return;
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  gutter.textContent = lines.map((_, i) => i + 1).join("\n");
  pre.innerHTML = highlight(text, path);
  if (!same) $("vcode").scrollTo(0, 0);
}
