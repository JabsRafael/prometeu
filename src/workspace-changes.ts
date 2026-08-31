import * as diff from "./diff";
import { icon } from "./icons";
import { t, tn } from "./i18n";
import type { Change, RepoDiff } from "./types";
import { template } from "./util";

/// Componentes do índice de mudanças. A obtenção dos diffs e a navegação
/// continuam em `workspace.ts`; este módulo só mantém e desenha a apresentação.

const collapsedRepos = new Set<string>();

export const collapsed = (key: string) => collapsedRepos.has(key);

export function nothing(text: string): HTMLElement {
  const none = document.createElement("div");
  none.className = "none";
  none.textContent = text;
  return none;
}

export function summary(repos: RepoDiff[], onlyDirty: boolean, toggleDirty: () => void): HTMLElement {
  const box = template("div", "diffsum", `<span class="ahead"></span><button class="dirtyf"></button><span class="state"></span>`);
  const ahead = repos.reduce((n, r) => n + r.ahead, 0);
  const dirty = repos.reduce((n, r) => n + r.dirty, 0);
  const unpushed = repos.reduce((n, r) => n + r.unpushed, 0);
  box.children[0].textContent =
    repos.length === 1 && repos[0].base ? tn(ahead, "diff.ahead", { base: repos[0].base }) : tn(ahead, "diff.commits");
  const chip = box.children[1] as HTMLElement;
  chip.hidden = !dirty && !onlyDirty;
  chip.innerHTML = `<span class="dot"></span><span></span>`;
  chip.children[1].textContent = t("diff.uncommitted", { n: dirty });
  chip.classList.toggle("on", onlyDirty);
  chip.title = t(onlyDirty ? "diff.onlyDirty" : "diff.onlyDirty.off");
  chip.addEventListener("click", toggleDirty);

  const state = box.children[2] as HTMLElement;
  state.hidden = !ahead;
  state.className = "state" + (unpushed ? "" : " ok");
  state.innerHTML = `${icon(unpushed ? "arrow-up" : "check", 13)}<span></span>`;
  state.children[1].textContent = unpushed ? tn(unpushed, "diff.unpushed") : t("diff.pushed");
  state.title = t(unpushed ? "diff.unpushed.title" : "diff.pushed.title");
  return box;
}

export function fileRow(id: string, repo: string, change: Change, open: (focus: string) => void): HTMLElement {
  const row = document.createElement("button");
  const seen = diff.isSeen(id, repo, change);
  row.className = "diffrow" + (seen ? " seen" : "");
  row.title = change.path;
  const cut = change.path.lastIndexOf("/");
  row.innerHTML =
    `<span class="p"><span class="dir"></span><span class="base"></span></span>` +
    `<span class="new"></span><span class="dot"></span><span class="a"></span><span class="r"></span><span class="chk"></span>`;
  row.querySelector(".dir")!.textContent = cut === -1 ? "" : change.path.slice(0, cut + 1);
  row.querySelector(".base")!.textContent = change.path.slice(cut + 1);
  row.children[1].textContent = change.new_file ? t("diff.new") : change.deleted ? t("diff.deleted") : "";
  const dot = row.children[2] as HTMLElement;
  dot.hidden = !change.dirty;
  dot.title = t("diff.dirty");
  row.children[3].textContent = change.added ? `+${change.added}` : "";
  row.children[4].textContent = change.removed ? `−${change.removed}` : "";
  row.children[5].innerHTML = seen ? icon("check", 13) : "";
  row.addEventListener("click", () => open(diff.key(repo, change.path)));
  return row;
}

export function repoRow(key: string, repo: RepoDiff, rows: HTMLElement[]): HTMLElement {
  const row = document.createElement("button");
  row.className = "diffrepo";
  const left = [repo.dirty ? t("diff.uncommitted", { n: repo.dirty }) : "", repo.unpushed ? tn(repo.unpushed, "diff.unpushed") : ""].filter(Boolean);
  row.title = [repo.base ? tn(repo.ahead, "diff.ahead", { base: repo.base }) : tn(repo.ahead, "diff.commits"), ...left].join(" · ");
  row.innerHTML =
    `<span class="tw"></span><span class="nm"></span><span class="cnt"></span>` +
    `<span class="dot"></span><span class="a"></span><span class="r"></span>`;
  row.children[1].textContent = repo.name;
  row.children[2].textContent = `${tn(repo.ahead, "diff.commitsN")} · ${tn(repo.files.length, "diff.files")}`;
  (row.children[3] as HTMLElement).hidden = !left.length;
  const added = diff.sum(repo.files, "added");
  const removed = diff.sum(repo.files, "removed");
  row.children[4].textContent = added ? `+${added}` : "";
  row.children[5].textContent = removed ? `−${removed}` : "";
  const glyph = () => {
    row.children[0].innerHTML = icon(collapsedRepos.has(key) ? "chevron-right" : "chevron-down", 14);
  };
  row.addEventListener("click", () => {
    collapsedRepos.has(key) ? collapsedRepos.delete(key) : collapsedRepos.add(key);
    for (const file of rows) file.hidden = collapsedRepos.has(key);
    glyph();
  });
  glyph();
  return row;
}
