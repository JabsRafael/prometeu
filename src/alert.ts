import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "./icons";
import { parseConversationEvent } from "./conversation";
import { t } from "./i18n";
import * as team from "./team";
import type { Board } from "./types";
import { template } from "./util";

/// Completion sounds belong to accepted input, independently of unread indicators and navigation.

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
type Conversation = {
  workspace: string;
  phase: "idle" | "sent" | "running";
  background: boolean;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
const conversations = new Map<string, Conversation>();
// Let immediate continuations invalidate a terminal event. Silence alone never means completion.
const SETTLE_MS = 1_000;
const watching = (tab: string) => document.hasFocus() && ctx.visible(tab);
function cancel(conversation: Conversation) {
  if (conversation.timer !== null) clearTimeout(conversation.timer);
  conversation.timer = null;
}
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

/// Acknowledging unread activity never arms another completion sound.
export function looked() {
  for (const [tab, conversation] of conversations) {
    if (!watching(tab)) continue;
    conversation.pending = false;
    if (conversation.timer !== null) {
      cancel(conversation);
      conversation.phase = "idle";
    }
  }
  badge();
}

/// Snapshots only reconcile ownership and unread indicators, never execution state.
export function boardChanged(board: Board) {
  const local = board.workspaces.filter((w) => !w.archived && !w.cleaned && !w.remote);
  const owners = new Map(local.flatMap((w) => w.tabs.map((tab) => [tab.id, w.id] as const)));
  unread = new Set(local.filter((w) => w.unread).map((w) => w.id));
  for (const [tab, conversation] of conversations) {
    if (!owners.has(tab)) {
      cancel(conversation);
      conversations.delete(tab);
    }
  }
  for (const [tab, workspace] of owners) {
    const conversation = conversations.get(tab);
    if (conversation) conversation.workspace = workspace;
    else conversations.set(tab, { workspace, phase: "idle", background: false, pending: false, timer: null });
  }
  looked();
}

/// Only live input acceptance can arm a sound; provider echoes and request responses cannot.
export function chatChanged(tab: string, line: string) {
  const conversation = conversations.get(tab);
  if (!conversation) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  const event = parseConversationEvent(value);
  if (!event) return;
  switch (event.type) {
    case "session.state":
      if (event.state === "starting") {
        cancel(conversation);
        conversation.phase = "idle";
        conversation.background = false;
        conversation.pending = false;
        badge();
        return;
      }
      if (event.state !== "busy") return;
      cancel(conversation);
      conversation.phase = "sent";
      conversation.pending = false;
      badge();
      return;
    case "assistant.started":
    case "assistant.block.started":
    case "assistant.block":
    case "assistant.delta":
    case "tool.input.delta":
    case "tool.completed":
      cancel(conversation);
      if (conversation.phase === "sent") conversation.phase = "running";
      return;
    case "user.message":
      cancel(conversation);
      return;
    case "context.compaction":
      if (event.state === "started") cancel(conversation);
      return;
    case "background.changed":
      conversation.background = event.tasks.length > 0;
      if (conversation.background) cancel(conversation);
      // Finishing a background task is not the primary agent's final response.
      return;
    case "request.opened":
    case "request.closed":
      cancel(conversation);
      conversation.pending = event.type === "request.opened" && !watching(tab);
      badge();
      return;
    case "turn.completed":
      if (event.outcome === "interrupted") {
        cancel(conversation);
        conversation.phase = "idle";
        return;
      }
      if (conversation.phase === "sent" && event.outcome !== "error") {
        conversation.phase = "idle";
        return;
      }
      if (conversation.phase === "idle" || conversation.background || conversation.timer !== null) return;
      if (watching(tab)) {
        conversation.phase = "idle";
        return;
      }
      conversation.timer = setTimeout(() => {
        conversation.timer = null;
        conversation.phase = "idle";
        conversation.pending = !watching(tab);
        if (conversation.pending) pling();
        badge();
      }, SETTLE_MS);
  }
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
export function waiting() {
  const workspaces = new Set(unread);
  for (const conversation of conversations.values()) {
    if (conversation.pending) workspaces.add(conversation.workspace);
  }
  return workspaces.size + team.inboxCount();
}

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
