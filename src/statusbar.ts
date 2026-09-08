import { openCleanup } from "./cleanup";
import type { AgentDescriptor } from "./agents";
import { brand, icon } from "./icons";
import { fromBack, t } from "./i18n";
import * as menu from "./menu";
import { invoke, type IpcCall } from "./ipc";
import type { Board, ProviderId } from "./types";
import { $ } from "./util";

/// App-wide provider usage and machine resources. Values cover all workspaces; clicking a chip opens its detail panel.

export type Window = { kind: string; pct: number; resets: number; scope?: string; label?: string };
export type Agent = { windows: Window[]; at: number };
export type Usage = Record<string, Agent>;
export type Account = {
  id: string;
  provider: ProviderId;
  email: string | null;
  plan: string | null;
  connected: boolean;
  revision: number;
};
export type Accounts = {
  accounts: Account[];
  active: Partial<Record<ProviderId, string>>;
  login: { id: string; provider: ProviderId } | null;
};

export type Proc = { kind: string; name: string; detail: string; rss: number; cpu: number; hist: number[] };
export type Port = { id: string; title: string; port: number };
export type Machine = { rss: number; cpu: number; procs: Proc[]; terms: number; ports: Port[] };

/// Usage thresholds distinguish ordinary readings, warnings, and exhausted quota.
const WARN = 75;
const HOT = 90;

let usage: Usage = {};
let accounts: Accounts | null = null;
let accountAction = false;
let usageProvider: ProviderId | null = null;
/// Start with the historical Claude fallback until installed providers are discovered.
let agents: Pick<AgentDescriptor, "id" | "label">[] = [{ id: "claude", label: "Claude" }];
let machine: Machine = { rss: 0, cpu: 0, procs: [], terms: 0, ports: [] };
let say: (text: string, isError?: boolean) => void = () => {};

/// Sleep preference belongs to this Mac and is not synchronized.
type Awake = "on" | "agent" | "off";
const AWAKE_STORE = "prometeu:acordado";
const AWAKE: Awake[] = ["on", "agent", "off"];
let awake: Awake = read();
/// Board activity controls the keep-awake-while-working mode.
let working = false;
/// Remember the backend state to avoid redundant commands.
let held: boolean | null = null;

/// Without localStorage, including in Node tests, default to allowing sleep.
function read(): Awake {
  try {
    const saved = localStorage.getItem(AWAKE_STORE);
    return AWAKE.find((mode) => mode === saved) ?? "off";
  } catch {
    return "off";
  }
}

export function init(hooks: { say: (text: string, isError?: boolean) => void }) {
  say = hooks.say;
  hold();
}

/// Recompute agent activity after board changes.
export function boardChanged(board: Board) {
  const next = board.workspaces.some((w) => w.tabs.some((tab) => tab.status === "rodando"));
  if (next === working) return;
  working = next;
  hold();
  draw();
}

/// Send a sleep command only when its desired state changes; agent tools publish frequent board updates.
function hold() {
  const want = awake === "on" || (awake === "agent" && working);
  if (want === held) return;
  held = want;
  invoke("set_awake", { on: want }).catch((err) => say(fromBack(err), true));
}

const holding = () => awake === "on" || (awake === "agent" && working);

export function showUsage(next: Usage) {
  usage = next;
  draw();
  if (open === "usage") fill();
}

export function showAccounts(next: Accounts): boolean {
  const selected = (data: Accounts | null) => data && JSON.stringify(
    data.accounts.filter((account) => data.active[account.provider] === account.id)
      .map(({ id, revision }) => [id, revision]),
  );
  const changed = selected(accounts) !== selected(next);
  accounts = next;
  draw();
  if (open === "usage") fill();
  return changed;
}

function accountName(account: Account): string {
  return account.email || t(account.id === account.provider ? "account.terminal" : "account.new");
}

/// Installed provider CLIs on this machine.
export function showAgents(have: readonly AgentDescriptor[]) {
  agents = have.map(({ id, label }) => ({ id, label }));
  draw();
}

