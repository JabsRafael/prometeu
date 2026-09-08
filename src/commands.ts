import * as menu from "./menu";
import type { Command } from "./timeline";

export type Suggestion = Command & { badge?: string };

/// Render slash-command completion from commands discovered by the backend and retained by Timeline.

/// Match the slash prefix up to the cursor, excluding arguments and paths such as /Users/x.
export function typing(text: string, cut: number): { query: string } | null {
  const m = /^\/([^\s/]*)$/.exec(text.slice(0, cut));
  return m ? { query: m[1] } : null;
}

/// Rank prefix matches before matching command segments; sort each group alphabetically for stable results.
export function matches<T extends { name: string }>(query: string, list: T[]): T[] {
  const q = query.toLowerCase();
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  const starts = sorted.filter((c) => c.name.toLowerCase().startsWith(q));
  const inside = sorted.filter((c) => !starts.includes(c) && c.name.toLowerCase().split(/[:-]/).some((w) => w.startsWith(q)));
  return [...starts, ...inside];
}

/// Use the first description sentence to keep command rows compact.
export function brief(description: string, max = 72): string {
  const first = description.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  const one = first.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/// Enter and Tab choose the first result unless the full command is already entered.
let picking: { first: () => void; exact: boolean } | null = null;

/// Refresh completion while the slash prefix is present; return ownership so paths.ts can handle other input.
export function typed(area: HTMLTextAreaElement, all: Suggestion[], onChange: () => void, onSelect?: (name: string) => boolean): boolean {
  const at = typing(area.value, area.selectionStart);
  const list = at ? matches(at.query, all) : [];
  if (!at || !list.length) {
    dismiss();
    return false;
  }
  const put = (name: string) => {
    picking = null;
    if (onSelect?.(name)) return;
    // Replace the typed command prefix and append a space for arguments.
    const cut = area.selectionStart;
    area.value = `/${name} ${area.value.slice(cut)}`;
    onChange();
    area.focus();
    area.selectionStart = area.selectionEnd = name.length + 2;
  };
  const box = area.getBoundingClientRect();
  menu.openAt(
    { x: box.left, y: box.top - 4, above: true },
    list.map((c) => ({ label: `/${c.name}`, badge: c.badge, hint: brief(c.description), run: () => put(c.name) })),
    "cmds",
  );
  picking = { first: () => put(list[0].name), exact: list.some((c) => c.name.toLowerCase() === at.query.toLowerCase()) };
  return true;
}

/// Enter or Tab completes the first match. An already complete command submits on Enter; Tab still adds its trailing space.
export function accept(tab: boolean): boolean {
  if (!picking || !menu.isOpen()) return false;
  menu.close();
  if (!tab && picking.exact) {
    picking = null;
    return false;
  }
  picking.first();
  return true;
}

/// Close only this module's completion menu.
export function dismiss() {
  if (picking && menu.isOpen()) menu.close();
  picking = null;
}
