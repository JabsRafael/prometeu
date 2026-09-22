import { describe, expect, it } from "vitest";
import { Mirror } from "./mirror";

const b = (s: string) => new TextEncoder().encode(s);
const s = (u: Uint8Array | null) => (u === null ? null : new TextDecoder().decode(u));
const text = (m: Mirror) => new TextDecoder().decode(m.bytes());

describe("remote conversation mirror", () => {
  it("buffers live chunks until the snapshot containing them arrives", () => {
    const m = new Mirror();
    expect(m.ready).toBe(false);
    expect(m.absorb(9, b("lost?"))).toBeNull();
    expect(text(m)).toBe("");
    m.seed(b("everything through 9, including 'lost?'"), 9);
    expect(text(m)).toBe("everything through 9, including 'lost?'");
  });

  it("discards chunks already present in the snapshot and accepts the next one", () => {
    const m = new Mirror();
    m.seed(b("hello"), 5);
    expect(m.absorb(5, b("again"))).toBeNull();
    expect(m.absorb(4, b("even older"))).toBeNull();
    expect(s(m.absorb(6, b(" world")))).toBe(" world");
    expect(text(m)).toBe("hello world");
  });

  it("replaces the conversation when a returning owner sends another snapshot", () => {
    const m = new Mirror();
    m.seed(b("before"), 1);
    m.absorb(2, b(" and after"));
    m.seed(b("the entire screen, again"), 7);
    expect(text(m)).toBe("the entire screen, again");
    expect(m.absorb(7, b("already received"))).toBeNull();
    expect(s(m.absorb(8, b("!")))).toBe("!");
  });

  it("assembles multipart snapshots and closes only after the final part", () => {
    const m = new Mirror();
    expect(m.seed(b("one "), 3, true)).toBe(false);
    expect(m.ready).toBe(false);
    expect(m.absorb(4, b("early"))).toBeNull();
    expect(m.seed(b("two "), 3, true)).toBe(false);
    expect(m.seed(b("three"), 3)).toBe(true);
    expect(text(m)).toBe("one two three");
    expect(m.absorb(3, b("already"))).toBeNull();
    expect(s(m.absorb(4, b("!")))).toBe("!");
  });

  it("drops the oldest bytes when the buffer exceeds its limit", () => {
    const m = new Mirror(10);
    m.seed(b("0123456789"), 1);
    m.absorb(2, b("abc"));
    expect(text(m)).toBe("3456789abc");
    // Apply the retention limit to oversized snapshots as well.
    m.seed(b("ABCDEFGHIJKLMN"), 3);
    expect(text(m)).toBe("EFGHIJKLMN");
  });

  it("copies received bytes so the sender can reuse its buffer", () => {
    const m = new Mirror();
    const buf = b("original");
    m.seed(buf, 1);
    const chunk = b("mutable");
    m.absorb(2, chunk);
    buf.fill(0x78);
    chunk.fill(0x78);
    expect(text(m)).toBe("originalmutable");
  });
});
