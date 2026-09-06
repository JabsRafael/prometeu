import { icon } from "./icons";
import * as menu from "./menu";
import { h } from "./util";

// Primitivas de apresentação. Rótulos chegam traduzidos pela tela chamadora.
export function button(label: string, run: () => void, variant: "outline" | "pri" | "ghost" = "outline") {
  const control = document.createElement("button");
  control.className = `ui-button ${variant} md`;
  control.type = "button";
  control.textContent = label;
  control.onclick = () => { control.focus(); run(); };
  return control;
}

export function input(value = "", multiline = false) {
  const control = document.createElement(multiline ? "textarea" : "input");
  control.className = "ui-input";
  control.value = value;
  if (control instanceof HTMLTextAreaElement) control.rows = 5;
  return control;
}

export function field(label: string, control: HTMLElement, hint = "") {
  const root = h("label", "ui-field");
  control.setAttribute("aria-label", label);
  root.append(h("span", "ui-label", label), control);
  if (hint) {
    const help = h("span", "ui-hint", hint);
    help.id = `ui-hint-${crypto.randomUUID()}`;
    control.setAttribute("aria-describedby", help.id);
    root.append(help);
  }
  return root;
}

export function checkbox(label: string, checked: boolean) {
  const control = document.createElement("input");
  control.type = "checkbox";
  control.checked = checked;
  const root = h("label", "ui-check");
  root.append(control, h("span", "", label));
  return { control, label: root };
}

export type Group = { head?: string; items: [string, string][] };

// Extraído do launcher: o mesmo menu escuro funciona no navegador e WKWebView.
// O catálogo pode mudar entre cliques; por isso as opções são lidas ao abrir.
export function dropdown(btn: HTMLButtonElement, groups: () => Group[], get: () => string, set: (id: string) => void) {
  const label = btn.querySelector("span")!;
  const draw = () => {
    label.textContent = groups().flatMap(g => g.items).find(([id]) => id === get())?.[1] ?? get();
  };
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", () => {
    const at = btn.getBoundingClientRect();
    const blocks = groups();
    const items: menu.Item[] = [];
    blocks.forEach((block, n) => {
      if (n) items.push("sep");
      if (block.head && blocks.length > 1) items.push({ label: block.head, disabled: true });
      for (const [id, name] of block.items) items.push({
        label: name, checked: id === get(), run: () => { set(id); draw(); btn.focus(); },
      });
    });
    menu.openAt({ x: at.left, y: at.bottom + 4 }, items, "ui-select-menu", () => btn.setAttribute("aria-expanded", "false"));
    btn.setAttribute("aria-expanded", "true");
  });
  btn.addEventListener("keydown", event => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !menu.isOpen()) {
      event.preventDefault(); btn.click();
    } else if (event.key === "Tab" && menu.isOpen()) menu.close();
  });
  draw();
  return draw;
}

export function select(value: string, options: [string, string][]) {
  const control = button("", () => {});
  control.className = "ui-select pick";
  control.append(h("span", ""));
  control.insertAdjacentHTML("beforeend", icon("chevron-down", 14));
  const choice = {
    control,
    get value() { return value; },
    set value(next: string) { value = next; draw(); },
    onchange: () => {},
    setOptions(next: [string, string][], selected = value) { options = next; value = selected; draw(); },
  };
  const draw = dropdown(control, () => [{ items: options }], () => value, id => { value = id; choice.onchange(); });
  return choice;
}

export function disclosure(title: string, ...content: HTMLElement[]) {
  const root = document.createElement("details");
  root.className = "ui-disclosure";
  root.append(h("summary", "", title), ...content);
  return root;
}

export function formDialog(options: {
  title: string; save: string; cancel: string;
  submit: () => Promise<void>; error: (error: unknown) => string;
  closed?: () => void;
}) {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = document.createElement("dialog");
  dialog.className = "sheet ui-dialog";
  dialog.setAttribute("aria-label", options.title);
  const form = document.createElement("form");
  const header = h("div", "sheettop");
  header.append(h("b", "", options.title));
  const body = h("div", "ui-form-body");
  const footer = h("div", "sheetbar ui-form-footer");
  const error = h("span", "ui-hint ui-error");
  error.setAttribute("role", "alert");
  const close = () => {
    if (!dialog.isConnected) return;
    menu.close(); dialog.close(); dialog.remove();
    options.closed?.();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const save = button(options.save, () => form.requestSubmit(), "pri");
  const cancel = button(options.cancel, close);
  footer.append(cancel, error, save);
  form.append(header, body, footer);
  dialog.append(form);
  let busy = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; save.disabled = cancel.disabled = true;
    form.setAttribute("aria-busy", "true"); error.textContent = "";
    try { await options.submit(); close(); }
    catch (cause) { error.textContent = options.error(cause); }
    finally { busy = false; save.disabled = cancel.disabled = false; form.removeAttribute("aria-busy"); }
  };
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!busy) close(); });
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    menu.close();
    const controls = Array.from(form.querySelectorAll<HTMLElement>("button, input, textarea, select, summary, [tabindex]"))
      .filter(node => !node.matches(":disabled") && node.tabIndex >= 0 && node.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  return {
    body, close,
    open() { document.body.append(dialog); dialog.showModal(); body.querySelector<HTMLElement>("input, textarea, button")?.focus(); },
  };
}
