import { describe, expect, it } from "vitest";
import { rows } from "./diff";

/// O `patch_map` do Rust já tem teste; o consumidor dele aqui não tinha nenhum.
/// É a única conta desta tela, e o que ela erra sai como número de linha errado
/// — que ninguém confere de olho.

describe("rows", () => {
  it("numera pelo arquivo de agora, e a apagada pelo de antes", () => {
    const patch = ["@@ -10,3 +10,4 @@ fn main() {", " a", "-b", "+c", "+d", " e"].join("\n");
    expect(rows(patch)).toEqual([
      { kind: "hunk", no: 0, text: "fn main() {" },
      { kind: "ctx", no: 10, text: "a" },
      // A linha apagada existe só no arquivo de antes, e é esse número que ela
      // mostra — 11, e não a posição dela na tela.
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
    // O `\ No newline at end of file` do git não é linha do arquivo: contar
    // com ele empurraria todo número depois dele.
    const patch = ["@@ -1,1 +1,1 @@", "-antes", "\\ No newline at end of file", "+depois"].join("\n");
    expect(rows(patch).map((r) => r.text)).toEqual(["", "antes", "depois"]);
  });

  it("hunk sem cabeçalho legível é descartado, não vira linha", () => {
    expect(rows("@@ estranho @@\n+x")).toEqual([{ kind: "add", no: 0, text: "x" }]);
  });
});
