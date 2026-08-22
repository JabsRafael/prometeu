/// Os três helpers que todo módulo de tela usava por conta própria.

export const $ = (id: string) => document.getElementById(id)!;

export function h(tag: string, className: string, html = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.innerHTML = html;
  return node;
}

/// Junta rajadas numa chamada só, com o último argumento que chegou.
///
/// O quadro é redesenhado a cada ferramenta que o agente usa, e havia trabalho
/// caro pendurado nesse redesenho — um `git diff` do worktree inteiro, uma
/// listagem por pasta aberta na árvore. Com três sessões rodando isso vira
/// dezenas de chamadas por segundo para desenhar a mesma tela.
export function debounce<A extends unknown[]>(ms: number, fn: (...args: A) => void) {
  let timer = 0;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
