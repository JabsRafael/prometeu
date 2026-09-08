import { avatar, fileIcon, icon } from "./icons";
import { t, tn } from "./i18n";
import type { Change, RepoDiff } from "./types";
import { highlight } from "./highlight";
import { button, checkbox } from "./ui";

/// Stack workspace file diffs in one scroll area, grouped by repository with sticky headers. Preserve scroll and collapsed state across board updates.

const MAX_ROWS = 2500;
/// Match .dbody line height when reserving unmounted file space so lazy rendering does not shift the scroll position.
const ROW_H = 20;

let signature = "";
const shut = new Set<string>();
const shutRepos = new Set<string>();

/// Include repository identity because multiple repositories can contain the same path.
export const key = (repo: string, path: string) => `${repo}/${path}`;

export const keys = (repos: RepoDiff[]) => repos.flatMap((r) => r.files.map((f) => key(r.name, f.path)));

export const sum = (files: Change[], of: "added" | "removed") => files.reduce((n, c) => n + c[of], 0);

type View = {
  id: string;
  repos: RepoDiff[];
  layout?: "unified" | "split";
  /// Sidebar navigation scrolls to the file without changing or redrawing the diff.
  focus?: string;
  /// Choose the empty-state message.
  empty: string;
  /// Notify the caller when seen state changes so it can update the sidebar and tab.
  onSeen: () => void;
  /// Double-click opens the editable file; the caller translates repository paths into workspace paths.
  onOpen: (repo: string, path: string) => void;
};

/// Cache each file by patch signature. One changed file must not rebuild every unchanged diff on board updates.
const drawn = new Map<string, Drawn>();
let drawnId = "";

type Drawn = {
  el: HTMLElement;
  stamp: string;
  /// Reapply seen and collapsed state to reused elements.
  sync: (view: View) => void;
  reveal: () => void;
};

/// Rebuild only when patch signatures change; avoid repeatedly comparing large concatenated patches.
export function render(host: HTMLElement, view: View) {
  const { id, repos } = view;
  const identity = `${id}\0${view.layout ?? "unified"}`;
  if (drawnId !== identity) {
    watcher?.disconnect();
    drawn.clear();
    drawnId = identity;
    signature = "";
  }
  const sig = [id, ...repos.map((r) => r.name + r.files.map((c) => `${c.path}${stamp(c)}`).join(""))].join("\0");
  if (sig !== signature || watched !== host) {
    const active = document.activeElement as HTMLElement | null;
    const focused = active && host.contains(active) ? active : null;
    const focusedFile = focused?.closest<HTMLElement>(".dfile")?.dataset.key;
    const focusedControl = focused?.matches(".dseen") ? ".dseen" : focused?.matches(".dopen") ? ".dopen" : ".dtoggle";
    const top = host.scrollTop;
    signature = sig;
    watch(host);
    const some = repos.filter((r) => r.files.length);
    const multi = repos.length > 1;
    host.replaceChildren(...(some.length ? some.flatMap((r) => (multi ? [group(view, r)] : files(view, r))) : [none(view.empty)]));
    // Remove vanished files from the cache instead of retaining every historical patch.
    const live = new Set(keys(repos));
    for (const [k, d] of drawn) {
      if (!live.has(k)) {
        watcher?.unobserve(d.el);
        drawn.delete(k);
      }
    }
    host.scrollTop = top;
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    else if (focusedFile) host.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusedFile)}"] ${focusedControl}`)?.focus({ preventScroll: true });
  }
  if (view.focus) scrollTo(host, view.focus);
}

/* Viewport rendering. */

/// Mount file bodies near the viewport to avoid creating thousands of offscreen diff rows.
const filler = new WeakMap<Element, () => void>();
let watcher: IntersectionObserver | null = null;
let watched: HTMLElement | null = null;

function watch(host: HTMLElement) {
  if (watched === host && watcher) return;
  watcher?.disconnect();
  watched = host;
  // Mount one viewport early so scrolling reaches rendered content.
  watcher = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) filler.get(e.target)?.();
    },
    { root: host, rootMargin: "800px 0px" },
  );
}

/// Invalidate the render signature for state-only updates such as marking all files seen.
export function invalidate() {
  signature = "";
}

/// Expand or collapse every file and invalidate the render signature.
export function foldAll(all: string[]) {
  const allShut = all.length > 0 && all.every((k) => shut.has(k));
  shut.clear();
  if (!allShut) for (const k of all) shut.add(k);
  signature = "";
}

