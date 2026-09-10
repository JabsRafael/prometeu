import { describe, expect, it } from "vitest";
import {
  BINARY_FRAME_MAX,
  LIVE,
  SNAPSHOT,
  decodeBinary,
  encodeLive,
  encodeSnapshot,
  formatInvite,
  parseCreatedTeam,
  parseDown,
  parseInvite,
  parseMembership,
  parseUp,
} from "./protocol";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("frames binários", () => {
  it("ao vivo: vários pedaços, cada um com o seu número, voltam iguais", () => {
    const frame = encodeLive("aba-1", [
      { seq: 41, bytes: bytes("olá") },
      { seq: 42, bytes: new Uint8Array(0) },
      { seq: 2 ** 40 + 3, bytes: bytes("\x1b[2J") },
    ]);
    const got = decodeBinary(frame);
    expect(got?.kind).toBe(LIVE);
    if (got?.kind !== LIVE) return;
    expect(got.tab).toBe("aba-1");
    expect(got.segments.map((s) => [s.seq, text(s.bytes)])).toEqual([
      [41, "olá"],
      [42, ""],
      [2 ** 40 + 3, "\x1b[2J"],
    ]);
  });

  it("snapshot: aba, destinatário, número e bytes", () => {
    const got = decodeBinary(encodeSnapshot("t", "bob", 9, bytes("tudo")));
    expect(got).toMatchObject({ kind: SNAPSHOT, tab: "t", to: "bob", seq: 9, more: false });
    if (got?.kind === SNAPSHOT) expect(text(got.bytes)).toBe("tudo");
    const part = decodeBinary(encodeSnapshot("t", "bob", 9, bytes("meta"), true));
    expect(part).toMatchObject({ kind: SNAPSHOT, more: true });
  });

  it("decodifica a partir de um ArrayBuffer com offset, como o WebSocket entrega", () => {
    const frame = encodeLive("t", [{ seq: 1, bytes: bytes("x") }]);
    const padded = new Uint8Array(frame.length + 4);
    padded.set(frame, 4);
    const got = decodeBinary(padded.subarray(4));
    expect(got?.kind).toBe(LIVE);
  });

  it("lixo não vira frame", () => {
    expect(decodeBinary(new Uint8Array([]))).toBeNull();
    expect(decodeBinary(new Uint8Array([0, 5, 1]))).toBeNull();
    expect(decodeBinary(new Uint8Array([7, 1, 65]))).toBeNull();
    expect(decodeBinary(new Uint8Array([0, 1, 65, 0, 1]))).toBeNull();
  });

  it("recusa frame com lixo no fim, id inválido, UTF-8 quebrado ou acima do teto", () => {
    const live = encodeLive("tab", [{ seq: 1, bytes: bytes("x") }]);
    const trailing = new Uint8Array(live.length + 1);
    trailing.set(live);
    expect(decodeBinary(trailing)).toBeNull();
    expect(decodeBinary(encodeLive("__proto__", [{ seq: 1, bytes: bytes("x") }]))).toBeNull();
    expect(decodeBinary(new Uint8Array([LIVE, 1, 0xff, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]))).toBeNull();
    expect(decodeBinary(new Uint8Array(BINARY_FRAME_MAX + 1))).toBeNull();
  });
});

