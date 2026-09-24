import { fromBack, t } from "./i18n";
import { invoke } from "./ipc";
import { fileIcon, icon } from "./icons";
import * as menu from "./menu";
import type { PathEntry } from "./paths";
import { mac } from "./platform";
import * as rename from "./rename";
import { gitMarks, type GitMarks, type GoneEntry } from "./tree-git";
import { confirmDialog } from "./ui";
import { $, debounce } from "./util";

/// Load worktree folders on demand in the side panel so large repositories do not require a full tree scan.

/// Preserve expanded folders across board redraws.
const openDirs = new Set<string>();

type Context = {
  openFile: (path: string) => void;
  workspace: () => string | null;
  /// The tree root on disk, for copying absolute paths.
  rootPath: () => string | null;
  /// Open tabs follow an entry the tree renamed (`to`) or trashed (`to` is null).
  moved: (from: string, to: string | null) => void;
  say: (message: string, error?: boolean) => void;
};

let ctx: Context = {
  openFile: () => {},
  workspace: () => null,
  rootPath: () => null,
  moved: () => {},
  say: () => {},
};
const openFile = (path: string) => ctx.openFile(path);
const workspace = () => ctx.workspace();
let marks: GitMarks = gitMarks([]);
/// Agents and terminals change files without board events, so visible marks refresh on a timer.
const MARKS_EVERY = 5_000;