function scrollTo(host: HTMLElement, k: string) {
  const target = host.querySelector(`[data-key="${CSS.escape(k)}"]`);
  if (!target) return;
  const repo = target.closest(".drepo")?.querySelector<HTMLButtonElement>(".drhead");
  if (repo?.getAttribute("aria-expanded") === "false") repo.click();
  drawn.get(k)?.reveal();
  // Mount before scrolling so navigation immediately reveals content.
  filler.get(target)?.();
  // Scroll only the diff container. scrollIntoView can also move the overflow-hidden application root and hide its header.
  host.scrollTop += target.getBoundingClientRect().top - host.getBoundingClientRect().top;
  target.querySelector<HTMLButtonElement>(".dtoggle")?.focus({ preventScroll: true });
}

function none(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "none";
  el.textContent = text;
  return el;
}

/* Seen state. */

/// Persist seen patch signatures per workspace. A later patch change automatically marks the file unread again.
const seenOf = new Map<string, Record<string, string>>();
const seenKey = (id: string) => `prometeu:visto:${id}`;

function seenMap(id: string): Record<string, string> {
  let m = seenOf.get(id);
  if (!m) {
    try {
      m = JSON.parse(localStorage.getItem(seenKey(id)) ?? "{}") as Record<string, string>;
    } catch {
      m = {};
    }
    seenOf.set(id, m);
  }
  return m;
}

function saveSeen(id: string) {
  const m = seenMap(id);
  if (Object.keys(m).length) localStorage.setItem(seenKey(id), JSON.stringify(m));
  else localStorage.removeItem(seenKey(id));
}

/// Cache compact signatures by patch object to avoid repeatedly hashing large diffs.
const stamps = new WeakMap<Change, string>();
function stamp(c: Change): string {
  let s = stamps.get(c);
  if (s === undefined) {
    let h = 5381;
    for (let i = 0; i < c.patch.length; i++) h = (Math.imul(h, 33) ^ c.patch.charCodeAt(i)) >>> 0;
    s = `${h.toString(36)}:${c.added}:${c.removed}`;
    stamps.set(c, s);
  }
  return s;
}

export const isSeen = (id: string, repo: string, c: Change) => seenMap(id)[key(repo, c.path)] === stamp(c);

export function setSeen(id: string, repo: string, c: Change, on: boolean) {
  const m = seenMap(id);
  if (on) m[key(repo, c.path)] = stamp(c);
  else delete m[key(repo, c.path)];
  saveSeen(id);
}

export function seeAll(id: string, repos: RepoDiff[]) {
  const m = seenMap(id);
  for (const r of repos) for (const c of r.files) m[key(r.name, c.path)] = stamp(c);
  saveSeen(id);
}

export const unseen = (id: string, repos: RepoDiff[]) =>
  repos.reduce((n, r) => n + r.files.filter((c) => !isSeen(id, r.name, c)).length, 0);

/// Remove seen state when its workspace leaves the board.
export function pruneSeen(alive: Set<string>) {
  const gone: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("prometeu:visto:") && !alive.has(k.slice("prometeu:visto:".length))) gone.push(k);
  }
  for (const k of gone) {
    localStorage.removeItem(k);
    seenOf.delete(k.slice("prometeu:visto:".length));
  }
}

/* Repository section. */

/// A collapsible repository section shows its base branch, totals, and files under a sticky heading.
function group(view: View, r: RepoDiff): HTMLElement {
  const box = document.createElement("div");
  box.className = "drepo";

  const head = document.createElement("button");
  head.className = "drhead";
  head.title = r.name;
  head.innerHTML =
    `<span class="dtw"></span>${avatar(r.name)}<span class="nm"></span>` +
    `<span class="cnt"></span><span class="a"></span><span class="r"></span>`;
  head.children[2].textContent = r.name;
  const ahead = r.base ? tn(r.ahead, "diff.ahead", { base: r.base }) : tn(r.ahead, "diff.commits");
  head.children[3].textContent = `${ahead} · ${tn(r.files.length, "diff.files")}`;
  const added = sum(r.files, "added");
  const removed = sum(r.files, "removed");
  head.children[4].textContent = added ? `+${added}` : "";
  head.children[5].textContent = removed ? `−${removed}` : "";

  const body = document.createElement("div");
  body.append(...files(view, r));

  const k = `${view.id}/${r.name}`;
  const glyph = () => {
    head.children[0].innerHTML = icon(shutRepos.has(k) ? "chevron-right" : "chevron-down", 14);
    body.hidden = shutRepos.has(k);
    head.setAttribute("aria-expanded", String(!body.hidden));
  };
  head.addEventListener("click", () => {
    shutRepos.has(k) ? shutRepos.delete(k) : shutRepos.add(k);
    glyph();
  });
  glyph();
  box.append(head, body);
  return box;
}

