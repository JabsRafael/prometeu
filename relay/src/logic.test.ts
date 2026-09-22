import { describe, expect, it } from "vitest";
import { empty, hydrate, reduce, type Effect, type Event, type State } from "./logic";
import {
  encodeLive,
  encodeSnapshot,
  NOTES_PER_WORKSPACE_MAX,
  NOTES_TOTAL_MAX,
  NOTE_TTL_MS,
  SHARES_MAX,
  type Down,
  type Note,
  type Share,
  type Up,
} from "./protocol";

const NOW = 1_700_000_000_000;

const open = (sock: string, member: string, name = member): Event => ({ k: "open", sock, member, name, now: NOW });
const close = (sock: string): Event => ({ k: "close", sock, now: NOW + 1 });
const text = (sock: string, frame: Up, rand = "r"): Event => ({ k: "text", sock, frame, now: NOW + 2, rand });
const binary = (sock: string, data: Uint8Array): Event => ({ k: "binary", sock, data });

const share = (id = "ws1", tabs = ["t1", "t2"], audience: string[] | null = null): Share => ({
  id,
  title: "Ícone do app",
  repo_name: "prometeu",
  branch: "prometeu/1606",
  stage: "Fazendo",
  issue: null,
  active: tabs[0] ?? null,
  tabs: tabs.map((t) => ({ id: t, title: t, status: "rodando", note: null, tokens: null })),
  sizes: {},
  audience,
});

const sent = (fx: Effect[], sock: string) =>
  fx.filter((f): f is Extract<Effect, { e: "send" }> => f.e === "send" && f.sock === sock).map((f) => f.frame);
const kinds = (fx: Effect[], sock: string) => sent(fx, sock).map((f) => f.t);
const one = <T extends Down["t"]>(fx: Effect[], sock: string, t: T) =>
  sent(fx, sock).find((f): f is Extract<Down, { t: T }> => f.t === t);
const puts = (fx: Effect[]) => fx.filter((f) => f.e === "put").map((f) => (f as Extract<Effect, { e: "put" }>).key);
const dels = (fx: Effect[]) => fx.filter((f) => f.e === "del").map((f) => (f as Extract<Effect, { e: "del" }>).key);

/// Alice and Bob are connected; Alice shares `ws1`.
function team(): State {
  const s = empty();
  reduce(s, open("a1", "alice"));
  reduce(s, open("b1", "bob"));
  reduce(s, text("a1", { t: "share", share: share() }));
  return s;
}

describe("presence", () => {
  it("welcomes the joining member and sends presence to the others", () => {
    const s = empty();
    const first = reduce(s, open("a1", "alice"));
    expect(kinds(first, "a1")).toEqual(["welcome"]);
    expect(one(first, "a1", "welcome")!.comments).toBe(1);
    expect(one(first, "a1", "welcome")!.members).toEqual([{ id: "alice", name: "alice", online: true }]);
    expect(puts(first)).toEqual(["member:alice"]);

    const second = reduce(s, open("b1", "bob", "Bob"));
    expect(kinds(second, "a1")).toEqual(["presence"]);
    expect(one(second, "b1", "welcome")!.members.map((m) => m.name)).toEqual(["alice", "Bob"]);
  });

  it("preserves the member's name when connecting with an empty name", () => {
    const s = empty();
    reduce(s, open("a1", "alice", "Alice"));
    reduce(s, close("a1"));
    const fx = reduce(s, open("a2", "alice", ""));
    expect(one(fx, "a2", "welcome")!.members[0].name).toBe("Alice");
  });

  it("marks members offline after their last socket closes without removing them", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    const fx = reduce(s, close("b1"));
    expect(one(fx, "a1", "presence")!.members).toEqual([
      { id: "alice", name: "alice", online: true },
      { id: "bob", name: "bob", online: false },
    ]);
  });

  it("updates the name through me and notifies everyone", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    const fx = reduce(s, text("b1", { t: "me", name: "Roberto" }));
    expect(one(fx, "a1", "presence")!.members[1].name).toBe("Roberto");
    expect(puts(fx)).toEqual(["member:bob"]);
  });
});

