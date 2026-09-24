import type { GitFile } from "./types";

/// Git marks for the side file tree: new, modified, deleted or conflicted.
export type Mark = "A" | "M" | "D" | "U";

const RANK: Record<Mark, number> = { A: 1, D: 2, M: 2, U: 3 };

/// Resolve `tree_git_status` entries into a lookup by tree path. A folder takes the strongest mark
/// below it, with deletions shown as modifications because the deleted file has no row. Entries
/// ending in `/` are untracked folders, so everything inside them is new.
export function gitMarks(files: GitFile[]): (path: string, dir: boolean) => Mark | null {
  const own = new Map<string, Mark>();
  const folders = new Map<string, Mark>();
  const fresh: string[] = [];
  for (const file of files) {
    const mark = file.status as Mark;
    if (!(mark in RANK)) continue;
    const path = file.path.replace(/\/$/, "");
    if (path !== file.path) fresh.push(`${path}/`);
    own.set(path, mark);
    const up = mark === "D" ? "M" : mark;
    for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
      const folder = path.slice(0, cut);
      const was = folders.get(folder);
      if (!was || RANK[up] > RANK[was]) folders.set(folder, up);
    }
  }
  return (path, dir) =>
    own.get(path) ?? (dir ? folders.get(path) : undefined) ?? (fresh.some(folder => path.startsWith(folder)) ? "A" : null);
}