/// Reuse unchanged file elements and rebuild only changed patches.
function files(view: View, r: RepoDiff): HTMLElement[] {
  return r.files.map((c) => {
    const k = key(r.name, c.path);
    const mark = stamp(c);
    const old = drawn.get(k);
    if (old?.stamp === mark) {
      old.sync(view);
      return old.el;
    }
    if (old) watcher?.unobserve(old.el);
    const made = file(view, r.name, c);
    drawn.set(k, { ...made, stamp: mark });
    return made.el;
  });
}

/* File section. */

function file(view: View, repo: string, change: Change): Omit<Drawn, "stamp"> {
  let currentView = view;
  const k = key(repo, change.path);
  const layout = view.layout ?? "unified";
  const box = document.createElement("article");
  box.className = "dfile";
  box.dataset.key = k;

  const body = document.createElement("div");
  body.className = "dbody dlayout-" + layout;
  body.id = "diff-" + crypto.randomUUID();

  const head = document.createElement("div");
  head.className = "dhead";
  const fold = button("", () => {
    shut.has(k) ? shut.delete(k) : shut.add(k);
    glyph();
    fill();
  }, "ghost");
  fold.classList.add("dtoggle");
  fold.setAttribute("aria-label", t("diff.toggle", { path: change.path }));
  fold.setAttribute("aria-controls", body.id);
  fold.title = change.deleted ? change.path : change.path + "\n" + t("diff.open");
  const cut = change.path.lastIndexOf("/");
  fold.innerHTML =
    '<span class="dtw"></span>' + fileIcon(change.path.slice(cut + 1), 14) +
    '<span class="dpath"><span class="dir"></span><span class="nm"></span></span>';
  const path = fold.querySelector(".dpath")!;
  path.children[0].textContent = cut === -1 ? "" : change.path.slice(0, cut + 1);
  path.children[1].textContent = change.path.slice(cut + 1);

  const stats = document.createElement("span");
  stats.className = "dstats";
  stats.innerHTML = '<span class="new"></span><span class="dot"></span><span class="a"></span><span class="r"></span>';
  stats.children[0].textContent = change.new_file ? t("diff.new") : change.deleted ? t("diff.deleted") : "";
  const dot = stats.children[1] as HTMLElement;
  dot.hidden = !change.dirty;
  dot.title = t("diff.dirty");
  stats.children[2].textContent = change.added ? "+" + change.added : "";
  stats.children[3].textContent = change.removed ? "−" + change.removed : "";

  const open = button(t("git.openFile"), () => currentView.onOpen(repo, change.path), "ghost");
  open.classList.add("dopen");
  open.disabled = change.deleted;
  const seen = checkbox(t("diff.reviewed"), false);
  seen.control.classList.add("dseen");
  seen.control.setAttribute("aria-label", t("diff.reviewFile", { path: change.path }));
  const paintSeen = () => {
    const on = isSeen(currentView.id, repo, change);
    box.classList.toggle("seen", on);
    seen.control.checked = on;
  };
  seen.control.onchange = () => {
    setSeen(currentView.id, repo, change, seen.control.checked);
    paintSeen();
    currentView.onSeen();
  };

  // Mount file bodies only near the viewport. Both layouts limit patch rows before aligning the sides.
  let full = false;
  const fill = () => {
    if (full || shut.has(k)) return;
    full = true;
    body.style.minHeight = "";
    body.append(...lines(change, layout));
    watcher?.unobserve(box);
  };
  body.style.minHeight = rowCount(change.patch, layout) * ROW_H + "px";
  filler.set(box, fill);
  watcher?.observe(box);

  const glyph = () => {
    fold.children[0].innerHTML = icon(shut.has(k) ? "chevron-right" : "chevron-down", 14);
    body.hidden = shut.has(k);
    fold.setAttribute("aria-expanded", String(!body.hidden));
  };
  // Preserve double-click navigation without triggering a second action on review or open controls.
  head.addEventListener("dblclick", event => {
    if (!change.deleted && !(event.target as Element).closest(".dopen, .ui-check")) currentView.onOpen(repo, change.path);
  });
  head.append(fold, stats, open, seen.label);
  box.append(head, body);
  paintSeen();
  glyph();
  return {
    el: box,
    sync: next => {
      currentView = next; paintSeen(); glyph();
      // A new host replaces the observer. Observe again to mount reopened visible files while retaining lazy rendering offscreen.
      if (!full) { watcher?.unobserve(box); watcher?.observe(box); }
    },
    reveal: () => { shut.delete(k); glyph(); fill(); },
  };
}