describe("sharing and watching", () => {
  it("broadcasts share ownership and online state, then tells the owner who attached", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    const fx = reduce(s, text("a1", { t: "share", share: share() }));
    const got = one(fx, "b1", "share")!;
    expect(got.share.owner).toBe("alice");
    expect(got.share.online).toBe(true);
    expect(puts(fx)).toEqual(["share:ws1"]);

    const at = reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    expect(at).toContainEqual({ e: "attachment", sock: "b1", member: "bob", attached: { ws: "ws1", tab: "t1" } });
    expect(one(at, "a1", "watch")).toEqual({ t: "watch", ws: "ws1", tab: "t1", members: ["bob"], added: ["bob"] });
  });

  it("sends live bytes only to tab watchers and never back to the owner", () => {
    const s = team();
    reduce(s, open("c1", "carol"));
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    reduce(s, text("c1", { t: "attach", ws: "ws1", tab: "t2" }));
    const data = encodeLive("t1", [{ seq: 1, bytes: new Uint8Array([1, 2, 3]) }]);
    const fx = reduce(s, binary("a1", data));
    expect(fx).toEqual([{ e: "sendBinary", sock: "b1", data }]);
  });

  it("sends snapshots only to the addressed recipient", () => {
    const s = team();
    reduce(s, open("c1", "carol"));
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    reduce(s, text("c1", { t: "attach", ws: "ws1", tab: "t1" }));
    const data = encodeSnapshot("t1", "carol", 7, new Uint8Array([9]));
    expect(reduce(s, binary("a1", data))).toEqual([{ e: "sendBinary", sock: "c1", data }]);
  });

  it("rejects transmissions from non-owners", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    expect(reduce(s, binary("b1", encodeLive("t1", [{ seq: 1, bytes: new Uint8Array([1]) }])))).toEqual([]);
  });

  it("detaches the previous tab when switching and notifies both owners", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const fx = reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t2" }));
    expect(sent(fx, "a1")).toEqual([
      { t: "watch", ws: "ws1", tab: "t1", members: [], added: [] },
      { t: "watch", ws: "ws1", tab: "t2", members: ["bob"], added: ["bob"] },
    ]);
    const off = reduce(s, text("b1", { t: "detach" }));
    expect(one(off, "a1", "watch")).toEqual({ t: "watch", ws: "ws1", tab: "t2", members: [], added: [] });
  });

  it("detaches watchers when a refreshed share removes their tab", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t2" }));
    const fx = reduce(s, text("a1", { t: "share", share: share("ws1", ["t1"]) }));
    expect(fx).toContainEqual({ e: "attachment", sock: "b1", member: "bob", attached: null });
    expect(one(fx, "a1", "watch")).toMatchObject({ ws: "ws1", tab: "t2", members: [] });
  });

  it("rejects attachment to missing workspaces or tabs", () => {
    const s = team();
    expect(one(reduce(s, text("b1", { t: "attach", ws: "missing", tab: "t1" })), "b1", "error")!.code).toBe("noShare");
    expect(one(reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t9" })), "b1", "error")!.code).toBe("noTab");
  });

  it("forwards writes with sender identity and rejects offline owners", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const fx = reduce(s, text("b1", { t: "write", ws: "ws1", tab: "t1", data: "ls\r" }));
    expect(sent(fx, "a1")).toEqual([{ t: "write", ws: "ws1", tab: "t1", data: "ls\r", from: "bob" }]);
    reduce(s, close("a1"));
    const off = reduce(s, text("b1", { t: "write", ws: "ws1", tab: "t1", data: "x" }));
    expect(one(off, "b1", "error")!.code).toBe("offline");
  });

  it("requires the writing socket to watch the exact target tab", () => {
    const s = team();
    expect(one(reduce(s, text("b1", { t: "write", ws: "ws1", tab: "t1", data: "hidden" })), "b1", "error")!.code).toBe("notAttached");
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t2" }));
    expect(one(reduce(s, text("b1", { t: "write", ws: "ws1", tab: "t1", data: "wrong tab" })), "b1", "error")!.code).toBe("notAttached");
    expect(one(reduce(s, text("b1", { t: "write", ws: "ws1", tab: "missing", data: "x" })), "b1", "error")!.code).toBe("noTab");
  });

  it("forwards owner dimensions to watchers and retains them in the share", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const fx = reduce(s, text("a1", { t: "size", ws: "ws1", tab: "t1", cols: 120, rows: 40 }));
    expect(sent(fx, "b1")).toEqual([{ t: "size", ws: "ws1", tab: "t1", cols: 120, rows: 40 }]);
    expect(s.shares.get("ws1")!.share.sizes.t1).toEqual([120, 40]);
  });

  it("marks shares offline on disconnect, then online on reannouncement and restores the watcher list", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const gone = reduce(s, close("a1"));
    const got = one(gone, "b1", "share")!;
    expect(got.share.online).toBe(false);
    expect(puts(gone)).toContain("share:ws1");

    // Reconnecting immediately restores the share and notifies viewers, without waiting for the owner to
    // advertise it again.
    const back = reduce(s, open("a2", "alice"));
    const welcome = one(back, "a2", "welcome")!;
    expect(welcome.shares[0].online).toBe(true);
    expect(welcome.watching).toEqual({ ws1: { t1: ["bob"] } });
    expect(one(back, "b1", "share")!.share.online).toBe(true);
    expect(puts(back)).toContain("share:ws1");
    // Readvertising the same share must not duplicate the notification.
    const again = reduce(s, text("a2", { t: "share", share: share() }));
    expect(one(again, "b1", "share")!.share.online).toBe(true);
  });

  it("detaches watchers and removes unshared workspaces", () => {
    const s = team();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const fx = reduce(s, text("a1", { t: "unshare", ws: "ws1" }));
    expect(dels(fx)).toEqual(["share:ws1"]);
    expect(fx).toContainEqual({ e: "attachment", sock: "b1", member: "bob", attached: null });
    expect(kinds(fx, "b1")).toEqual(["unshare"]);
    expect(s.shares.size).toBe(0);
  });

  it("allows only owners to modify their shares", () => {
    const s = team();
    expect(one(reduce(s, text("b1", { t: "share", share: share() })), "b1", "error")!.code).toBe("owner");
    expect(one(reduce(s, text("b1", { t: "unshare", ws: "ws1" })), "b1", "error")!.code).toBe("owner");
  });

  it("requires unique team tab IDs to avoid ambiguous binary frames", () => {
    const s = team();
    const fx = reduce(s, text("b1", { t: "share", share: share("ws2", ["t1"]) }));
    expect(one(fx, "b1", "error")!.code).toBe("tabConflict");
    expect(s.shares.has("ws2")).toBe(false);
  });
});

