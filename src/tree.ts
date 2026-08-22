import { invoke } from "@tauri-apps/api/core";
import { fileIcon, icon } from "./icons";
import { $, debounce } from "./util";

/// Árvore de arquivos do worktree, no painel da direita. Preguiçosa: uma pasta
/// por chamada, aberta sob demanda. Repo grande não paga por galho que ninguém
/// abriu.

type Entry = { name: string; path: string; dir: boolean };

/// Quais pastas estão abertas. Sobrevive ao redesenho — é o que faz a árvore
/// não se fechar sozinha a cada ferramenta que o agente usa.
const openDirs = new Set<string>();

let openFile: (path: string) => void = () => {};
let workspace: () => string | null = () => null;

export function init(ctx: { openFile: (path: string) => void; workspace: () => string | null }) {
  openFile = ctx.openFile;
  workspace = ctx.workspace;
  $("collapse").addEventListener("click", () => {
    openDirs.clear();
    redraw();
  });
}

/// Redesenha agora. É o que responde a um clique — atraso aqui é lag.
export function redraw() {
  const id = workspace();
  if (id) void draw(id);
}

/// Trocar de workspace zera o que estava aberto: as pastas de um repo não
/// dizem nada sobre as do outro.
export function reset() {
  openDirs.clear();
}

/// Redesenha daqui a pouco. É o que responde ao evento do quadro, que chega a
/// cada ferramenta que o agente usa: cada redesenho é uma chamada de `list_dir`
/// por pasta aberta, então sem juntar as rajadas uma árvore com dez pastas
/// abertas viram dez IPCs por tool call, todos para desenhar a mesma coisa.
export const redrawSoon = debounce(200, redraw);

async function draw(id: string) {
  const tree = $("tree");
  tree.replaceChildren();
  await fill(id, "", tree, 0);
}

async function fill(id: string, rel: string, into: HTMLElement, depth: number) {
  const entries = await invoke<Entry[]>("list_dir", { id, rel });
  for (const entry of entries) {
    const row = document.createElement("button");
    row.className = "treerow";
    row.style.paddingLeft = `${14 + depth * 20}px`;
    row.innerHTML = `<span class="tw"></span><span class="tn"></span><span class="tc"></span>`;
    // Pasta aberta troca o ícone e o chevron da ponta, que só aparece no hover.
    const glyph = (open: boolean) => {
      row.children[0].innerHTML = entry.dir ? icon(open ? "folder-open" : "folder") : fileIcon(entry.name);
      row.children[2].innerHTML = entry.dir ? icon(open ? "chevron-down" : "chevron-right", 14) : "";
    };
    glyph(false);
    row.children[1].textContent = entry.name;
    into.append(row);

    if (!entry.dir) {
      row.addEventListener("click", () => openFile(entry.path));
      continue;
    }

    const kids = document.createElement("div");
    kids.hidden = true;
    into.append(kids);

    row.addEventListener("click", async () => {
      const isOpen = openDirs.has(entry.path);
      if (isOpen) {
        openDirs.delete(entry.path);
      } else {
        openDirs.add(entry.path);
        if (!kids.childElementCount) await fill(id, entry.path, kids, depth + 1);
      }
      kids.hidden = isOpen;
      glyph(!isOpen);
    });

    if (openDirs.has(entry.path)) {
      glyph(true);
      kids.hidden = false;
      await fill(id, entry.path, kids, depth + 1);
    }
  }
}