function rowCount(patch: string, layout: "unified" | "split"): number {
  if (!patch) return 1;
  const all = rows(patch), visible = all.slice(0, MAX_ROWS);
  return (layout === "split" ? splitRows(visible).length : visible.length) + Number(all.length > MAX_ROWS);
}

/// For binary, metadata-only or truncated patches, explain missing hunks; line totals already appear in the header.
function lines(change: Change, layout: "unified" | "split"): HTMLElement[] {
  if (!change.patch) {
    const el = document.createElement("div");
    el.className = "dnote";
    el.textContent = t("diff.binary");
    return [el];
  }
  const all = rows(change.patch), visible = all.slice(0, MAX_ROWS);
  const out = layout === "split"
    ? splitRows(visible).map(r => splitRow(r, change.path))
    : visible.map(r => row(r, change.path));
  if (all.length > MAX_ROWS) {
    const el = document.createElement("div");
    el.className = "dnote";
    el.textContent = t("diff.truncated", { n: all.length - MAX_ROWS });
    out.push(el);
  }
  return out;
}

function cell(className: string, text: string | number | null): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text === null ? "" : String(text);
  return el;
}

function code(text: string, path: string, className = ""): HTMLElement {
  const el = document.createElement("code");
  el.className = className;
  el.innerHTML = highlight(text, path);
  return el;
}

function row(r: Row, path: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "drow " + r.kind;
  if (r.kind === "hunk") {
    el.append(cell("dhunk", r.text));
  } else {
    el.append(cell("dno before", r.before), cell("dno after", r.after),
      cell("dsign", r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""), code(r.text, path));
  }
  return el;
}

function splitRow(r: SplitRow, path: string): HTMLElement {
  if (r.kind === "hunk") return row(r.hunk, path);
  const el = document.createElement("div");
  el.className = "drow dsplit";
  for (const [side, value] of [["before", r.before], ["after", r.after]] as const) {
    const kind = value?.kind ?? "blank";
    el.append(cell("dno " + side + " " + kind, value?.[side] ?? null),
      cell("dsign " + kind, kind === "add" ? "+" : kind === "del" ? "−" : ""),
      code(value?.text ?? "", path, kind));
  }
  return el;
}

/* Unified patch rows. */

export type Row = {
  kind: "hunk" | "ctx" | "add" | "del";
  before: number | null;
  after: number | null;
  text: string;
};

/// Each side keeps its own line numbers. Metadata outside hunks is not content; newline markers consume no positions.
export function rows(patch: string): Row[] {
  const out: Row[] = [];
  let before = 0, after = 0, inHunk = false;
  for (const line of patch.split("\n")) {
    if (!line || line.startsWith("\\")) continue;
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: (.*))?$/.exec(line);
      inHunk = !!m;
      if (!m) continue;
      before = Number(m[1]);
      after = Number(m[2]);
      out.push({ kind: "hunk", before: null, after: null, text: line });
      continue;
    }
    if (!inHunk) continue;
    const text = line.slice(1);
    if (line[0] === "+") out.push({ kind: "add", before: null, after: after++, text });
    else if (line[0] === "-") out.push({ kind: "del", before: before++, after: null, text });
    else if (line[0] === " ") out.push({ kind: "ctx", before: before++, after: after++, text });
    else inHunk = false;
  }
  return out;
}

export type SplitRow = { kind: "hunk"; hunk: Row } | { kind: "line"; before: Row | null; after: Row | null };

/// Align each deletion/addition block without crossing context or hunk boundaries. Unmatched sides remain empty without repeated text or line numbers.
export function splitRows(all: Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  for (let i = 0; i < all.length;) {
    const current = all[i];
    if (current.kind === "hunk") { out.push({ kind: "hunk", hunk: current }); i++; continue; }
    if (current.kind === "ctx") { out.push({ kind: "line", before: current, after: current }); i++; continue; }
    const before: Row[] = [], after: Row[] = [];
    while (i < all.length && (all[i].kind === "del" || all[i].kind === "add")) {
      (all[i].kind === "del" ? before : after).push(all[i++]);
    }
    for (let n = 0; n < Math.max(before.length, after.length); n++) {
      out.push({ kind: "line", before: before[n] ?? null, after: after[n] ?? null });
    }
  }
  return out;
}