describe("audience", () => {
  /// Alice, Bob and Carol are connected; Alice shares `ws1` only with Bob.
  function trio(): State {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    reduce(s, open("c1", "carol"));
    reduce(s, text("a1", { t: "share", share: share("ws1", ["t1", "t2"], ["bob"]) }));
    return s;
  }

  it("delivers shares only to audience members and hides workspaces from others", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("b1", "bob"));
    reduce(s, open("c1", "carol"));
    const fx = reduce(s, text("a1", { t: "share", share: share("ws1", ["t1"], ["bob"]) }));
    expect(kinds(fx, "a1")).toEqual(["share"]);
    expect(kinds(fx, "b1")).toEqual(["share"]);
    expect(kinds(fx, "c1")).toEqual([]);
    expect(one(reduce(s, text("c1", { t: "attach", ws: "ws1", tab: "t1" })), "c1", "error")!.code).toBe("noShare");
    expect(one(reduce(s, text("c1", { t: "write", ws: "ws1", tab: "t1", data: "x" })), "c1", "error")!.code).toBe("noShare");
    expect(one(reduce(s, text("c1", { t: "notes", ws: "ws1" })), "c1", "error")!.code).toBe("noShare");
    expect(kinds(reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" })), "b1")).toEqual([]);
  });

  it("includes only visible shares in welcome and always includes owned shares", () => {
    const s = trio();
    reduce(s, close("c1"));
    expect(one(reduce(s, open("c2", "carol")), "c2", "welcome")!.shares).toEqual([]);
    reduce(s, close("a1"));
    expect(one(reduce(s, open("a2", "alice")), "a2", "welcome")!.shares.map((x) => x.id)).toEqual(["ws1"]);
  });

  it("notifies only the audience when the owner disconnects and reconnects", () => {
    const s = trio();
    const down = reduce(s, close("a1"));
    expect(kinds(down, "b1")).toEqual(["share", "presence"]);
    expect(kinds(down, "c1")).toEqual(["presence"]);
    const up = reduce(s, open("a2", "alice"));
    expect(kinds(up, "b1")).toEqual(["share", "presence"]);
    expect(kinds(up, "c1")).toEqual(["presence"]);
  });

  it("unshares and detaches removed audience members and shares with added members", () => {
    const s = trio();
    reduce(s, text("b1", { t: "attach", ws: "ws1", tab: "t1" }));
    const fx = reduce(s, text("a1", { t: "share", share: share("ws1", ["t1", "t2"], ["carol"]) }));
    expect(kinds(fx, "b1")).toEqual(["unshare"]);
    expect(fx).toContainEqual({ e: "attachment", sock: "b1", member: "bob", attached: null });
    expect(kinds(fx, "c1")).toEqual(["share"]);
    expect(one(fx, "a1", "watch")).toEqual({ t: "watch", ws: "ws1", tab: "t1", members: [], added: [] });
    expect(s.socks.get("b1")!.attached).toBeNull();
  });

  it("shares with everyone when opening to the team and unshares only from previous viewers", () => {
    const s = trio();
    const all = reduce(s, text("a1", { t: "share", share: share("ws1", ["t1"], null) }));
    expect(kinds(all, "c1")).toEqual(["share"]);
    reduce(s, text("a1", { t: "share", share: share("ws1", ["t1"], ["bob"]) }));
    const off = reduce(s, text("a1", { t: "unshare", ws: "ws1" }));
    expect(kinds(off, "b1")).toEqual(["unshare"]);
    expect(kinds(off, "c1")).toEqual([]);
  });

  it("keeps notes within the audience and discards mentions of outsiders", () => {
    const s = trio();
    const fx = reduce(s, text("b1", { t: "note", ws: "ws1", text: "@carol @alice", mentions: ["carol", "alice"], quote: null }));
    expect(kinds(fx, "a1")).toEqual(["note", "inbox"]);
    expect(kinds(fx, "b1")).toEqual(["note"]);
    expect(kinds(fx, "c1")).toEqual([]);
    expect(one(fx, "a1", "note")!.note.mentions).toEqual(["alice"]);
    expect(one(reduce(s, text("c1", { t: "note", ws: "ws1", text: "hello", mentions: [], quote: null })), "c1", "error")!.code).toBe("noShare");
  });

  it("preserves team-wide sharing for legacy clients without an audience field", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    reduce(s, open("c1", "carol"));
    const { audience: _, ...old } = share("ws1", ["t1"]);
    const fx = reduce(s, text("a1", { t: "share", share: old as Share }));
    expect(one(fx, "c1", "share")!.share.audience).toBeNull();
  });
});

