/// Helpers comuns dos módulos de tela.

export const $ = (id: string) => document.getElementById(id)!;

import { h } from "../packages/design-system/src/dom";
export { h };

/// Cria a estrutura fixa de um componente. O nome deixa cada uso de
/// `innerHTML` visível na revisão; só templates produzidos pelo próprio app
/// (incluindo os SVGs de `icons.ts`) pertencem aqui.
export function template(tag: string, className: string, html: string): HTMLElement {
  const node = h(tag, className);
  node.innerHTML = html;
  return node;
}

/// Junta rajadas numa chamada só, com o último argumento que chegou.
///
/// A interface é redesenhada a cada ferramenta que o agente usa, e havia trabalho
/// caro pendurado nesse redesenho — um `git diff` do worktree inteiro, uma
/// listagem por pasta aberta na árvore. Com três sessões rodando isso vira
/// dezenas de chamadas por segundo para desenhar a mesma tela.
/// O vazio de uma lista de tela cheia: título, uma frase, e às vezes um botão.
export function empty(title: string, text: string, action?: [string, () => void]): HTMLElement {
  const box = template("div", "iempty", `<h3></h3><p></p>`);
  box.children[0].textContent = title;
  box.children[1].textContent = text;
  if (action) {
    const b = h("button", "outline md", action[0]);
    b.addEventListener("click", action[1]);
    box.append(b);
  }
  return box;
}

export function debounce<A extends unknown[]>(ms: number, fn: (...args: A) => void) {
  let timer = 0;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
