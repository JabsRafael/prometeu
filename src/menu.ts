import { icon } from "./icons";

/// Menu de contexto: a lista que abre no botão direito da linha. É o lugar onde
/// tudo que se faz com um workspace mora — renomear, mudar de etapa, arquivar —
/// em vez de cada ação virar um botãozinho no card.
export type Item =
  | "sep"
  | {
      label: string;
      /// Glifo já desenhado, e não um nome de ícone: assim o mesmo menu aceita
      /// o ícone de etapa, que é calculado, e os ícones de nome fixo.
      glyph?: string;
      /// Atalho escrito na ponta. Só aparece quem existe de verdade.
      hint?: string;
      checked?: boolean;
      danger?: boolean;
      sub?: Item[];
      run?: () => void;
    };

let root: HTMLElement | null = null;

export const isOpen = () => root !== null;

export function close() {
  root?.remove();
  root = null;
  document.removeEventListener("mousedown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", close);
}

function onDown(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".menu")) close();
}

/// Esc é do menu enquanto ele está aberto: o do app fecharia o lançador atrás.
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  close();
}

/// Abre em cima do ponto do clique. Se não couber, encosta na borda em vez de
/// sair da tela.
export function openAt(at: { x: number; y: number }, items: Item[]) {
  close();
  root = panel(items);
  document.body.append(root);
  place(root, at.x, at.y);
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
}

function place(el: HTMLElement, x: number, y: number) {
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
}

function panel(items: Item[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "menu";
  // Um submenu por painel: abrir outra linha fecha o que estava aberto.
  let sub: HTMLElement | null = null;
  const drop = () => {
    sub?.remove();
    sub = null;
  };

  for (const item of items) {
    if (item === "sep") {
      box.append(document.createElement("hr"));
      continue;
    }
    const row = document.createElement("button");
    row.className = "mrow" + (item.danger ? " danger" : "");
    row.innerHTML =
      `<span class="mg">${item.glyph ?? ""}</span><span class="ml"></span>` +
      `<span class="mh"></span>${item.sub ? icon("chevron-right", 14) : ""}` +
      `<span class="mc">${item.checked ? icon("check", 14) : ""}</span>`;
    row.children[1].textContent = item.label;
    row.children[2].textContent = item.hint ?? "";
    box.append(row);

    row.addEventListener("mouseenter", () => {
      drop();
      if (!item.sub) return;
      // Dentro do painel, não no body: `position: fixed` posiciona igual, e
      // fechar o menu leva os submenus embora sem ninguém varrer atrás.
      sub = panel(item.sub);
      box.append(sub);
      const at = row.getBoundingClientRect();
      // Encostado na linha, e não no ponto do clique: o submenu sai de onde a
      // seta aponta.
      place(sub, at.right - 4, at.top - 6);
    });
    if (item.run) {
      row.addEventListener("click", () => {
        close();
        item.run!();
      });
    }
  }
  return box;
}
