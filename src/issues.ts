import { invoke } from "./ipc";
import { listen } from "@tauri-apps/api/event";
import { icon } from "./icons";
import { fromBack, paint, t } from "./i18n";
import * as settings from "./settings";
import type { Board, Issue, Issues, LinearStatus, Workspace } from "./types";
import { $, empty, h, template } from "./util";

/// List assigned Linear issues and launch workspaces from them. Existing workspaces replace the create action with navigation. Reuse the backend's two-minute cache, allow forced refresh, and preserve the last successful list after failure.

type Ctx = {
  say: (text: string, isError?: boolean) => void;
  board: () => Board;
  /// Notify the sidebar when the issue count changes.
  redraw: () => void;
  open: (ws: Workspace) => void;
  create: (issue: Issue) => void;
  toSettings: () => void;
};

/// Match the backend cache lifetime before requesting another list on opening.
const STALE = 120_000;

/// Order state groups with localized labels while preserving team-defined state names in rows.
const KINDS: [string, string][] = [
  ["started", t("issues.kind.started")],
  ["unstarted", t("issues.kind.unstarted")],
  ["triage", t("issues.kind.triage")],
  ["backlog", t("issues.kind.backlog")],
];

/// Persist collapsed groups; searching expands matching results regardless of saved collapse state.
const FOLD = "prometeu:issues:grupo:";
const folded = (kind: string) => localStorage.getItem(FOLD + kind) === "1";

/// Persist the selected team; an empty string means all teams.
const TEAM = "prometeu:issues:time";

let ctx: Ctx;
let got: Issues | null = null;
let loading = false;
let error = "";
let query = "";
let team = localStorage.getItem(TEAM) ?? "";
let visible = false;
let find: HTMLInputElement;
let meta: HTMLElement;

export function init(context: Ctx) {
  ctx = context;
  buildBar();
  listen<LinearStatus>("linear", ({ payload }) => {
    if (!payload.connected) {
      got = null;
      error = "";
    } else if (!got) {
      void refresh(false);
    }
    ctx.redraw();
    draw();
  });
  if (settings.linear().connected) void refresh(false);
}

/// Null means Linear is unavailable, so the sidebar hides its count.
export const count = () => (settings.linear().connected && got ? got.issues.length : null);

/// Launcher data: null means no Linear connection; an empty list while busy means loading.
export const list = () => (settings.linear().connected ? (got?.issues ?? []) : null);
export const busy = () => loading;

/// Load only when missing or stale; used when opening the launcher picker.
export function load(): Promise<void> {
  if (!settings.linear().connected || loading) return Promise.resolve();
  const old = !got || Date.now() / 1000 - got.fetched_at > STALE / 1000;
  return old ? refresh(false) : Promise.resolve();
}

export function show() {
  visible = true;
  void load();
  draw();
  find.focus();
}

export function hide() {
  visible = false;
}

async function refresh(force: boolean) {
  loading = true;
  drawMeta();
  try {
    got = await invoke("linear_issues", { force });
    error = "";
  } catch (e) {
    error = fromBack(e);
  }
  loading = false;
  ctx.redraw();
  draw();
}

/* Toolbar. */

function buildBar() {
  const bar = $("ibar");
  bar.innerHTML = `
    <label class="ifind">${icon("search", 14)}<input spellcheck="false" /></label>
    <span class="spacer"></span>
    <span class="imeta" id="imeta"></span>
    <button class="ico" id="irefresh" data-t-title="issues.refresh">${icon("rotate")}</button>`;
  paint(bar);
  find = bar.querySelector("input")!;
  find.placeholder = t("issues.search");
  meta = bar.querySelector("#imeta")!;
  find.addEventListener("input", () => {
    query = find.value.trim().toLowerCase();
    drawList();
  });
  find.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      find.value = "";
      query = "";
      drawList();
    }
  });
  bar.querySelector("#irefresh")!.addEventListener("click", () => {
    if (settings.linear().connected && !loading) void refresh(true);
  });
}

function drawMeta() {
  meta.classList.toggle("err", !!error && !loading);
  meta.textContent = loading
    ? t("issues.busy")
    : error
      ? error
      : got
        ? t("issues.updated", { when: ago(got.fetched_at * 1000) })
        : "";
  ($("irefresh") as HTMLButtonElement).disabled = loading || !settings.linear().connected;
}

/* Issue list. */

export function draw() {
  if (!visible) return;
  drawMeta();
  drawList();
}

function drawList() {
  const list = $("ilist");
  list.replaceChildren();
  // Hide team filters until a list exists; drawTeams restores them afterward.
  const teams = $("iteams");
  teams.replaceChildren();
  teams.hidden = true;

  if (!settings.linear().connected) {
    list.append(
      empty(t("issues.off.title"), t("issues.off.body"), [t("issues.off.action"), ctx.toSettings]),
    );
    return;
  }
  if (!got) {
    if (!loading && error) {
      list.append(empty(t("issues.failed.title"), error, [t("issues.failed.action"), () => refresh(true)]));
    }
    return;
  }

  const found = got.issues.filter(matches);
  drawTeams(found);
  const hits = team ? found.filter((i) => i.team === team) : found;
  if (!hits.length) {
    list.append(
      query || team
        ? empty(t("issues.noMatch.title"), t("issues.noMatch.body"))
        : empty(t("issues.empty.title"), t("issues.empty.body")),
    );
    return;
  }

  const kinds = [...KINDS, ...unknownKinds(hits)];
  for (const [kind, label] of kinds) {
    const mine = hits.filter((i) => i.state.kind === kind).sort(byUrgency);
    if (!mine.length) continue;
    const shut = !query && folded(kind);
    const head = template(
      "button",
      "igroup" + (shut ? " shut" : ""),
      `<span class="gc"></span><span class="t"></span><span class="c"></span>`,
    );
    head.children[0].innerHTML = icon(shut ? "chevron-right" : "chevron-down", 14);
    head.children[1].textContent = label;
    head.children[2].textContent = String(mine.length);
    head.title = t(shut ? "issues.group.show" : "issues.group.fold", { group: label });
    head.addEventListener("click", () => {
      localStorage.setItem(FOLD + kind, shut ? "0" : "1");
      drawList();
    });
    list.append(head);
    if (shut) continue;
    for (const issue of mine) list.append(row(issue));
  }
}

