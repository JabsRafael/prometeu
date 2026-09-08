import { icon, fileIcon } from "./icons";
import { invoke } from "./ipc";
import * as menu from "./menu";

/// Complete @file references in the composer using backend Git discovery. Both providers understand these paths; @mentions in the separate comments panel refer to people.

export type PathEntry = { name: string; path: string; dir: boolean };

/// Match a word-starting @ prefix up to the cursor; exclude email addresses and references already followed by a space.
export function typing(text: string, cut: number): { from: number; query: string } | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text.slice(0, cut));
  if (!m) return null;
  return { from: cut - m[1].length - 1, query: m[1] };
}

/// Enter and Tab select the first result from this module's menu.
let picking: { first: () => void } | null = null;
/// Track the latest lookup so a slower old response cannot replace newer completion results.
let asked = 0;

/// Refresh @ completion as input changes, ranking recently accessed conversation files first among equal matches.
export async function typed(area: HTMLTextAreaElement, id: string, recent: string[], onChange: () => void) {
  const at = typing(area.value, area.selectionStart);
  if (!at) return dismiss();

  const mine = ++asked;
  let list: PathEntry[] = [];
  try {
    list = await invoke("find_paths", { id, query: at.query, recent });
  } catch {
    list = [];
  }
  if (mine !== asked) return;
  // Discard results when the composer changed while the backend was responding.
  const now = typing(area.value, area.selectionStart);
  if (!now || now.query !== at.query) return;
  if (!list.length) return dismiss();

  const put = (entry: PathEntry) => {
    picking = null;
    // Replace the typed prefix. Directories retain a trailing slash and reopen completion; files append a space.
    const cut = area.selectionStart;
    const from = typing(area.value, cut)?.from ?? cut;
    const tail = entry.dir ? "/" : " ";
    area.value = `${area.value.slice(0, from)}@${entry.path}${tail}${area.value.slice(cut)}`;
    onChange();
    area.focus();
    area.selectionStart = area.selectionEnd = from + entry.path.length + 1 + tail.length;
    if (entry.dir) void typed(area, id, recent, onChange);
  };

  const box = area.getBoundingClientRect();
  menu.openAt(
    { x: box.left, y: box.top - 4, above: true },
    list.map((entry) => ({
      label: entry.path,
      glyph: entry.dir ? icon("folder", 14) : fileIcon(entry.name),
      run: () => put(entry),
    })),
    "cmds",
  );
  picking = { first: () => put(list[0]) };
}

/// Enter or Tab inserts the first path instead of submitting the prompt; return whether completion handled the key.
export function accept(): boolean {
  if (!picking || !menu.isOpen()) return false;
  menu.close();
  picking.first();
  return true;
}

/// Close only this module's completion menu.
export function dismiss() {
  if (picking && menu.isOpen()) menu.close();
  picking = null;
}

/// Prepend attachments as @path references, matching the launcher's first-message behavior. Use workspace-relative paths for internal files, absolute paths otherwise, and quote paths containing spaces.
export function mentions(picked: string[], root: string | null): string {
  return picked
    .filter(Boolean)
    .map((p) => `@${quoted(short(p, root))}`)
    .join(" ");
}

/// Use the path relative to the worktree when possible; retain absolute paths outside it.
export function short(path: string, root: string | null): string {
  const base = root?.replace(/\/+$/, "");
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

const quoted = (path: string) => (/\s/.test(path) ? `"${path}"` : path);
