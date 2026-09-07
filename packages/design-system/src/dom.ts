/// Cria um elemento cujo conteúdo é sempre texto. Dados do agente, do relay ou
/// de uma integração nunca devem ganhar semântica HTML só por passar aqui.
export function h(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