describe("notes", () => {
  it("broadcasts notes and creates inbox items for mentioned members", () => {
    const s = team();
    const fx = reduce(s, text("b1", { t: "note", ws: "ws1", text: "@alice is this correct?", mentions: ["alice", "bob", "zé"], quote: "  ✓ 3 tests" }, "abc"));
    const note = one(fx, "a1", "note")!.note;
    expect(note).toMatchObject({ id: `${NOW + 2}-abc`, ws: "ws1", author: "bob", mentions: ["alice"], quote: "  ✓ 3 tests" });
    expect(one(fx, "b1", "note")!.note).toEqual(note);
    expect(one(fx, "a1", "inbox")!.items).toEqual([{
      id: note.id,
      ws: "ws1",
      author: "bob",
      ts: NOW + 2,
      tab: null,
      text: "@alice is this correct?",
    }]);
    expect(one(fx, "b1", "inbox")).toBeUndefined();
    expect(puts(fx)).toEqual([`note:ws1:${note.id}`, `inbox:alice:${note.id}`]);

    const read = reduce(s, text("a1", { t: "inbox_read", id: note.id }));
    expect(dels(read)).toEqual([`inbox:alice:${note.id}`]);
    expect(one(read, "a1", "inbox")!.items).toEqual([]);
  });

  it("rejects empty or oversized notes", () => {
    const s = team();
    expect(one(reduce(s, text("b1", { t: "note", ws: "ws1", text: "   ", mentions: [], quote: null })), "b1", "error")!.code).toBe("empty");
    expect(one(reduce(s, text("b1", { t: "note", ws: "ws1", text: "x".repeat(9000), mentions: [], quote: null })), "b1", "error")!.code).toBe("tooBig");
  });

  it("returns workspace notes and delivers inbox items when offline members join", () => {
    const s = team();
    reduce(s, open("c1", "carol"));
    reduce(s, close("c1"));
    reduce(s, text("b1", { t: "note", ws: "ws1", text: "@carol olha isso", mentions: ["carol"], quote: null }, "n1"));
    reduce(s, text("a1", { t: "note", ws: "ws1", text: "vi", mentions: [], quote: null }, "n2"));
    const list = one(reduce(s, text("b1", { t: "notes", ws: "ws1" })), "b1", "notes")!;
    expect(list.items.map((n) => n.text)).toEqual(["@carol olha isso", "vi"]);
    const back = reduce(s, open("c2", "carol"));
    expect(one(back, "c2", "welcome")!.inbox.map((i) => i.id)).toEqual([`${NOW + 2}-n1`]);
  });

  it("keeps replies in their thread; opening does not resolve it and resolution clears all inboxes", () => {
    const s = team();
    reduce(s, open("c1", "carol"));
    const created = reduce(s, text("b1", {
      t: "note",
      ws: "ws1",
      tab: "t1",
      anchor: "s4.0",
      text: "@alice revisa?",
      mentions: ["alice"],
      quote: "resultado",
    }, "root"));
    const root = one(created, "a1", "note")!.note;

    const replied = reduce(s, text("a1", {
      t: "note_reply",
      ws: "ws1",
      note: root.id,
      text: "@carol please check too",
      mentions: ["carol"],
    }, "reply"));
    expect(one(replied, "b1", "note")!.note).toMatchObject({ parent: root.id, tab: "t1", anchor: null });
    expect(s.inbox.get("alice")?.map((item) => item.id)).toEqual([root.id]);
    expect(s.inbox.get("bob")?.map((item) => item.id)).toEqual([root.id]);
    expect(s.inbox.get("carol")?.map((item) => item.id)).toEqual([root.id]);

    // Opening a thread does not change the inbox.
    reduce(s, text("a1", { t: "notes", ws: "ws1" }));
    expect(s.inbox.get("alice")?.map((item) => item.id)).toEqual([root.id]);

    const resolved = reduce(s, text("c1", { t: "note_resolve", ws: "ws1", note: root.id }));
    expect(one(resolved, "a1", "note")!.note.resolved).toBe(true);
    expect(s.inbox.size).toBe(0);
    expect(dels(resolved)).toEqual(expect.arrayContaining([
      `inbox:alice:${root.id}`,
      `inbox:bob:${root.id}`,
      `inbox:carol:${root.id}`,
    ]));
  });

  it("rejects replies to resolved comments and anchors to missing tabs", () => {
    const s = team();
    expect(one(reduce(s, text("b1", { t: "note", ws: "ws1", tab: "missing", anchor: "s1.0", text: "hello", mentions: [], quote: null })), "b1", "error")!.code).toBe("noTab");
    const created = reduce(s, text("b1", { t: "note", ws: "ws1", tab: "t1", anchor: null, text: "hello", mentions: [], quote: null }, "root"));
    const root = one(created, "b1", "note")!.note;
    reduce(s, text("a1", { t: "note_resolve", ws: "ws1", note: root.id }));
    expect(one(reduce(s, text("b1", { t: "note_reply", ws: "ws1", note: root.id, text: "late", mentions: [] })), "b1", "error")!.code).toBe("resolved");
  });

  it("rejects notes for unknown workspaces and bounds history", () => {
    const s = team();
    expect(one(reduce(s, text("b1", { t: "note", ws: "fake", text: "hello", mentions: [], quote: null })), "b1", "error")!.code).toBe("noShare");
    for (let i = 0; i < NOTES_PER_WORKSPACE_MAX; i++) {
      reduce(s, text("b1", { t: "note", ws: "ws1", text: `note ${i}`, mentions: [], quote: null }, `n${i}`));
    }
    const fx = reduce(s, text("b1", { t: "note", ws: "ws1", text: "mais nova", mentions: [], quote: null }, "last"));
    expect(s.notes.get("ws1")).toHaveLength(NOTES_PER_WORKSPACE_MAX);
    expect(dels(fx)).toContain(`note:ws1:${NOW + 2}-n0`);
  });

  it("evicts entire threads at the global limit while preserving roots with recent replies", () => {
    const s = empty();
    const note = (ws: string, id: string, ts: number, parent: string | null = null): Note => ({
      id,
      ws,
      author: "alice",
      text: id,
      mentions: [],
      quote: null,
      ts,
      tab: null,
      anchor: null,
      parent,
      resolved: false,
    });
    for (let i = 0; i < NOTES_TOTAL_MAX; i++) {
      const ws = `ws${Math.floor(i / NOTES_PER_WORKSPACE_MAX)}`;
      const list = s.notes.get(ws) ?? [];
      list.push(note(ws, `n${i}`, NOW - 10_000 + i));
      s.notes.set(ws, list);
    }
    s.notes.set("hot", [note("hot", "root", NOW - 20_000), note("hot", "reply", NOW + 1, "root")]);

    const fx = reduce(s, open("a1", "alice"));
    expect(s.notes.get("hot")?.map((item) => item.id)).toEqual(["root", "reply"]);
    expect([...s.notes.values()].flat()).toHaveLength(NOTES_TOTAL_MAX);
    expect(dels(fx)).not.toContain("note:hot:root");
  });

  it("removes notes and private inboxes on unshare and expires stored entries by TTL", () => {
    const s = team();
    reduce(s, text("b1", { t: "note", ws: "ws1", text: "@alice hello", mentions: ["alice"], quote: null }, "old"));
    const expired = reduce(s, { k: "open", sock: "c1", member: "carol", name: "Carol", now: NOW + NOTE_TTL_MS + 10 });
    expect(dels(expired)).toContain(`note:ws1:${NOW + 2}-old`);
    expect(dels(expired)).toContain(`inbox:alice:${NOW + 2}-old`);

    reduce(s, text("b1", { t: "note", ws: "ws1", text: "@alice nova", mentions: ["alice"], quote: null }, "new"));
    const gone = reduce(s, text("a1", { t: "unshare", ws: "ws1" }));
    expect(s.notes.has("ws1")).toBe(false);
    expect(s.inbox.get("alice")).toBeUndefined();
    expect(dels(gone)).toContain(`note:ws1:${NOW + 2}-new`);
  });
});

