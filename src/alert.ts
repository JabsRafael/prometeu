import { getCurrentWindow } from "@tauri-apps/api/window";
import { parseConversationEvent } from "./conversation";
import * as team from "./team";
import type { Board } from "./types";

/// Track unread activity for the Dock badge.

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

export function init(context: Ctx) {
  ctx = context;
  // Returning to the window acknowledges visible activity.
  window.addEventListener("focus", looked);
}

/// Acknowledge visible activity without creating another pending completion.
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

/// Track accepted live input for the Dock; provider echoes and request responses cannot start another execution.
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
        badge();
      }, SETTLE_MS);
  }
}

/// Team updates may change the mention inbox.
export function teamChanged() {
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
