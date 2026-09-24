import { t } from "./i18n";
import { invoke } from "./ipc";
import { fileIcon, icon } from "./icons";
import * as menu from "./menu";
import type { PathEntry } from "./paths";
import { gitMarks, latestOnly, type GitMarks, type GoneEntry } from "./tree-git";
import { treeMenu } from "./tree-menu";
import { $, debounce } from "./util";

/// Load worktree folders on demand in the side panel so large repositories do not require a full tree scan.

/// Preserve expanded folders across board redraws.
const openDirs = new Set<string>();

/// The file the viewer is showing, whatever opened it: this tree, Changes, a tab or the dock. The
/// workspace owns that choice and reports it through `select`; the tree only draws it.
let selected: string | null = null;

/// The row a context menu is acting on, file or folder, while that menu is open. A folder has no
/// open file to mark, and a file may differ from the one on screen; without this the menu would sit
/// over an unmarked row, leaving which entry it acts on to guesswork.
let target: string | null = null;

/// What the tree cannot know by itself: the absolute root, and whether a conversation takes files.
export type Host = {
  root: string | null;
  attach: ((absolute: string) => void) | null;
  /// Explain a conversation that exists but refuses attachments; absent in the project-only view.
  attachHint?: string;
  copy: (text: string) => void;
  reveal: (path: string) => void;
};

let openFile: (path: string) => void = () => {};
let workspace: () => string | null = () => null;
let host: () => Host = () => ({ root: null, attach: null, copy: () => {}, reveal: () => {} });
let marks: GitMarks = gitMarks([]);
/// Agents and terminals change files without board events, so visible marks refresh on a timer.
const MARKS_EVERY = 5_000;

export function init(ctx: {
  openFile: (path: string) => void;
  workspace: () => string | null;
  host: () => Host;
}) {
  openFile = ctx.openFile;
  workspace = ctx.workspace;
  host = ctx.host;
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
  selected = null;
  target = null;
}

/// Debounce board-driven refreshes because each open folder requires list_dir; agent bursts would otherwise repeat identical IPC work.
export const redrawSoon = debounce(200, redraw);

/// Mark the file the viewer shows, or none. Paths are relative to the tree's root, as list_dir
/// returns them. The row is only marked, never scrolled into view: the person may be browsing
/// elsewhere in the tree.
export function select(path: string | null) {
  selected = path;
  markRows("selected", path);
}

function markRows(cls: "selected" | "targeted", path: string | null) {
  for (const row of $("tree").querySelectorAll(`.treerow.${cls}`)) row.classList.remove(cls);
  if (path) $("tree").querySelector(`.treerow[data-path="${CSS.escape(path)}"]`)?.classList.add(cls);
}

function aim(path: string | null) {
  target = path;
  markRows("targeted", path);
}

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

/// A draw and the timer's repaint can scan at once; only the latest scan started replaces the marks.
const scan = latestOnly();

async function loadMarks(id: string) {
  await scan(invoke("tree_git_status", { id }).catch(() => []), (files) => {
    if (workspace() === id) marks = gitMarks(files);
  });
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
    row.dataset.path = entry.path;
    if (entry.path === selected) row.classList.add("selected");
    if (entry.path === target) row.classList.add("targeted");
    row.style.paddingLeft = `${14 + depth * 20}px`;
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

    const kids = document.createElement("div");
    let flip = async () => {};
    if (entry.dir) {
      kids.hidden = true;
      into.append(kids);
      flip = async () => {
        const isOpen = openDirs.has(entry.path);
        if (isOpen) {
          openDirs.delete(entry.path);
        } else {
          openDirs.add(entry.path);
          if (!kids.childElementCount) await fill(id, entry.path, kids, depth + 1, gone ? [] : undefined);
        }
        kids.hidden = isOpen;
        glyph(!isOpen);
      };
    }

    // Replace the engine's page menu, which offers web actions over the file's name. Scope it to the
    // row so the viewer and the composer keep the native editing menu.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // A deleted entry has nothing on disk to open, attach or reveal.
      if (gone) return;
      const at = host();
      menu.openAt(
        { x: e.clientX, y: e.clientY },
        treeMenu(entry, {
          root: at.root,
          expanded: openDirs.has(entry.path),
          attachHint: at.attachHint,
          hooks: {
            open: openFile,
            toggle: () => void flip(),
            attach: at.attach,
            copy: at.copy,
            reveal: at.reveal,
          },
        }),
        undefined,
        () => aim(null),
      );
      // After openAt: opening closes any previous menu, whose callback clears the old mark.
      aim(entry.path);
    });

    // Opening a file marks it through the workspace's `select`, like every other route to the viewer.
    row.addEventListener("click", () => {
      if (entry.dir) void flip();
      else if (!gone) openFile(entry.path);
    });

    if (entry.dir && openDirs.has(entry.path)) {
      glyph(true);
      kids.hidden = false;
      await fill(id, entry.path, kids, depth + 1, gone ? [] : undefined);
    }
  }
}
