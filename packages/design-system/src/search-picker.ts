import * as menu from "./menu.js";
import { h } from "./dom.js";

export type SearchPickerItem = {
  key: string;
  label: string;
  detail?: string;
  searchText?: string;
  group?: string;
  checked?: boolean;
  disabled?: boolean;
  secondary?: { label: string; pressed: boolean; run: () => void };
};
export type SearchPickerOptions = {
  label: string;
  searchPlaceholder: string;
  empty: string;
  items: SearchPickerItem[];
  select: (key: string) => void;
  status?: string;
  refresh?: { label: string; run: () => void };
  additional?: { label: string; checked: boolean; change: (checked: boolean) => void };
  closed?: () => void;
};

const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();

/** A searchable collection with separate selection and optional secondary actions. */
export function searchablePicker(anchor: HTMLElement, options: SearchPickerOptions) {
  let items = options.items;
  let alive = true;
  let reposition = () => {};
  const root = h("div", "menu ui-search-picker");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", options.label);
  root.id = `ui-picker-${crypto.randomUUID()}`;
  const search = document.createElement("input");
  search.type = "search"; search.className = "ui-input ui-search-picker-search";
  search.placeholder = options.searchPlaceholder; search.setAttribute("aria-label", options.searchPlaceholder);
  const list = h("div", "ui-search-picker-list");
  const status = h("div", "ui-hint ui-search-picker-status", options.status ?? "");
  status.setAttribute("role", "status");
  const footer = h("div", "ui-search-picker-footer");
  root.append(search, list, status, footer);
  const close = () => { if (alive) menu.close(); };
  const draw = () => {
    if (!alive) return;
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
      ? { key: (document.activeElement as HTMLElement).dataset.key, secondary: (document.activeElement as HTMLElement).dataset.secondary } : undefined;
    const scroll = list.scrollTop;
    const terms = normalize(search.value.trim()).split(/\s+/).filter(Boolean);
    const visible = items.filter(item => {
      const text = normalize(`${item.label} ${item.detail ?? ""} ${item.searchText ?? ""}`);
      return terms.every(term => text.includes(term));
    });
    list.replaceChildren();
    let group: string | undefined;
    for (const item of visible) {
      if (item.group && item.group !== group) list.append(h("div", "ui-search-picker-group", item.group));
      group = item.group;
      const row = h("div", "ui-search-picker-row");
      const choice = document.createElement("button");
      choice.type = "button"; choice.className = "ui-search-picker-choice"; choice.dataset.key = item.key;
      choice.disabled = item.disabled ?? false;
      choice.setAttribute("aria-pressed", String(item.checked ?? false));
      const text = h("span", "ui-search-picker-text");
      text.append(h("span", "", item.label));
      if (item.detail) text.append(h("span", "ui-hint", item.detail));
      choice.append(text);
      const check = h("span", "ui-search-picker-check", item.checked ? "✓" : "");
      check.setAttribute("aria-hidden", "true"); choice.append(check);
      choice.onclick = () => { close(); options.select(item.key); };
      row.append(choice);
      if (item.secondary) {
        const action = document.createElement("button");
        action.type = "button"; action.className = "ui-button ghost ui-search-picker-secondary";
        action.dataset.key = item.key; action.dataset.secondary = "true";
        action.setAttribute("aria-label", item.secondary.label);
        action.setAttribute("aria-pressed", String(item.secondary.pressed));
        action.textContent = item.secondary.pressed ? "★" : "☆";
        action.onclick = () => { action.focus(); item.secondary!.run(); };
        row.append(action);
      }
      list.append(row);
    }
    if (!visible.length) list.append(h("p", "ui-hint", options.empty));
    list.scrollTop = scroll;
    if (focused) {
      const replacement = [...list.querySelectorAll<HTMLButtonElement>("button")].find(node =>
        node.dataset.key === focused.key && node.dataset.secondary === focused.secondary && !node.disabled);
      (replacement ?? search).focus({ preventScroll: true });
    }
  };
  if (options.refresh) {
    const refresh = document.createElement("button");
    refresh.type = "button"; refresh.className = "ui-button ghost"; refresh.textContent = options.refresh.label;
    refresh.onclick = () => { refresh.focus(); options.refresh!.run(); }; footer.append(refresh);
  }
  if (options.additional) {
    const label = h("label", "ui-check");
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = options.additional.checked;
    check.onchange = () => options.additional!.change(check.checked);
    label.append(check, h("span", "", options.additional.label)); footer.append(label);
  }
  root.addEventListener("mousedown", event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (!target || target.disabled) return;
    // WebKit otherwise focuses the enclosing dialog before click, dismissing this panel as external focus.
    event.preventDefault(); target.focus({ preventScroll: true });
  });
  search.oninput = draw;
  const keyboard = (event: KeyboardEvent) => {
    const active = document.activeElement;
    if (event.key === "Tab") {
      // WebKit's platform preference can skip buttons; explicitly include both row actions.
      // One row participates at a time so long catalogs do not trap the footer behind 200 Tabs.
      event.preventDefault(); event.stopPropagation();
      const row = active instanceof HTMLElement ? active.closest(".ui-search-picker-row") : null;
      const first = list.querySelector(".ui-search-picker-choice:not(:disabled)")?.parentElement;
      const rowControls = [...(row ?? first)?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []];
      const controls: HTMLElement[] = [search, ...rowControls,
        ...footer.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
      const next = controls.indexOf(active as HTMLElement) + (event.shiftKey ? -1 : 1);
      if (next < 0 || next >= controls.length) close(); else controls[next].focus();
      return;
    }
    const choices = [...list.querySelectorAll<HTMLButtonElement>(".ui-search-picker-choice:not(:disabled)")];
    const row = active instanceof HTMLElement ? active.closest(".ui-search-picker-row") : null;
    const index = choices.findIndex(choice => row?.contains(choice));
    if (event.key === "ArrowDown" || event.key === "ArrowUp" ||
        (active !== search && (event.key === "Home" || event.key === "End"))) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
        : index < 0 ? (event.key === "ArrowDown" ? 0 : choices.length - 1)
        : (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      choices[next]?.focus({ preventScroll: true }); choices[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && active === search) {
      event.preventDefault(); event.stopPropagation(); choices[0]?.click();
    }
  };
  const onFocus = (event: FocusEvent) => { if (!root.contains(event.target as Node)) close(); };
  draw();
  reposition = menu.openPanel(anchor, root, keyboard, () => {
    alive = false;
    anchor.setAttribute("aria-expanded", "false"); anchor.removeAttribute("aria-controls");
    document.removeEventListener("focusin", onFocus);
    window.removeEventListener("resize", reposition);
    options.closed?.();
  });
  anchor.setAttribute("aria-expanded", "true"); anchor.setAttribute("aria-controls", root.id);
  window.addEventListener("resize", reposition);
  search.focus(); document.addEventListener("focusin", onFocus);
  return { close, update(next: SearchPickerItem[], message = "") { items = next; status.textContent = message; draw(); reposition(); } };
}
