/// Create text-only elements. Agent, relay and integration data must never acquire HTML semantics here.
export function h(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
