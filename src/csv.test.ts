import { describe, expect, it } from "vitest";
import { decode, parse, sniff } from "./csv";

describe("csv", () => {
  it("adivinha ; do Excel em pt-BR mesmo com vírgula decimal nas linhas", () => {
    const text = "nome;preço\ncafé;1,50\npão;0,75\n";
    expect(sniff(text)).toBe(";");
    expect(parse(text)).toEqual([
      ["nome", "preço"],
      ["café", "1,50"],
      ["pão", "0,75"],
    ]);
  });

  it("vírgula e tab também", () => {
    expect(parse("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parse("a\tb\r\n1\t2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("campo entre aspas guarda vírgula, quebra de linha e aspa dobrada", () => {
    const text = 'id,texto\n1,"olá, mundo"\n2,"linha um\nlinha dois"\n3,"diz ""oi"""\n';
    expect(parse(text)).toEqual([
      ["id", "texto"],
      ["1", "olá, mundo"],
      ["2", "linha um\nlinha dois"],
      ["3", 'diz "oi"'],
    ]);
  });

  it("campo vazio e linha sem quebra no fim", () => {
    expect(parse("a,,c\n,,")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });

  it("latin-1 não vira caractere quebrado", () => {
    const utf8 = new TextEncoder().encode("ação");
    expect(decode(utf8.buffer as ArrayBuffer)).toBe("ação");
    const latin1 = Uint8Array.from([0x61, 0xe7, 0xe3, 0x6f]);
    expect(decode(latin1.buffer as ArrayBuffer)).toBe("ação");
  });
});