describe("quotas", () => {
  it("limits the team's share count", () => {
    const s = empty();
    reduce(s, open("a1", "alice"));
    for (let i = 0; i < SHARES_MAX; i++) reduce(s, text("a1", { t: "share", share: share(`ws${i}`, [`tab${i}`]) }));
    const fx = reduce(s, text("a1", { t: "share", share: share("overflow", ["lasttab"]) }));
    expect(one(fx, "a1", "error")!.code).toBe("quota");
    expect(s.shares.size).toBe(SHARES_MAX);
  });
});

describe("returning owners", () => {
  it("restores only the returning owner's shares and leaves other owners unchanged", () => {
    const s = team();
    reduce(s, text("b1", { t: "share", share: share("ws2", ["u1"]) }));
    reduce(s, close("a1"));
    reduce(s, close("b1"));
    const back = reduce(s, open("a2", "alice"));
    const welcome = one(back, "a2", "welcome")!;
    expect(welcome.shares.map((x) => [x.id, x.online])).toEqual([
      ["ws1", true],
      ["ws2", false],
    ]);
  });
});

describe("storage recovery", () => {
  it("restores members, shares, notes and inboxes while marking disconnected owners' shares offline", () => {
    const s = team();
    reduce(s, text("b1", { t: "note", ws: "ws1", text: "@alice hello", mentions: ["alice"], quote: null }, "n1"));
    const rows: [string, unknown][] = [];
    // Reconstruct stored values from persistence effects.
    rows.push(["member:alice", { id: "alice", name: "alice", last_seen: NOW }]);
    rows.push(["member:bob", { id: "bob", name: "bob", last_seen: NOW }]);
    rows.push(["share:ws1", s.shares.get("ws1")]);
    rows.push([`note:ws1:${NOW + 2}-n1`, s.notes.get("ws1")![0]]);
    rows.push([`inbox:alice:${NOW + 2}-n1`, s.inbox.get("alice")![0]]);

    const woke = hydrate(rows, [{ id: "b9", member: "bob", attached: { ws: "ws1", tab: "t1" } }]);
    expect(woke.shares.get("ws1")!.online).toBe(false);
    expect(woke.notes.get("ws1")!.length).toBe(1);
    expect(woke.notes.get("ws1")![0]).toMatchObject({ parent: null, resolved: false });
    expect(woke.inbox.get("alice")!.length).toBe(1);
    const fx = reduce(woke, open("a9", "alice"));
    const welcome = one(fx, "a9", "welcome")!;
    expect(welcome.members.map((m) => [m.id, m.online])).toEqual([["alice", true], ["bob", true]]);
    expect(welcome.watching).toEqual({ ws1: { t1: ["bob"] } });
    expect(welcome.inbox.length).toBe(1);
  });

  it("ignores corrupt rows instead of trusting storage casts", () => {
    const woke = hydrate(
      [
        ["member:__proto__", { name: "intruder", last_seen: NOW }],
        ["member:alice", { name: "x".repeat(500), last_seen: NOW }],
        ["share:ws1", { owner: "alice", share: { id: "ws1", tabs: "invalid" } }],
        ["note:ws1:n1", { id: "n1", ws: "ws1", author: "alice", text: 42, mentions: [], quote: null, ts: NOW }],
      ],
      [{ id: "sock", member: "bob", attached: { ws: "__proto__", tab: "t1" } }],
    );
    expect(woke.members.size).toBe(0);
    expect(woke.shares.size).toBe(0);
    expect(woke.notes.size).toBe(0);
    expect(woke.socks.get("sock")?.attached).toBeNull();
  });

  it("does not restore attachments outside the audience or to missing tabs", () => {
    const restricted = share("ws1", ["t1"], ["carol"]);
    const rows: [string, unknown][] = [
      ["share:ws1", { share: restricted, owner: "alice", online: false }],
    ];

    const woke = hydrate(rows, [
      { id: "bob-sock", member: "bob", attached: { ws: "ws1", tab: "t1" } },
      { id: "carol-sock", member: "carol", attached: { ws: "ws1", tab: "deleted" } },
      { id: "alice-sock", member: "alice", attached: { ws: "ws1", tab: "t1" } },
    ]);

    expect(woke.socks.get("bob-sock")?.attached).toBeNull();
    expect(woke.socks.get("carol-sock")?.attached).toBeNull();
    expect(woke.socks.get("alice-sock")?.attached).toEqual({ ws: "ws1", tab: "t1" });
  });
});


