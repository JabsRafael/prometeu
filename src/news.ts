import changelog from "../CHANGELOG.md?raw";
import { getVersion } from "@tauri-apps/api/app";
import { icon } from "./icons";
import { current as locale, t, type Key } from "./i18n";
import { md } from "./markdown";
import { h, template } from "./util";

/// Bundle CHANGELOG.md, the same source CI uses for releases, so release history works offline and for DMG installs. Show unseen installed versions once at startup; Settings always offers the full bundled history.

export type Release = { version: string; date: string; body: string };

/// Version-dependent UI waits for init to identify the installed release.
let version = "";

/// Store the last viewed release locally, like the language preference.
const KEY = "prometeu:novidades";
const seen = () => localStorage.getItem(KEY);
const markSeen = (v: string) => localStorage.setItem(KEY, v);

/* Changelog parsing. */

/// A git-cliff release heading, such as ## [0.4.8] - 2026-08-31.
const HEAD = /^## \[(\d[^\]]*)\](?:\s*-\s*(\S+))?\s*$/;

export function parse(src: string): Release[] {
  const out: Release[] = [];
  let at: Release | null = null;
  for (const line of src.split("\n")) {
    const head = HEAD.exec(line);
    if (head) {
      at = { version: head[1], date: head[2] ?? "", body: "" };
      out.push(at);
    } else if (at) {
      at.body += `${line}\n`;
    }
  }
  // Ignore the preamble and releases without content.
  return out.map((r) => ({ ...r, body: r.body.trim() })).filter((r) => r.body);
}

/// Compare the three numeric components; this 0.x changelog does not contain prereleases.
export function cmp(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < 3; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/// Show releases newer than the last viewed version, through the installed version. Fresh installs see only the current release; Settings offers older history.
export function unseen(all: Release[], current: string, from: string | null): Release[] {
  const upTo = all.filter((r) => cmp(r.version, current) <= 0);
  if (!from) return upTo.slice(0, 1);
  return upTo.filter((r) => cmp(r.version, from) > 0);
}

/// Translate git-cliff section headings from cliff.toml; preserve commit descriptions as content.
const SECTIONS: Record<string, Key> = {
  Novidades: "news.sec.feat",
  Correções: "news.sec.fix",
  Desempenho: "news.sec.perf",
  Revertido: "news.sec.revert",
  Outros: "news.sec.other",
};

export function localize(body: string): string {
  const marked = [...body.matchAll(/<!-- lang:(pt-BR|en) -->\s*([\s\S]*?)(?=<!-- lang:|$)/g)];
  if (marked.length) return marked.find((part) => part[1] === locale())?.[2].trim() ?? "";
  return body.replace(/^### (.+)$/gm, (line, name: string) => {
    const key = SECTIONS[name.trim()];
    return key ? `### ${t(key)}` : line;
  });
}

/// All bundled releases, newest first.
export const all = (): Release[] =>
  parse(changelog).filter((r) => !version || cmp(r.version, version) <= 0);

/* Dialog. */

/// Hide invalid dates while retaining the release entry.
function when(date: string): string {
  const at = new Date(`${date}T00:00:00`);
  if (!date || Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
}

export function openNews(releases: Release[], sub: string) {
  const veil = document.getElementById("veil")!;
  const sheet = h("div", "sheet news");
  sheet.append(
    template(
      "div",
      "sheettop",
      `<span class="who"><b></b></span><span class="spacer"></span><span class="sub"></span>`,
    ),
  );
  sheet.querySelector(".sheettop b")!.textContent = t("news.title");
  sheet.querySelector(".sheettop .sub")!.textContent = sub;

  const list = h("div", "newslist");
  if (!releases.length) list.append(h("div", "newsempty", t("news.empty")));
  for (const rel of releases) {
    const box = h("div", "newsrel");
    const head = template("div", "newsver", `<b></b><span></span>`);
    head.children[0].textContent = `v${rel.version}`;
    head.children[1].textContent = when(rel.date);
    // Render CI markdown through the conversation renderer, which escapes raw HTML and intercepts links.
    box.append(head, template("div", "md", md(localize(rel.body))));
    list.append(box);
  }
  sheet.append(list);

  const bar = template("div", "sheetbar", `<span class="spacer"></span>`);
  const close = h("button", "pri md", t("news.close")) as HTMLButtonElement;
  bar.append(close);
  sheet.append(bar);

  const hide = () => {
    veil.replaceChildren();
    veil.hidden = true;
    window.removeEventListener("keydown", key);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") hide();
  };
  close.addEventListener("click", hide);
  window.addEventListener("keydown", key);

  veil.replaceChildren(sheet);
  veil.hidden = false;
  close.focus();
}

/// Show updater release notes before the new version is installed.
export function openNotes(next: string, body: string) {
  openNews([{ version: next, date: "", body }], t("news.sub.next", { version: `v${next}` }));
}

/* Entry points. */

/// Settings always exposes the full release history.
export function settingsRow(): HTMLElement {
  const row = template(
    "div",
    "setrow",
    `<span class="glyph">${icon("sparkles", 18)}</span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".txt b")!.textContent = t("settings.news");
  row.querySelector(".txt span")!.textContent = t("settings.news.body");
  const btn = h("button", "outline md", t("settings.news.open")) as HTMLButtonElement;
  btn.addEventListener("click", () =>
    openNews(all(), t("news.sub.app", { version: version ? `v${version}` : "" })),
  );
  row.querySelector(".act")!.append(btn);
  return row;
}

/// Show newly installed releases once at startup. Mark them seen on opening so every dismissal path behaves consistently.
export async function init() {
  version = await getVersion();
  const fresh = unseen(all(), version, seen());
  markSeen(version);
  if (fresh.length) openNews(fresh, t("news.sub.fresh", { version: `v${version}` }));
}