export function init(context: Context) {
  ctx = context;
  // The empty area below the rows acts on the root, like a file manager's background.
  $("tree").addEventListener("contextmenu", (event) => {
    if ((event.target as HTMLElement).closest(".treerow, .treeedit")) return;
    event.preventDefault();
    menu.openAt({ x: event.clientX, y: event.clientY }, [
      { label: t("tree.menu.newFile"), glyph: icon("file-plus"), run: () => void create("", false) },
      { label: t("tree.menu.newFolder"), glyph: icon("folder-plus"), run: () => void create("", true) },
      "sep",
      { label: t("ws.menu.reveal"), glyph: icon("external-link"), run: () => reveal("") },
    ]);
  });
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

/// Marks load before the rows because deleted files add rows of their own. An inline name being
/// typed keeps its rows; the edit redraws when it ends.
async function draw(id: string) {
  if (rename.editing()) return;
  const tree = $("tree");
  const [entries] = await Promise.all([invoke("list_dir", { id, rel: "" }), loadMarks(id)]);
  if (rename.editing()) return;
  tree.replaceChildren();
  await fill(id, "", tree, 0, entries);
}

async function loadMarks(id: string) {
  const files = await invoke("tree_git_status", { id }).catch(() => []);
  if (workspace() === id) marks = gitMarks(files);
}

/// Repaint rows in place, and rebuild them only when a file was deleted or restored.
async function repaint(id: string) {
  const before = marks.goneKey;
  await loadMarks(id);
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
function withGone(rel: string, listed: PathEntry[]): (PathEntry | GoneEntry)[] {
  const names = new Set(listed.map(entry => entry.name));
  const gone = marks.gone(rel).filter(entry => !names.has(entry.name));
  if (!gone.length) return listed;
  const key = (entry: PathEntry) => `${entry.dir ? 0 : 1}${entry.name.toLowerCase()}`;
  return [...listed, ...gone].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

async function fill(id: string, rel: string, into: HTMLElement, depth: number, listed?: PathEntry[]) {
  const entries = withGone(rel, listed ?? await invoke("list_dir", { id, rel }));
  for (const entry of entries) {
    const gone = "gone" in entry;
    const row = document.createElement("button");
    row.className = "treerow";
    row.style.paddingLeft = `${14 + depth * 20}px`;
    row.dataset.path = entry.path;
    row.dataset.dir = entry.dir ? "1" : "0";
    row.dataset.depth = String(depth);
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
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      menu.openAt({ x: event.clientX, y: event.clientY }, actions(row, entry, gone));
    });
    row.addEventListener("keydown", (event) => {
      if (gone) return;
      if (event.key === "F2") startRename(row, entry);
      else if (mac ? event.metaKey && event.key === "Backspace" : event.key === "Delete") void trash(entry);
      else return;
      event.preventDefault();
    });

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

/* File manager actions. */

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

function fail(error: unknown) {
  ctx.say(fromBack(error), true);
}

function actions(row: HTMLElement, entry: PathEntry, gone: boolean): menu.Item[] {
  const copy = { label: t("tree.menu.copyRelative"), glyph: icon("copy"), run: () => copyPath(entry.path, false) };
  if (gone) return [copy];
  const target = entry.dir ? entry.path : parentOf(entry.path);
  return [
    { label: t("tree.menu.newFile"), glyph: icon("file-plus"), run: () => void create(target, false) },
    { label: t("tree.menu.newFolder"), glyph: icon("folder-plus"), run: () => void create(target, true) },
    "sep",
    { label: t("tree.menu.rename"), glyph: icon("pencil"), hint: "F2", run: () => startRename(row, entry) },
    { label: t("tree.menu.trash"), glyph: icon("trash"), hint: mac ? "⌘⌫" : "Del", danger: true, run: () => void trash(entry) },
    "sep",
    { label: t("tree.menu.copyPath"), glyph: icon("copy"), run: () => copyPath(entry.path, true) },
    copy,
    { label: t("ws.menu.reveal"), glyph: icon("external-link"), run: () => reveal(entry.path) },
  ];
}

function copyPath(rel: string, absolute: boolean) {
  const root = ctx.rootPath();
  const path = absolute && root ? join(root.replace(/\/$/, ""), rel) : rel;
  void navigator.clipboard.writeText(path);
  ctx.say(t("say.copied", { path }));
}

function reveal(rel: string) {
  const id = workspace();
  if (id) invoke("reveal", { id, rel }).catch(fail);
}

/// Type a name in place: an indented input that replaces `hide` (or sits before `before`) until
/// Enter, Escape or blur. `done` receives the new name, or null when nothing changed.
function editName(at: { before: Element | null; into: Element; depth: number; hide?: HTMLElement }, value: string, done: (name: string | null) => void) {
  const wrap = document.createElement("div");
  wrap.className = "treeedit";
  wrap.style.paddingLeft = `${14 + at.depth * 20}px`;
  const slot = document.createElement("span");
  wrap.append(slot);
  at.into.insertBefore(wrap, at.before);
  if (at.hide) at.hide.hidden = true;
  rename.start(slot, value, (name) => {
    wrap.remove();
    if (at.hide) at.hide.hidden = false;
    done(name);
  }, "tree");
  // Like a file manager, renaming selects the name without its extension.
  const input = wrap.querySelector("input");
  const dot = value.lastIndexOf(".");
  if (input && dot > 0) input.setSelectionRange(0, dot);
}

async function create(parent: string, dir: boolean) {
  const id = workspace();
  if (!id) return;
  if (parent) openDirs.add(parent);
  await draw(id);
  const row = parent ? $("tree").querySelector<HTMLElement>(`.treerow[data-path="${CSS.escape(parent)}"]`) : null;
  const into = row ? (row.nextElementSibling as HTMLElement | null) : $("tree");
  if (!into) return;
  const depth = row ? Number(row.dataset.depth) + 1 : 0;
  editName({ before: into.firstElementChild, into, depth }, "", async (name) => {
    if (!name) return;
    const rel = join(parent, name);
    try {
      await invoke("create_path", { id, rel, dir });
      if (dir) openDirs.add(rel);
      await draw(id);
      if (!dir) openFile(rel);
    } catch (error) {
      fail(error);
    }
  });
}

function startRename(row: HTMLElement, entry: PathEntry) {
  const id = workspace();
  if (!id || rename.editing()) return;
  editName({ before: row, into: row.parentElement!, depth: Number(row.dataset.depth), hide: row }, entry.name, async (name) => {
    if (!name) return;
    const to = join(parentOf(entry.path), name);
    try {
      await invoke("rename_path", { id, from: entry.path, to });
      for (const path of [...openDirs]) {
        if (path === entry.path || path.startsWith(`${entry.path}/`)) {
          openDirs.delete(path);
          openDirs.add(to + path.slice(entry.path.length));
        }
      }
      ctx.moved(entry.path, to);
      await draw(id);
    } catch (error) {
      fail(error);
    }
  });
}

async function trash(entry: PathEntry) {
  const id = workspace();
  if (!id) return;
  const sure = await confirmDialog({
    title: t("tree.trash.title", { name: entry.name }),
    message: t(entry.dir ? "tree.trash.folder" : "tree.trash.file"),
    accept: t("tree.trash.accept"),
    cancel: t("tree.cancel"),
  });
  if (!sure) return;
  try {
    await invoke("trash_path", { id, rel: entry.path });
    ctx.moved(entry.path, null);
    await draw(id);
  } catch (error) {
    fail(error);
  }
}
