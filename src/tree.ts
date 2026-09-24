import { t } from "./i18n";
import { invoke } from "./ipc";
import { fileIcon, icon } from "./icons";
import type { PathEntry } from "./paths";
import { gitMarks, type GitMarks, type GoneEntry } from "./tree-git";
import { $, debounce } from "./util";

/// Load worktree folders on demand in the side panel so large repositories do not require a full tree scan.

/// Preserve expanded folders across board redraws.
const openDirs = new Set<string>();

let openFile: (path: string) => void = () => {};
let workspace: () => string | null = () => null;
let marks: GitMarks = gitMarks([]);
/// Agents and terminals change files without board events, so visible marks refresh on a timer.
const MARKS_EVERY = 5_000;

export function init(ctx: { openFile: (path: string) => void; workspace: () => string | null }) {
  openFile = ctx.openFile;
  workspace = ctx.workspace;
  $("collapse").addEventListener("click", () => {
    openDirs.clear();
    redraw();
  });
  setInterval(() => {
    const id = workspace();
    if (id && !document.hidden && $("tree").offsetParent) void repaint(id);
  }, MARKS_EVERY);
}

/// User clicks redraw immediately to avoid visible lag.
export function redraw() {
  const id = workspace();
  if (id) void draw(id);
}

/// Reset expanded folders when switching workspaces.
export function reset() {
  openDirs.clear();
}

/// Debounce board-driven refreshes because each open folder requires list_dir; agent bursts would otherwise repeat identical IPC work.
export const redrawSoon = debounce(200, redraw);

let drawn = 0;

/// Marks load before the rows because deleted files add rows of their own. Rows are built off
/// screen and swapped in at once: only the latest draw for the workspace still on screen may
/// replace the tree.
async function draw(id: string) {
  const mine = ++drawn;
  const [entries] = await Promise.all([invoke("list_dir", { id, rel: "" }), loadMarks(id)]);
  const rows = document.createDocumentFragment();
  await fill(id, "", rows, 0, entries);
  if (mine !== drawn || workspace() !== id) return;
  $("tree").replaceChildren(rows);
}

/// A slow repository must not stack scans: a timer tick waits for the one still running.
let loading: Promise<void> | null = null;

async function loadMarks(id: string) {
  const files = await invoke("tree_git_status", { id }).catch(() => []);
  if (workspace() === id) marks = gitMarks(files);
}

/// Repaint rows in place, and rebuild them only when a file was deleted or restored.
async function repaint(id: string) {
  if (loading) return;
  const before = marks.goneKey;
  loading = loadMarks(id).finally(() => (loading = null));
  await loading;
  if (workspace() !== id) return;
  if (marks.goneKey !== before) await draw(id);
  else paintAll();
}

function paintAll() {
  for (const row of $("tree").querySelectorAll<HTMLElement>(".treerow")) paint(row);
}

/// Tint the row and show the mark beside the name; folders show a dot for changes inside them.
function paint(row: HTMLElement) {
  const dir = row.dataset.dir === "1";
  const gone = row.dataset.gone === "1";
  const mark = gone ? "D" : marks.mark(row.dataset.path!, dir);
  const badge = row.children[2] as HTMLElement;
  if (mark) row.dataset.git = mark;
  else delete row.dataset.git;
  badge.textContent = mark ? (dir && !gone ? "•" : mark) : "";
  badge.title = mark ? t(dir && !gone ? "tree.git.folder" : `tree.git.${mark}`) : "";
}

/// Merge deleted entries into the listing in list_dir's order: folders first, then by name.
/// A name that changed type (a deleted file where a folder now stands, or the reverse) keeps both rows.
function withGone(rel: string, listed: PathEntry[]): (PathEntry | GoneEntry)[] {
  const kind = (entry: PathEntry) => `${entry.dir ? "d" : "f"}${entry.name}`;
  const names = new Set(listed.map(kind));
  const gone = marks.gone(rel).filter(entry => !names.has(kind(entry)));
  if (!gone.length) return listed;
  const key = (entry: PathEntry) => `${entry.dir ? 0 : 1}${entry.name.toLowerCase()}`;
  return [...listed, ...gone].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

async function fill(id: string, rel: string, into: HTMLElement | DocumentFragment, depth: number, listed?: PathEntry[]) {
  const entries = withGone(rel, listed ?? await invoke("list_dir", { id, rel }));
  for (const entry of entries) {
    const gone = "gone" in entry;
    const row = document.createElement("button");
    row.className = "treerow";
    row.style.paddingLeft = `${14 + depth * 20}px`;
    row.dataset.path = entry.path;
    row.dataset.dir = entry.dir ? "1" : "0";
    if (gone) row.dataset.gone = "1";
    row.innerHTML = `<span class="tw"></span><span class="tn"></span><span class="tg"></span><span class="tc"></span>`;
    // Expanded folders change their icon and hover chevron.
    const glyph = (open: boolean) => {
      row.children[0].innerHTML = entry.dir ? icon(open ? "folder-open" : "folder") : fileIcon(entry.name);
      row.children[3].innerHTML = entry.dir ? icon(open ? "chevron-down" : "chevron-right", 14) : "";
    };
    glyph(false);
    row.children[1].textContent = entry.name;
    paint(row);
    into.append(row);

    if (!entry.dir) {
      // A deleted file has nothing on disk to open.
      if (!gone) row.addEventListener("click", () => openFile(entry.path));
      continue;
    }

    const kids = document.createElement("div");
    kids.hidden = true;
    into.append(kids);

    row.addEventListener("click", async () => {
      const isOpen = openDirs.has(entry.path);
      if (isOpen) {
        openDirs.delete(entry.path);
      } else {
        openDirs.add(entry.path);
        if (!kids.childElementCount) await fill(id, entry.path, kids, depth + 1, gone ? [] : undefined);
      }
      kids.hidden = isOpen;
      glyph(!isOpen);
    });

    if (openDirs.has(entry.path)) {
      glyph(true);
      kids.hidden = false;
      await fill(id, entry.path, kids, depth + 1, gone ? [] : undefined);
    }
  }
}
