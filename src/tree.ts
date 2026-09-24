import { invoke } from "./ipc";
import { fileIcon, icon } from "./icons";
import * as menu from "./menu";
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
  paint("selected", path);
}

function paint(cls: "selected" | "targeted", path: string | null) {
  for (const row of $("tree").querySelectorAll(`.treerow.${cls}`)) row.classList.remove(cls);
  if (path) $("tree").querySelector(`.treerow[data-path="${CSS.escape(path)}"]`)?.classList.add(cls);
}

function aim(path: string | null) {
  target = path;
  paint("targeted", path);
}

async function draw(id: string) {
  const tree = $("tree");
  tree.replaceChildren();
  await fill(id, "", tree, 0);
}

async function fill(id: string, rel: string, into: HTMLElement, depth: number) {
  const entries = await invoke("list_dir", { id, rel });
  for (const entry of entries) {
    const row = document.createElement("button");
    row.className = "treerow";
    row.dataset.path = entry.path;
    if (entry.path === selected) row.classList.add("selected");
    if (entry.path === target) row.classList.add("targeted");
    row.style.paddingLeft = `${14 + depth * 20}px`;
    row.innerHTML = `<span class="tw"></span><span class="tn"></span><span class="tc"></span>`;
    // Expanded folders change their icon and hover chevron.
    const glyph = (open: boolean) => {
      row.children[0].innerHTML = entry.dir ? icon(open ? "folder-open" : "folder") : fileIcon(entry.name);
      row.children[2].innerHTML = entry.dir ? icon(open ? "chevron-down" : "chevron-right", 14) : "";
    };
    glyph(false);
    row.children[1].textContent = entry.name;
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
          if (!kids.childElementCount) await fill(id, entry.path, kids, depth + 1);
        }
        kids.hidden = isOpen;
        glyph(!isOpen);
      };
    }

    // Replace the engine's page menu, which offers web actions over the file's name. Scope it to the
    // row so the viewer and the composer keep the native editing menu.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
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
      else openFile(entry.path);
    });

    if (entry.dir && openDirs.has(entry.path)) {
      glyph(true);
      kids.hidden = false;
      await fill(id, entry.path, kids, depth + 1);
    }
  }
}