export function showMachine(next: Machine) {
  machine = next;
  draw();
  // Refresh an open resource panel as process readings change.
  if (open === "res") fill();
}

/// Compact quota labels fit beside usage values. Older caches used overage for the Fable quota window.
const SHORT: Record<string, string> = {
  session: "5h",
  weekly: "7d",
  fable: "Fable",
  overage: "Fable",
};

function shortKind(what: string): string {
  const duration = /^duration:(\d+)$/.exec(what);
  return duration ? span(Number(duration[1])) : (SHORT[what] ?? what);
}

function draw() {
  const bar = $("status");
  bar.innerHTML = "";
  // Keep installed providers visible before their first quota reading; a dash indicates pending data.
  for (const agent of agents) {
    const account = accounts?.accounts.find((account) => account.id === accounts?.active[agent.id]);
    const windows = (account ? usage[account.id] : accounts ? undefined : usage[agent.id])?.windows ?? [];
    bar.append(
      chip(
        "usage",
        brand(agent.id) +
          (windows.length
            ? meter(Math.max(...windows.map((w) => w.pct))) +
              `<span class="utext">${windows
                .map((w) => `${shortKind(w.kind)} ${Math.round(w.pct)}%`)
                .join(" · ")}</span>`
            : '<span class="utext dim">—</span>'),
        windows.length ? t("status.usage") : t("status.usage.none"),
        agent.id,
      ),
    );
  }
  const gap = document.createElement("span");
  gap.className = "spacer";
  bar.append(gap);
  bar.append(
    chip(
      "awake",
      icon("coffee", 13) +
        `<span class="utext">${t(`status.awake.${awake}`)}</span>` +
        `<span class="dot${holding() ? " on" : ""}"></span>`,
      t("status.awake"),
    ),
  );
  bar.append(
    chip("res", icon("memory", 13) + `<span class="utext">${bytes(machine.rss)}</span>`, t("status.res")),
  );
  bar.append(
    chip("term", icon("terminal", 13) + `<span class="utext">${machine.terms}</span>`, t("status.terms")),
  );
  bar.append(
    chip("port", icon("plug", 13) + `<span class="utext">${machine.ports.length}</span>`, t("status.ports")),
  );
}

function chip(which: Which, html: string, title: string, provider?: ProviderId): HTMLElement {
  const button = document.createElement("button");
  button.className = "uchip";
  button.title = title;
  button.innerHTML = html;
  if (provider) button.dataset.provider = provider;
  button.addEventListener("click", (e) => toggle(which, e.currentTarget as HTMLElement, e, provider));
  return button;
}

/// Quota percentages already range from 0 to 100.
function meter(pct: number, wide = false): string {
  const level = pct >= HOT ? " hot" : pct >= WARN ? " warn" : "";
  return (
    `<span class="meter${wide ? " wide" : ""}${level}">` +
    `<i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></span>`
  );
}

/// Format bytes in powers of 1024, matching Activity Monitor.
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let at = 0;
  while (value >= 1024 && at < units.length - 1) {
    value /= 1024;
    at++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[at]}`;
}

/* ---------- panels ---------- */

type Which = "usage" | "res" | "term" | "port" | "awake";

let panel: HTMLElement | null = null;
let open: Which | null = null;

export function close() {
  const focused = panel?.contains(document.activeElement);
  panel?.remove();
  panel = null;
  open = null;
  document.removeEventListener("mousedown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", close);
  if (focused && usageProvider) document.querySelector<HTMLButtonElement>(`#status [data-provider="${usageProvider}"]`)?.focus({ preventScroll: true });
}

function onDown(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".upop")) close();
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  close();
}

