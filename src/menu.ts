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
      /// Continua na lista, mas apagado e sem clique: item que some quando não
      /// pode ser usado deixa quem procurava por ele achando que enlouqueceu.
      disabled?: boolean;
      sub?: Item[];
      run?: () => void;
    };

let root: HTMLElement | null = null;
/// A linha marcada — pelo mouse ou pelas setas. É a que Enter aciona.
let sel: HTMLElement | null = null;

export const isOpen = () => root !== null;

/// Quem quer saber que o painel fechou. O app não se redesenha com um menu
/// aberto — refazer a lista embaixo tiraria o painel do lugar no meio do
/// clique —, e o que ficou para trás precisa acontecer quando ele sai.
const closers = new Set<() => void>();
export const onClose = (fn: () => void) => closers.add(fn);

export function close() {
  const was = root !== null;
  root?.remove();
  root = null;
  sel = null;
  document.removeEventListener("mousedown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", close);
  // Reabrir o mesmo menu — o seletor que se remarca a cada clique — passa por
  // aqui e não é fechar: o aviso sai no tique seguinte, e só se ninguém tiver
  // aberto outro painel nesse meio-tempo.
  if (was) setTimeout(() => root === null && closers.forEach((fn) => fn()), 0);
}

function onDown(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".menu")) close();
}

/// Esc é do menu enquanto ele está aberto: o do app fecharia o lançador atrás.
/// As setas andam pela lista e Enter aciona a linha marcada — é o que deixa
/// escolher sem tirar a mão do teclado quando o menu abriu enquanto se
/// escrevia (ver `commands.ts`, `notes.ts`). Sem linha marcada, Enter segue
/// para quem estava com o foco.
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    close();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    move(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" && sel) {
    e.preventDefault();
    e.stopPropagation();
    sel.click();
  }
}

function select(row: HTMLElement | null) {
  sel?.classList.remove("sel");
  sel = row;
  sel?.classList.add("sel");
}

/// Uma linha para baixo ou para cima, dando a volta nas pontas. Só as linhas
/// do painel de cima: o submenu é do mouse.
function move(delta: number) {
  if (!root) return;
  const rows = [...root.children].filter((el): el is HTMLElement => el.matches(".mrow:not(.off)"));
  if (!rows.length) return;
  const at = sel ? rows.indexOf(sel) : -1;
  const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length;
  select(rows[next]);
  rows[next].scrollIntoView({ block: "nearest" });
}

export type Where = {
  x: number;
  y: number;
  /// O painel cresce para cima a partir do ponto, em vez de para baixo: é o
  /// que abre em cima de uma caixa de texto sem tampá-la.
  above?: boolean;
};

/// Abre em cima do ponto do clique. Se não couber, encosta na borda em vez de
/// sair da tela. `cls` é uma classe a mais no painel, para a lista que precisa
/// de outro tamanho.
export function openAt(at: Where, items: Item[], cls?: string) {
  close();
  root = panel(items);
  if (cls) root.classList.add(cls);
  document.body.append(root);
  place(root, at.x, at.y, at.above);
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
}

function place(el: HTMLElement, x: number, y: number, above = false) {
  const { width, height } = el.getBoundingClientRect();
  const top = above ? y - height : y;
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
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
    row.className = "mrow" + (item.danger ? " danger" : "") + (item.disabled ? " off" : "");
    row.disabled = item.disabled ?? false;
    row.innerHTML =
      `<span class="mg">${item.glyph ?? ""}</span><span class="ml"></span>` +
      `<span class="mh"></span>${item.sub ? icon("chevron-right", 14) : ""}` +
      `<span class="mc">${item.checked ? icon("check", 14) : ""}</span>`;
    row.children[1].textContent = item.label;
    row.children[2].textContent = item.hint ?? "";
    box.append(row);

    row.addEventListener("mouseenter", () => {
      if (!item.disabled) select(row);
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
