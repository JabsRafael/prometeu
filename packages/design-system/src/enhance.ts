import { confirmDialog, menuButton, passwordToggle } from "./ui.js";
import * as menu from "./menu.js";

const mounted = new WeakMap<Element, () => void>();

/** Melhoria progressiva para o HTML emitido pelo adaptador Rails do pacote. */
export function enhance(root: ParentNode = document) {
  const disposers: (() => void)[] = [];
  const mount = (selector: string, setup: (node: HTMLElement) => () => void) => {
    const nodes = [...root.querySelectorAll<HTMLElement>(selector)];
    if (root instanceof HTMLElement && root.matches(selector)) nodes.unshift(root);
    for (const node of nodes) {
      if (mounted.has(node)) continue;
      const cleanup = setup(node);
      const dispose = () => {
        if (mounted.get(node) !== dispose) return;
        cleanup(); mounted.delete(node);
      };
      mounted.set(node, dispose); disposers.push(dispose);
    }
  };

  mount("[data-ui-password]", node => {
    const input = node.querySelector<HTMLInputElement>("input")!;
    const toggle = passwordToggle(input, { show: node.dataset.uiShow!, hide: node.dataset.uiHide! });
    node.append(toggle);
    return () => { toggle.remove(); input.type = "password"; };
  });

  mount("details[data-ui-menu]", node => {
    // Links, botões de formulário e separadores viram itens; o clique nativo
    // preserva navegação, método HTTP e CSRF do HTML de origem.
    const summary = node.querySelector("summary")!;
    const control = menuButton(summary.textContent!, () =>
      Array.from(node.querySelectorAll<HTMLElement>("a[href], button, hr")).map(item =>
        item instanceof HTMLHRElement ? "sep" as const : {
          label: item.textContent!.trim(), checked: item.hasAttribute("aria-current"),
          danger: item.classList.contains("danger"), run: () => item.click(),
        }));
    // O gatilho repete o conteúdo do summary: avatar e nome, não só o texto.
    control.replaceChildren(...Array.from(summary.childNodes, child => child.cloneNode(true)));
    node.before(control); node.hidden = true;
    return () => {
      if (control.getAttribute("aria-expanded") === "true") menu.close();
      control.remove(); node.hidden = false;
    };
  });

  mount("form[data-ui-form]", node => {
    const form = node as HTMLFormElement;
    const events = new AbortController();
    let pending = false, approved = false, busy = false;
    const reset = () => {
      busy = false;
      form.removeAttribute("aria-busy");
      form.querySelectorAll("[data-ui-submitting]").forEach(button => {
        button.removeAttribute("aria-disabled"); button.removeAttribute("data-ui-submitting");
      });
    };
    form.addEventListener("submit", async event => {
      if (event.defaultPrevented) return;
      if (busy || pending) { event.preventDefault(); return; }
      if (form.dataset.uiConfirm && !approved) {
        event.preventDefault(); pending = true;
        // O WebKit não foca botões nativos ao clicar; este é o destino ao cancelar.
        event.submitter?.focus();
        try {
          if (await confirmDialog({ ...JSON.parse(form.dataset.uiConfirm), signal: events.signal }) && form.isConnected) {
            pending = false; approved = true;
            if (event.submitter) form.requestSubmit(event.submitter);
            else form.requestSubmit();
          }
        } finally { pending = false; approved = false; }
        return;
      }
      // Não desabilite o submitter: nome e valor fazem parte do POST nativo.
      busy = true; form.setAttribute("aria-busy", "true");
      form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(button => {
        button.setAttribute("aria-disabled", "true"); button.setAttribute("data-ui-submitting", "");
      });
      queueMicrotask(() => { if (event.defaultPrevented) reset(); });
    }, { signal: events.signal });
    form.addEventListener("invalid", event => {
      (event.target as HTMLElement).setAttribute("aria-invalid", "true");
    }, { capture: true, signal: events.signal });
    form.addEventListener("input", event => {
      const input = event.target;
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement) {
        if (input.validity.valid) input.removeAttribute("aria-invalid");
      }
    }, { signal: events.signal });
    window.addEventListener("pageshow", reset, { signal: events.signal });
    return () => { events.abort(); reset(); };
  });

  return () => disposers.forEach(dispose => dispose());
}
