import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "./icons";
import { parseConversationEvent } from "./conversation";
import { t } from "./i18n";
import * as team from "./team";
import type { Board } from "./types";
import { template } from "./util";

/// Notify unseen agent stops and comment mentions with a short sound and a Dock count. Sound is a local preference; the badge remains until nothing is pending. Only live conversation events ring once per unresolved stop; snapshots and automatic activity never rearm it.

const SOUND_KEY = "prometeu:som";

/// Enabled by default; the user can turn it off.
export const soundOn = () => localStorage.getItem(SOUND_KEY) !== "0";
export function setSound(on: boolean) {
  on ? localStorage.removeItem(SOUND_KEY) : localStorage.setItem(SOUND_KEY, "0");
}

/* State. */

type Ctx = {
  /// Visible tabs in the workspace or desk; window focus is checked here.
  visible: (tab: string) => boolean;
};

let ctx: Ctx = { visible: () => false };
let owners = new Map<string, string>();
/// Associate unseen stops with workspaces for the Dock count.
const pending = new Map<string, string>();
let unread = new Set<string>();
/// Remember comments across reconnects so older mentions do not ring twice.
const known = new Set<string>();

export function init(context: Ctx) {
  ctx = context;
  // WebKit requires user interaction before audio can play; create the context on the first click or key.
  const wake = () => {
    audio();
    window.removeEventListener("pointerdown", wake);
    window.removeEventListener("keydown", wake);
  };
  window.addEventListener("pointerdown", wake);
  window.addEventListener("keydown", wake);
  // Returning to the window acknowledges visible activity.
  window.addEventListener("focus", looked);
}

/// Opening a conversation or focusing the window acknowledges visible pending stops.
export function looked() {
  if (!pending.size || !document.hasFocus()) return;
  for (const tab of pending.keys()) if (ctx.visible(tab)) pending.delete(tab);
  badge();
}

/// Board snapshots supply ownership and unread state. Concurrent or stale status changes do not create notifications.
export function boardChanged(board: Board) {
  const local = board.workspaces.filter((w) => !w.archived && !w.cleaned && !w.remote);
  owners = new Map(local.flatMap((w) => w.tabs.map((tab) => [tab.id, w.id] as const)));
  unread = new Set(local.filter((w) => w.unread).map((w) => w.id));
  for (const tab of pending.keys()) if (!owners.has(tab)) pending.delete(tab);
  if (document.hasFocus()) {
    for (const tab of pending.keys()) if (ctx.visible(tab)) pending.delete(tab);
  }
  badge();
}

/// Only local live events notify; snapshots and replay do not.
export function chatChanged(tab: string, line: string) {
  const workspace = owners.get(tab);
  if (!workspace) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  const event = parseConversationEvent(value);
  if (!event) return;
  if (event.type === "user.message" || event.type === "request.closed") {
    pending.delete(tab);
    badge();
    return;
  }
  if (event.type !== "turn.completed" && event.type !== "request.opened") return;
  if (event.type === "turn.completed" && event.outcome === "interrupted") return;
  if (document.hasFocus() && ctx.visible(tab)) return;
  if (pending.has(tab)) return;
  pending.set(tab, workspace);
  pling();
  badge();
}

/// Team updates may change the mention inbox.
export function teamChanged() {
  let news = false;
  for (const item of team.inboxItems()) {
    if (known.has(item.id)) continue;
    known.add(item.id);
    news = true;
  }
  if (news) pling();
  badge();
}

/* Dock badge. */

/// Count unread workspaces plus inbox comments; zero clears the badge.
export const waiting = () => new Set([...unread, ...pending.values()]).size + team.inboxCount();

function badge() {
  getCurrentWindow()
    .setBadgeCount(waiting() || undefined)
    .catch((e) => {
      // The web mock has no Dock badge.
      console.warn("badge", e);
    });
}

/* Sound. */

let actx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  actx ??= new AudioContext();
  if (actx.state === "suspended") void actx.resume();
  return actx;
}

/// Synthesize a short bell with a fundamental and a higher partial; no audio asset is needed.
export function pling() {
  if (!soundOn()) return;
  const ac = audio();
  if (!ac) return;
  const at = ac.currentTime;
  const out = ac.createGain();
  out.gain.value = 0.5;
  out.connect(ac.destination);
  for (const [freq, gain, decay] of [
    [1046.5, 0.5, 0.55],
    [2637, 0.14, 0.25],
  ]) {
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + decay + 0.05);
  }
}

/* Settings row. */

export function settingsRow(): HTMLElement {
  const row = template(
    "div",
    "setrow",
    `<span class="glyph">${icon("bell", 18)}</span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".txt b")!.textContent = t("settings.sound");
  row.querySelector(".txt span")!.textContent = t("settings.sound.body");
  const sw = template("button", "ghost sw", `<span></span><i class="knob"></i>`) as HTMLButtonElement;
  sw.setAttribute("role", "switch");
  const paint = () => {
    const on = soundOn();
    sw.classList.toggle("on", on);
    sw.setAttribute("aria-checked", String(on));
    sw.children[0].textContent = t(on ? "settings.sound.on" : "settings.sound.off");
  };
  sw.addEventListener("click", () => {
    setSound(!soundOn());
    paint();
    // Enabling sound plays a preview.
    pling();
  });
  paint();
  row.querySelector(".act")!.append(sw);
  return row;
}