/// Open panels above the bottom status bar; a second click closes them. The terminal count needs no panel.
function toggle(which: Which, at: HTMLElement, e: MouseEvent, provider?: ProviderId) {
  const was = open;
  const previousProvider = usageProvider;
  close();
  if ((was === which && previousProvider === (provider ?? null)) || which === "term") return;
  usageProvider = provider ?? null;
  e.stopPropagation();
  // Reuse the existing menu for three sleep choices and their explanations.
  if (which === "awake") {
    const box = at.getBoundingClientRect();
    return menu.openAt(
      { x: box.left, y: box.top - 6, above: true },
      AWAKE.map((mode) => ({
        label: t(`status.awake.${mode}`),
        hint: t(`status.awake.${mode}.note`),
        checked: awake === mode,
        run: () => pick(mode),
      })),
      "awake",
    );
  }
  open = which;
  panel = document.createElement("div");
  panel.className = `upop ${which}`;
  panel.setAttribute("role", "dialog");
  panel.tabIndex = -1;
  panel.setAttribute("aria-label", t(which === "usage" ? "status.usage" : which === "res" ? "status.res" : "status.ports"));
  document.body.append(panel);
  fill();
  const box = at.getBoundingClientRect();
  const mine = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(box.left, innerWidth - mine.width - 8))}px`;
  panel.style.bottom = `${innerHeight - box.top + 6}px`;
  panel.style.maxHeight = `${Math.max(100, box.top - 14)}px`;
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
  panel.focus({ preventScroll: true });
}

function pick(mode: Awake) {
  awake = mode;
  try {
    localStorage.setItem(AWAKE_STORE, mode);
  } catch {
    // If persistence fails, keep the selected preference for this session.
  }
  hold();
  draw();
}

/// Render separately from toggling so an open process panel can refresh on each sample.
function fill() {
  if (!panel) return;
  const focused = panel.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusKey = focused?.dataset.focus;
  const scroll = panel.scrollTop;
  panel.innerHTML = open === "usage" ? usagePanel() : open === "res" ? resPanel() : portPanel();
  if (open === "usage") bindAccounts();
  if (focusKey) {
    const next = panel.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`);
    (next ?? panel).focus({ preventScroll: true });
  }
  panel.scrollTop = scroll;
  if (open === "res") {
    panel.querySelector("#u-clean")?.addEventListener("click", () => {
      close();
      openCleanup(say);
    });
  }
  for (const row of panel.querySelectorAll<HTMLElement>("[data-port]")) {
    row.addEventListener("click", () => {
      invoke("open_external", { url: `http://localhost:${row.dataset.port}` }).catch((err) =>
        say(fromBack(err), true),
      );
      close();
    });
  }
}

const head = (title: string, aside = "") =>
  `<div class="uhead">${title}<span class="spacer"></span><span class="uaside">${aside}</span></div>`;

function usagePanel(): string {
  return (
    agents.filter((agent) => !usageProvider || agent.id === usageProvider).map((agent) => {
      if (!accounts) return head(t("status.usage")) + card(agent, usage[agent.id]);
      const list = accounts.accounts.filter((account) => account.provider === agent.id);
      return head(brand(agent.id) + `<span class="uname">${esc(agent.label)}</span>`) +
        (!list.length ? `<div class="uempty">${t("account.empty")}</div>` : "") +
        list.map(accountCard).join("") +
        `<div class="account-add"><button data-add="${agent.id}" data-focus="add-${agent.id}" ${accounts.login || accountAction ? "disabled" : ""}>${icon("plus", 13)}${t("account.add")}</button></div>`;
    }).join("")
  );
}

