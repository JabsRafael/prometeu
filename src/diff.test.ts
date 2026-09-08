import { describe, expect, it } from "vitest";
import { rows } from "./diff";

/// Verify the TypeScript consumer's line-number calculations independently of Rust patch_map tests.

describe("rows", () => {
  it("numera pelo arquivo de agora, e a apagada pelo de antes", () => {
    const patch = ["@@ -10,3 +10,4 @@ fn main() {", " a", "-b", "+c", "+d", " e"].join("\n");
    expect(rows(patch)).toEqual([
      { kind: "hunk", no: 0, text: "fn main() {" },
      { kind: "ctx", no: 10, text: "a" },
      // Deleted rows use their original-file line number, not their visual row position.
      { kind: "del", no: 11, text: "b" },
      { kind: "add", no: 11, text: "c" },
      { kind: "add", no: 12, text: "d" },
      { kind: "ctx", no: 13, text: "e" },
    ]);
  });

  it("continua a contagem no trecho seguinte", () => {
    const patch = ["@@ -1,1 +1,1 @@", "+um", "@@ -80,2 +90,2 @@ contexto", " oito", "+nove"].join("\n");
    const nos = rows(patch).map((r) => `${r.kind}:${r.no}`);
    expect(nos).toEqual(["hunk:0", "add:1", "hunk:0", "ctx:90", "add:91"]);
  });

  it("aceita trecho de uma linha só, sem vírgula", () => {
    const [hunk, line] = rows("@@ -5 +7 @@\n+só");
    expect(hunk.kind).toBe("hunk");
    expect(line).toEqual({ kind: "add", no: 7, text: "só" });
  });

  it("ignora o aviso de arquivo sem newline no fim", () => {
    // Git's no-newline marker is metadata and must not increment file line numbers.
    const patch = ["@@ -1,1 +1,1 @@", "-antes", "\\ No newline at end of file", "+depois"].join("\n");
    expect(rows(patch).map((r) => r.text)).toEqual(["", "antes", "depois"]);
  });

  it("hunk sem cabeçalho legível é descartado, não vira linha", () => {
    expect(rows("@@ estranho @@\n+x")).toEqual([{ kind: "add", no: 0, text: "x" }]);
  });
});
