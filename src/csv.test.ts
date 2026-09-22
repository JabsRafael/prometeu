import { describe, expect, it } from "vitest";
import { decode, parse, sniff } from "./csv";

describe("csv", () => {
  it("detects the semicolon delimiter from Brazilian Excel despite decimal commas", () => {
    const text = "name;price\ncafé;1,50\nbread;0,75\n";
    expect(sniff(text)).toBe(";");
    expect(parse(text)).toEqual([
      ["name", "price"],
      ["café", "1,50"],
      ["bread", "0,75"],
    ]);
  });

  it("also detects commas and tabs", () => {
    expect(parse("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parse("a\tb\r\n1\t2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("preserves commas, newlines and doubled quotes inside quoted fields", () => {
    const text = 'id,text\n1,"hello, world"\n2,"line one\nline two"\n3,"says ""hi"""\n';
    expect(parse(text)).toEqual([
      ["id", "text"],
      ["1", "hello, world"],
      ["2", "line one\nline two"],
      ["3", 'says "hi"'],
    ]);
  });

  it("handles empty fields and a final line without a newline", () => {
    expect(parse("a,,c\n,,")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });

  it("decodes Latin-1 without corrupting characters", () => {
    const utf8 = new TextEncoder().encode("ação");
    expect(decode(utf8.buffer as ArrayBuffer)).toBe("ação");
    const latin1 = Uint8Array.from([0x61, 0xe7, 0xe3, 0x6f]);
    expect(decode(latin1.buffer as ArrayBuffer)).toBe("ação");
  });
});
