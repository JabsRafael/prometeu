import { invoke } from "./ipc";
import { fileIcon, icon } from "./icons";
import { $, debounce } from "./util";

/// Load worktree folders on demand in the side panel so large repositories do not require a full tree scan.

/// Preserve expanded folders across board redraws.
const openDirs = new Set<string>();

let openFile: (path: string) => void = () => {};
let workspace: () => string | null = () => null;

export function init(ctx: { openFile: (path: string) => void; workspace: () => string | null }) {
  openFile = ctx.openFile;
  workspace = ctx.workspace;
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
}

/// Debounce board-driven refreshes because each open folder requires list_dir; agent bursts would otherwise repeat identical IPC work.
export const redrawSoon = debounce(200, redraw);

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

    if (!entry.dir) {
      row.addEventListener("click", () => openFile(entry.path));
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
        if (!kids.childElementCount) await fill(id, entry.path, kids, depth + 1);
      }
      kids.hidden = isOpen;
      glyph(!isOpen);
    });

    if (openDirs.has(entry.path)) {
      glyph(true);
      kids.hidden = false;
      await fill(id, entry.path, kids, depth + 1);
    }
  }
}