/// Show team filters only for multiple teams. Derive pills from the full list and counts from search matches so typing does not reshape the toolbar.
function drawTeams(found: Issue[]) {
  const box = $("iteams");
  box.replaceChildren();
  const keys = [...new Set(got!.issues.map((i) => i.team).filter(Boolean))].sort();
  // Clear a selected team that disappeared from the list instead of hiding all results.
  if (team && !keys.includes(team)) pickTeam("");
  box.hidden = keys.length < 2;
  if (box.hidden) return;

  const label = template("span", "tlabel", `${icon("filter", 13)}<span></span>`);
  label.children[1].textContent = t("issues.team");
  box.append(label);

  const pills = h("div", "tpills");
  for (const key of ["", ...keys]) {
    const mine = key ? found.filter((i) => i.team === key) : found;
    const pill = template("button", "tpill" + (key === team ? " on" : ""), `<span></span><span class="c"></span>`);
    pill.children[0].textContent = key || t("issues.team.all");
    pill.children[1].textContent = String(mine.length);
    pill.addEventListener("click", () => {
      pickTeam(key);
      drawList();
    });
    pills.append(pill);
  }
  box.append(pills);
}

function pickTeam(key: string) {
  team = key;
  if (key) localStorage.setItem(TEAM, key);
  else localStorage.removeItem(TEAM);
}

/// Keep issues with future, unknown Linear state types visible.
function unknownKinds(list: Issue[]): [string, string][] {
  const known = new Set(KINDS.map(([k]) => k));
  const extra = new Set(list.map((i) => i.state.kind).filter((k) => !known.has(k)));
  return [...extra].map((k) => [k, k]);
}

/// Sort urgent issues first and unprioritized issues last, breaking ties by recency.
function byUrgency(a: Issue, b: Issue) {
  const rank = (p: number) => (p === 0 ? 5 : p);
  return rank(a.priority) - rank(b.priority) || b.updated_at.localeCompare(a.updated_at);
}

function matches(i: Issue) {
  if (!query) return true;
  const hay = [i.identifier, i.title, i.project ?? "", i.team, i.state.name, i.description ?? ""]
    .join(" ")
    .toLowerCase();
  return query.split(/\s+/).every((word) => hay.includes(word));
}

function row(issue: Issue): HTMLElement {
  const el = template(
    "div",
    "irow",
    `<span class="prio p${Math.min(issue.priority, 4)}"><i></i><i></i><i></i></span>` +
      `<span class="iid"></span>` +
      `<span class="ititle"><b></b><span class="iproj"></span></span>` +
      `<span class="istate"><i class="dot"></i><span></span></span>` +
      `<span class="iact"></span>` +
      `<span class="iago"></span>`,
  );
  el.tabIndex = 0;
  el.title = issue.description ? issue.description.slice(0, 400) : issue.title;
  (el.querySelector(".prio") as HTMLElement).title = issue.priority_label;
  el.querySelector(".iid")!.textContent = issue.identifier;
  el.querySelector(".ititle b")!.textContent = issue.title;
  el.querySelector(".iproj")!.textContent = issue.project ?? "";
  (el.querySelector(".istate .dot") as HTMLElement).style.background = issue.state.color;
  el.querySelector(".istate span")!.textContent = issue.state.name;
  el.querySelector(".iago")!.textContent = ago(Date.parse(issue.updated_at));

  // Row clicks open Linear; buttons own other actions.
  const openLinear = () => invoke("linear_open", { url: issue.url }).catch((e) => ctx.say(fromBack(e), true));
  el.addEventListener("click", openLinear);
  el.addEventListener("keydown", (e) => e.key === "Enter" && openLinear());

  const act = el.querySelector(".iact")!;
  const owner = ctx.board().workspaces.find((w) => w.issue?.id === issue.id && !w.archived);
  const btn = h("button", owner ? "ghost sm" : "pri sm", t(owner ? "issues.open" : "issues.create"));
  btn.title = owner
    ? `${owner.title} · ${owner.branch}`
    : t("issues.create.title", { branch: issue.branch_name });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    owner ? ctx.open(owner) : ctx.create(issue);
  });
  act.append(btn);
  return el;
}

/// Compact relative time indicates recent issue activity.
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t("ago.now");
  if (s < 3600) return t("ago.min", { n: Math.round(s / 60) });
  if (s < 86_400) return t("ago.hour", { n: Math.round(s / 3600) });
  return t("ago.day", { n: Math.round(s / 86_400) });
}