describe("frames de controle", () => {
  const validShare = {
    id: "ws1",
    title: "Trabalho",
    repo_name: "repo",
    branch: "main",
    stage: "Fazendo",
    issue: null,
    active: "t1",
    tabs: [{ id: "t1", title: "Agente", status: "rodando", note: null, tokens: 10 }],
    sizes: { t1: [80, 24] },
    audience: ["alice", "alice"],
  };

  it("copia e normaliza share/menções válidos", () => {
    const got = parseUp({ t: "share", share: validShare });
    expect(got?.t).toBe("share");
    if (got?.t === "share") expect(got.share.audience).toEqual(["alice"]);
    expect(parseUp({ t: "note", ws: "ws1", text: "oi", mentions: ["alice", "zé", "alice"], quote: null })).toEqual({
      t: "note",
      ws: "ws1",
      tab: null,
      anchor: null,
      text: "oi",
      mentions: ["alice"],
      quote: null,
    });
    expect(parseUp({ t: "note", ws: "ws1", tab: "t1", anchor: "s4.0", text: "oi", mentions: [], quote: "trecho" })).toMatchObject({ tab: "t1", anchor: "s4.0" });
    expect(parseUp({ t: "note_reply", ws: "ws1", note: "n1", text: "feito", mentions: ["alice"] })).toMatchObject({ t: "note_reply", note: "n1" });
    expect(parseUp({ t: "note_resolve", ws: "ws1", note: "n1" })).toEqual({ t: "note_resolve", ws: "ws1", note: "n1" });
  });

  it("recusa campos aninhados, dimensões, ids e tamanhos inválidos", () => {
    expect(parseUp({ t: "share", share: { ...validShare, active: "sumiu" } })).toBeNull();
    expect(parseUp({ t: "share", share: { ...validShare, sizes: { t1: [0, 24] } } })).toBeNull();
    expect(parseUp({ t: "share", share: { ...validShare, tabs: [{ ...validShare.tabs[0], status: "hack" }] } })).toBeNull();
    expect(parseUp({ t: "attach", ws: "__proto__", tab: "t1" })).toBeNull();
    expect(parseUp({ t: "me", name: "x".repeat(81) })).toBeNull();
    expect(parseUp({ t: "write", ws: "ws1", tab: "t1", data: "x".repeat(64 * 1024 + 1) })).toBeNull();
    expect(parseUp({ t: "note", ws: "ws1", tab: "sumiu!", anchor: null, text: "x", mentions: [], quote: null })).toBeNull();
    expect(parseUp({ t: "note_reply", ws: "ws1", note: "?", text: "x", mentions: [] })).toBeNull();
  });

  it("valida e limita tudo que volta de um relay configurável", () => {
    const shared = { ...validShare, owner: "alice", online: true };
    const welcome = {
      t: "welcome",
      you: "bob",
      members: [{ id: "bob", name: "Bob", online: true }],
      shares: [shared],
      inbox: [],
      watching: { ws1: { t1: ["bob", "bob"] } },
      comments: 1,
    };
    expect(parseDown(welcome)).toMatchObject({ t: "welcome", comments: 1, watching: { ws1: { t1: ["bob"] } } });
    expect(parseDown({ ...welcome, members: [{ id: "__proto__", name: "x", online: true }] })).toBeNull();
    expect(parseDown({ t: "write", ws: "ws1", tab: "t1", from: "alice", data: "x".repeat(64 * 1024 + 1) })).toBeNull();
    expect(parseDown({ t: "notes", ws: "ws1", items: [{ id: "n1", ws: "outro", author: "alice", text: "oi", mentions: [], quote: null, ts: 1 }] })).toBeNull();
    expect(parseDown({ t: "presence", members: Array.from({ length: 65 }, (_, i) => ({ id: `m${i}`, name: "x", online: true })) })).toBeNull();
    expect(parseDown({ ...welcome, comments: 2 })).toBeNull();
    expect(parseDown({ t: "note", note: { id: "n1", ws: "ws1", author: "alice", text: "oi", mentions: [], quote: null, ts: 1, tab: "t1", anchor: "s4.0", parent: null, resolved: false } })).toMatchObject({
      note: { tab: "t1", anchor: "s4.0", parent: null, resolved: false },
    });
  });
});

describe("convite", () => {
  it("vai e volta", () => {
    const team = "abc_-123";
    const secret = "s3gr3d0-individual-123456";
    expect(parseInvite(formatInvite(team, secret))).toEqual({ team, secret });
    expect(parseInvite(`  pm2.${team}.${secret}\n`)).toEqual({ team, secret });
  });
  it("recusa o que não é código", () => {
    expect(parseInvite("pm1.abcdefgh.abcdefghijklmnop")).toBeNull();
    expect(parseInvite("pm2.a.b")).toBeNull();
    expect(parseInvite("a.b")).toBeNull();
    expect(parseInvite("pm1.a.b.c")).toBeNull();
    expect(parseInvite("")).toBeNull();
  });

  it("valida as credenciais devolvidas pelos endpoints", () => {
    const membership = { member: "member_123", credential: "c".repeat(43) };
    expect(parseMembership(membership)).toEqual(membership);
    expect(parseMembership({ ...membership, credential: "curta" })).toBeNull();
    const created = { team: "team_123", secret: "s".repeat(32), ...membership };
    expect(parseCreatedTeam(created)).toEqual(created);
    expect(parseCreatedTeam({ ...created, team: "__proto__" })).toBeNull();
  });

  it("bounds renewable leases and accepts only a single-use ticket in renewal controls", () => {
    const ticket = "t".repeat(43);
    expect(parseUp({ t: "renew", ticket, member: "spoofed" })).toEqual({ t: "renew", ticket });
    for (const value of [null, "short", "t".repeat(44), "!".repeat(43)]) expect(parseUp({ t: "renew", ticket: value })).toBeNull();
    expect(parseDown({ t: "lease", expires_in: 60_000 })).toEqual({ t: "lease", expires_in: 60_000 });
    for (const value of [null, 0, -1, 1.5, 60_001, "60000"]) expect(parseDown({ t: "lease", expires_in: value })).toBeNull();
  });
});