function accountCard(account: Account): string {
  const active = accounts?.active[account.provider] === account.id;
  const external = account.id === account.provider;
  const loggingIn = accounts?.login?.id === account.id;
  const data = usage[account.id];
  const disabled = accountAction || loggingIn || (!account.connected && !external);
  const state = t(loggingIn ? "account.connecting" : active ? "account.active" : account.connected || external ? "account.use" : "account.disconnected");
  const details = loggingIn || (!account.connected && !external) ? state : "";
  const meta = [account.plan, data?.windows.length ? ago(data.at) : null].filter(Boolean).join(" · ");
  return `<section class="uaccount${active ? " active" : ""}" data-account="${esc(account.id)}">` +
    `<button class="account-select" data-select="${esc(account.id)}" data-focus="select-${esc(account.id)}" title="${esc(accountName(account))} · ${state}" aria-label="${esc(accountName(account))}" aria-pressed="${active}" ${disabled ? "disabled" : ""}></button>` +
    `<div class="account-content"><div class="account-heading"><strong title="${esc(accountName(account))}">${esc(accountName(account))}</strong>` +
    `<button class="account-remove ico" data-remove="${esc(account.id)}" data-focus="remove-${esc(account.id)}" title="${t("account.remove")}" aria-label="${t("account.remove")}" ${accounts?.login || accountAction ? "disabled" : ""}>${icon("trash", 13)}</button>` +
    `</div>` +
    (details ? `<small>${esc(details)}</small>` : "") +
    (loggingIn ? `<div class="account-wait" role="status">${t("account.browser")} <button data-cancel="${esc(account.id)}">${t("account.cancel")}</button></div>` : "") +
    `<div class="account-meta"><span class="uwhen" title="${esc(meta)}">${esc(meta)}</span>` +
    (!external ? `<button class="account-reconnect" data-login="${esc(account.id)}" data-focus="login-${esc(account.id)}" ${accounts?.login || accountAction ? "disabled" : ""}>${t("account.reconnect")}</button>` : "") + `</div>` +
    (data?.windows.length ? windowsPanel(data) : `<div class="uempty">${t("status.usage.none")}</div>`) +
    `</div></section>`;
}

function bindAccounts() {
  if (!panel) return;
  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-select]")) {
    button.addEventListener("click", () => void accountCall("account_select", { id: button.dataset.select! }));
  }
  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-login]")) {
    button.addEventListener("click", () => {
      const account = accounts?.accounts.find((account) => account.id === button.dataset.login);
      if (account) void accountCall("account_login", { provider: account.provider, id: account.id });
    });
  }
  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-remove]")) {
    button.addEventListener("click", () => void accountCall("account_remove", { id: button.dataset.remove! }));
  }
  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-cancel]")) {
    button.addEventListener("click", () => {
      button.disabled = true;
      void invoke("account_login_cancel", { id: button.dataset.cancel! }).catch((error) => say(fromBack(error), true));
    });
  }
  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-add]")) {
    button.addEventListener("click", () => {
      const provider = agents.find(agent => agent.id === button.dataset.add)?.id;
      if (provider) void accountCall("account_login", { provider, id: null });
    });
  }
}

async function accountCall(...call: IpcCall<"account_select" | "account_login" | "account_remove">) {
  if (accountAction) return;
  accountAction = true;
  fill();
  try {
    const next = await invoke(...call);
    showAccounts(next);
    if (call[0] === "account_remove") panel?.focus({ preventScroll: true });
    if (call[0] === "account_login") {
      say(t("account.connected"));
    }
  } catch (error) {
    say(fromBack(error), true);
  } finally {
    accountAction = false;
    if (open === "usage") fill();
  }
}

/// Show each provider's quota windows and reading time, or explain missing data.
function card(agent: Pick<AgentDescriptor, "id" | "label">, data?: Agent): string {
  const head =
    `<div class="uagent">${brand(agent.id)}<span class="uname">${agent.label}</span>` +
    `<span class="uwhen">${data ? ago(data.at) : ""}</span></div>`;
  if (!data?.windows.length) return head + `<div class="uempty">${t("status.usage.none")}</div>`;
  return head + windowsPanel(data);
}

function windowsPanel(data: Agent): string {
  return data.windows.some((window) => window.scope)
    ? groups(data.windows)
        .map(
          ([scope, windows]) =>
            `<div class="ugroup">${esc(scopeTitle(scope, windows[0]?.label))}</div>` + rows(windows),
        )
        .join("")
    : rows(data.windows);
}

