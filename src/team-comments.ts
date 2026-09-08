import type { Down, Inbox, Note } from "../relay/src/protocol";
import type { Context, Feature } from "./team-ports";

/// Comments feature: workspace threads, mentions and the personal inbox. Workspace IDs are relay identities;
/// the shell translates board IDs before calling in.

let ctx: Context;
let inbox: Inbox[] = [];
let comments = false;
/// Cache only workspace comments requested so far; other threads load when opened.
const notes = new Map<string, Note[]>();

export function install(context: Context): Feature {
  ctx = context;
  return { frame, reset };
}

/* Feature hooks. */

function frame(down: Down) {
  switch (down.t) {
    case "welcome": {
      inbox = down.inbox;
      comments = down.comments === 1;
      // Refresh cached comments only for currently known shares; historical cache entries must not trigger repeated missing-share requests.
      const asked = [...notes.keys()].filter(known);
      notes.clear();
      for (const ws of asked) ctx.send({ t: "notes", ws });
      break;
    }
    case "unshare":
      notes.delete(down.ws);
      inbox = inbox.filter((item) => item.ws !== down.ws);
      break;
    case "inbox":
      inbox = down.items;
      break;
    case "note": {
      const list = notes.get(down.note.ws) ?? [];
      // Insert new comments/replies and replace resolved roots by ID while preserving history order.
      const at = list.findIndex((n) => n.id === down.note.id);
      if (at === -1) list.push(down.note);
      else list[at] = down.note;
      list.sort((a, b) => a.ts - b.ts);
      notes.set(down.note.ws, list);
      break;
    }
    case "notes":
      notes.set(down.ws, down.items);
      break;
  }
}

function reset() {
  inbox = [];
  comments = false;
  notes.clear();
}

/// The encrypted channel knows every share this member owns or can read on the current connection.
const known = (ws: string) => !!ctx.channel()?.shares.has(ws);

/* Threads. */

/// Return cached workspace comments and request missing data; onChange delivers later results.
export function notesOf(ws: string): Note[] {
  const have = notes.get(ws);
  if (have) return have;
  // Mark the cache before sending so a response cannot be overwritten by request initialization.
  notes.set(ws, []);
  if (!ctx.send({ t: "notes", ws })) notes.delete(ws);
  return [];
}

/// Send comments with optional quotes and member mentions. Resolve whether sending succeeded so offline input is not cleared.
export const addNote = (ws: string, tab: string | null, anchor: string | null, text: string, mentions: string[], quote: string | null) =>
  ctx.sendConfirmed({ t: "note", ws, tab, anchor, text, mentions, quote });

export const replyNote = (ws: string, note: string, text: string, mentions: string[]) =>
  ctx.sendConfirmed({ t: "note_reply", ws, note, text, mentions });

export const resolveNote = (ws: string, note: string) => ctx.sendConfirmed({ t: "note_resolve", ws, note });

export const supportsThreads = () => comments;

/* Inbox. */

export const inboxItems = () => inbox;

/// Count unresolved comments addressed to the current user.
export const inboxCount = () => inbox.length;

/// Opening does not resolve current relay threads; retain the legacy read fallback for older relays.
export function readInbox(id: string): { ws: string; note: string; tab: string | null } | null {
  const item = inbox.find((i) => i.id === id);
  if (!item) return null;
  // Only legacy relays without resolution treat opening as completion.
  if (!comments) {
    ctx.send({ t: "inbox_read", id });
    inbox = inbox.filter((entry) => entry.id !== id);
    ctx.changed();
  }
  return { ws: item.ws, note: item.id, tab: item.tab ?? null };
}

/// Inbox presentation combines comment, author, and workspace context.
export function inboxList(): { id: string; ws: string; author: string; ts: number; title: string; text: string }[] {
  return inbox.map((i) => {
    const note = notes.get(i.ws)?.find((n) => n.id === i.id);
    const share = ctx.shares().get(i.ws);
    return {
      id: i.id,
      ws: i.ws,
      author: ctx.nameOf(i.author),
      ts: i.ts,
      title: share?.title ?? "",
      text: i.text ?? note?.text ?? "",
    };
  });
}
