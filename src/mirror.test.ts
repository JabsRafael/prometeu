import { describe, expect, it } from "vitest";
import { Mirror } from "./mirror";

const b = (s: string) => new TextEncoder().encode(s);
const s = (u: Uint8Array | null) => (u === null ? null : new TextDecoder().decode(u));
const text = (m: Mirror) => new TextDecoder().decode(m.bytes());

describe("espelho de uma conversa remota", () => {
  it("sem a rolagem, pedaço ao vivo não vai para a tela: ela vem com ele dentro", () => {
    const m = new Mirror();
    expect(m.ready).toBe(false);
    expect(m.absorb(9, b("perdido?"))).toBeNull();
    expect(text(m)).toBe("");
    m.seed(b("tudo até 9, inclusive o 'perdido?'"), 9);
    expect(text(m)).toBe("tudo até 9, inclusive o 'perdido?'");
  });

  it("pedaço que a rolagem já traz é descartado; o seguinte entra", () => {
    const m = new Mirror();
    m.seed(b("olá"), 5);
    expect(m.absorb(5, b("de novo"))).toBeNull();
    expect(m.absorb(4, b("mais velho ainda"))).toBeNull();
    expect(s(m.absorb(6, b(" mundo")))).toBe(" mundo");
    expect(text(m)).toBe("olá mundo");
  });

  it("a rolagem que chega de novo — o dono voltou — substitui, não emenda", () => {
    const m = new Mirror();
    m.seed(b("antes"), 1);
    m.absorb(2, b(" e depois"));
    m.seed(b("a tela inteira, de novo"), 7);
    expect(text(m)).toBe("a tela inteira, de novo");
    expect(m.absorb(7, b("já veio"))).toBeNull();
    expect(s(m.absorb(8, b("!")))).toBe("!");
  });

  it("a conversa chega em partes, e só a última a fecha", () => {
    const m = new Mirror();
    expect(m.seed(b("um "), 3, true)).toBe(false);
    expect(m.ready).toBe(false);
    expect(m.absorb(4, b("cedo"))).toBeNull();
    expect(m.seed(b("dois "), 3, true)).toBe(false);
    expect(m.seed(b("três"), 3)).toBe(true);
    expect(text(m)).toBe("um dois três");
    expect(m.absorb(3, b("já"))).toBeNull();
    expect(s(m.absorb(4, b("!")))).toBe("!");
  });

  it("passou do teto, o começo é que sai", () => {
    const m = new Mirror(10);
    m.seed(b("0123456789"), 1);
    m.absorb(2, b("abc"));
    expect(text(m)).toBe("3456789abc");
    // E o teto vale para a rolagem que chega grande também.
    m.seed(b("ABCDEFGHIJKLMN"), 3);
    expect(text(m)).toBe("EFGHIJKLMN");
  });

  it("guarda cópia: quem mandou os bytes pode reaproveitar o buffer", () => {
    const m = new Mirror();
    const buf = b("original");
    m.seed(buf, 1);
    const chunk = b("mutável");
    m.absorb(2, chunk);
    buf.fill(0x78);
    chunk.fill(0x78);
    expect(text(m)).toBe("originalmutável");
  });
});