function rows(windows: Window[]): string {
  return windows
    .map(
      (w) =>
        `<div class="urow"><span class="ukind">${kind(w.kind)}</span>` +
        meter(w.pct, true) +
        `<span class="upct">${Math.round(w.pct)}%</span>` +
        `<span class="ureset">${t("status.resets", { when: until(w.resets) })}</span></div>`,
    )
    .join("");
}

/// Preserve backend ordering while grouping windows by scope. Exported to test legacy snapshots without scope.
export function groups(windows: Window[]): [string, Window[]][] {
  const grouped = new Map<string, Window[]>();
  for (const window of windows) {
    const scope = window.scope ?? "general";
    grouped.set(scope, [...(grouped.get(scope) ?? []), window]);
  }
  return [...grouped];
}

function scopeTitle(scope: string, label?: string): string {
  if (scope === "general") return t("status.scope.general");
  if (scope === "code_review") return t("status.scope.codeReview");
  return label || scope;
}

function kind(what: string): string {
  if (what === "session") return t("status.window.session");
  if (what === "weekly") return t("status.window.weekly");
  if (what === "fable" || what === "overage") return t("status.window.fable");
  const duration = /^duration:(\d+)$/.exec(what);
  if (duration) return t("status.window.duration", { when: span(Number(duration[1])) });
  return what;
}

function resPanel(): string {
  const rows = machine.procs
    .map(
      (p) =>
        `<div class="prow"><span class="pname">${esc(p.name)}` +
        (p.detail ? `<em>${esc(p.kind === "term" ? dock(p.detail) : p.detail)}</em>` : "") +
        `</span>${spark(p.hist)}<span class="pcpu">${p.cpu.toFixed(1)}%</span>` +
        `<span class="prss">${bytes(p.rss)}</span></div>`,
    )
    .join("");
  return (
    head(t("status.res"), `${machine.cpu.toFixed(1)}% · ${bytes(machine.rss)}`) +
    (rows || `<div class="uempty">${t("status.res.none")}</div>`) +
    `<button class="urow act" id="u-clean">${t("status.res.clean")}${icon("chevron-right", 14)}</button>`
  );
}

/// Use the dock's own tab labels.
function dock(what: string): string {
  if (what === "setup") return t("dock.setup");
  if (what === "run") return t("dock.run");
  const n = /^term(\d+)$/.exec(what)?.[1];
  return n ? t("dock.terminalN", { n }) : t("dock.terminal");
}

function portPanel(): string {
  const rows = machine.ports
    .map(
      (p) =>
        `<div class="prow port" data-port="${p.port}"><span class="pport">${p.port}</span>` +
        `<span class="pname">${esc(p.title)}</span>${icon("external-link", 12)}</div>`,
    )
    .join("");
  return (
    head(t("status.ports")) + (rows || `<div class="uempty">${t("status.ports.none")}</div>`)
  );
}

/// Plot CPU samples oldest first and scale each line to its own maximum to show recent changes.
function spark(hist: number[]): string {
  if (hist.length < 2) return '<span class="spark"></span>';
  const top = Math.max(...hist, 1);
  const step = 100 / (hist.length - 1);
  const points = hist
    .map((v, i) => `${(i * step).toFixed(1)},${(20 - (v / top) * 18).toFixed(1)}`)
    .join(" ");
  return (
    '<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">' +
    `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.4" ` +
    'vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>'
  );
}

/// Workspace and tab names are user text; escape them before inserting markup.
function esc(text: string): string {
  const box = document.createElement("span");
  box.textContent = text;
  return box.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ---------- time ---------- */

/// Show at most two duration units, such as 3h 15m or 3d 4h.
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/// Expired reset times display now until the next provider reading arrives.
export function until(unix: number, from = Date.now() / 1000): string {
  return unix <= from ? t("status.now") : span(unix - from);
}

/// Treat readings younger than one minute as just received.
export function ago(unix: number, from = Date.now() / 1000): string {
  const seconds = from - unix;
  return seconds < 60 ? t("status.justNow") : t("status.ago", { when: span(seconds) });
}
