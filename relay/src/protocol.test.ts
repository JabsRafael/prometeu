import { describe, expect, it } from "vitest";
import { LIVE, SNAPSHOT, decodeBinary, encodeLive, encodeSnapshot, formatInvite, parseInvite } from "./protocol";

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
    expect(got).toMatchObject({ kind: SNAPSHOT, tab: "t", to: "bob", seq: 9 });
    if (got?.kind === SNAPSHOT) expect(text(got.bytes)).toBe("tudo");
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
});

describe("convite", () => {
  it("vai e volta", () => {
    expect(parseInvite(formatInvite("abc_-1", "s3gr3d0"))).toEqual({ team: "abc_-1", secret: "s3gr3d0" });
    expect(parseInvite("  pm1.a.b\n")).toEqual({ team: "a", secret: "b" });
  });
  it("recusa o que não é código", () => {
    expect(parseInvite("pm2.a.b")).toBeNull();
    expect(parseInvite("a.b")).toBeNull();
    expect(parseInvite("pm1.a.b.c")).toBeNull();
    expect(parseInvite("")).toBeNull();
  });
});