describe("persisted ciphertext limits", () => {
  const envelope = (id: string, length = 1024) => ({ id, boxes: {
    alice: { enc: "A".repeat(87), ct: "B".repeat(length) },
    bob: { enc: "A".repeat(87), ct: "B".repeat(length) },
  } });
  it("does not overwrite comment IDs and stores only recipient envelopes in each inbox", () => {
    const s = team();
    const frame: Up = { t: "note", ws: "ws1", text: "", quote: null, mentions: ["bob"], encrypted: envelope("same-id") };
    const created = reduce(s, text("a1", frame));
    expect(puts(created)).toContain("note:ws1:same-id");
    expect(Object.keys(s.inbox.get("bob")![0].encrypted!.boxes)).toEqual(["bob"]);
    expect(one(reduce(s, text("b1", frame)), "b1", "error")?.code).toBe("bad");
    expect(s.notes.get("ws1")).toHaveLength(1);
    expect(s.notes.get("ws1")![0].author).toBe("alice");
  });
  it("bounds share and comment expansion before modifying storage", () => {
    const s = team();
    const tooBig: Up = { t: "note", ws: "ws1", text: "", quote: null, mentions: [], encrypted: envelope("huge", 800_000) };
    const refused = reduce(s, text("a1", tooBig));
    expect(one(refused, "a1", "error")?.code).toBe("tooBig");
    expect(puts(refused)).toEqual([]);
    for (let i = 0; i < 8; i++) {
      const accepted = reduce(s, text("a1", { ...tooBig, encrypted: envelope(`note-${i}`, 500_000) }));
      expect(one(accepted, "a1", "error")).toBeUndefined();
    }
    expect(one(reduce(s, text("a1", { ...tooBig, encrypted: envelope("over-quota", 500_000) })), "a1", "error")?.code).toBe("quota");
    expect(s.notes.get("ws1")).toHaveLength(8);
    for (let i = 0; i < 4; i++) {
      const frame: Up = { t: "share", share: { ...share(`ws-${i}`, [`tab-${i}`]), encrypted: envelope(`share-${i}`, 500_000) } };
      expect(one(reduce(s, text("a1", frame)), "a1", "error")).toBeUndefined();
    }
    const extra: Up = { t: "share", share: { ...share("over-quota", ["extra-tab"]), encrypted: envelope("extra-share", 500_000) } };
    expect(one(reduce(s, text("a1", extra)), "a1", "error")?.code).toBe("quota");
    expect(s.shares.has("over-quota")).toBe(false);
  });
});
