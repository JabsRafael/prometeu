import { describe, expect, it } from "vitest";
import { rows, splitRows } from "./diff";

describe("rows", () => {
  it("preserva os números dos dois lados depois de uma substituição", () => {
    const patch = ["@@ -10,3 +10,4 @@ fn main() {", " a", "-b", "+c", "+d", " e"].join("\n");
    expect(rows(patch)).toEqual([
      { kind: "hunk", before: null, after: null, text: "@@ -10,3 +10,4 @@ fn main() {" },
      { kind: "ctx", before: 10, after: 10, text: "a" },
      { kind: "del", before: 11, after: null, text: "b" },
      { kind: "add", before: null, after: 11, text: "c" },
      { kind: "add", before: null, after: 12, text: "d" },
      { kind: "ctx", before: 12, after: 13, text: "e" },
    ]);
  });

  it("reinicia a contagem em cada hunk e aceita trechos sem vírgula", () => {
    const patch = ["@@ -5 +7 @@", "-antes", "+depois", "@@ -80,2 +90,3 @@ contexto", " oito", "+nove", " dez"].join("\n");
    expect(rows(patch).filter(r => r.kind !== "hunk").map(r => [r.before, r.after])).toEqual([
      [5, null], [null, 7], [80, 90], [null, 91], [81, 92],
    ]);
  });

  it("aceita arquivos inteiramente adicionados ou removidos", () => {
    expect(rows("@@ -0,0 +1,2 @@\n+um\n+dois").slice(1).map(r => [r.before, r.after])).toEqual([[null, 1], [null, 2]]);
    expect(rows("@@ -1,2 +0,0 @@\n-um\n-dois").slice(1).map(r => [r.before, r.after])).toEqual([[1, null], [2, null]]);
  });

  it("ignora o aviso de newline sem consumir números ou texto vazio", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-antes", "\\ No newline at end of file", "+depois", " "].join("\n");
    expect(rows(patch).slice(1)).toEqual([
      { kind: "del", before: 1, after: null, text: "antes" },
      { kind: "add", before: null, after: 1, text: "depois" },
      { kind: "ctx", before: 2, after: 2, text: "" },
    ]);
  });

  it("não interpreta metadados ou um hunk ilegível como conteúdo", () => {
    const patch = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ estranho @@", "+inválido", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(rows(patch).map(r => r.text)).toEqual(["@@ -1 +1 @@", "a", "b"]);
  });

  it("mantém espaços e prefixos que pertencem ao arquivo", () => {
    const patch = ["@@ -1,2 +1,2 @@", "--- conteúdo", "+++ conteúdo", " \t  contexto  "].join("\n");
    expect(rows(patch).slice(1).map(r => r.text)).toEqual(["-- conteúdo", "++ conteúdo", "\t  contexto  "]);
  });
});

describe("splitRows", () => {
  it("alinha substituições desiguais e deixa o lado excedente vazio", () => {
    const all = rows(["@@ -10,3 +10,4 @@", " a", "-b", "+c", "+d", " e"].join("\n"));
    expect(splitRows(all)).toEqual([
      { kind: "hunk", hunk: all[0] },
      { kind: "line", before: all[1], after: all[1] },
      { kind: "line", before: all[2], after: all[3] },
      { kind: "line", before: null, after: all[4] },
      { kind: "line", before: all[5], after: all[5] },
    ]);
  });

  it("não alinha blocos separados por contexto ou hunk", () => {
    const all = rows(["@@ -1,2 +1 @@", "-um", " dois", "@@ -30 +29,2 @@", "+trinta", " trinta e um"].join("\n"));
    expect(splitRows(all)).toEqual([
      { kind: "hunk", hunk: all[0] },
      { kind: "line", before: all[1], after: null },
      { kind: "line", before: all[2], after: all[2] },
      { kind: "hunk", hunk: all[3] },
      { kind: "line", before: null, after: all[4] },
      { kind: "line", before: all[5], after: all[5] },
    ]);
  });

  it("preserva todas as linhas quando só há exclusões ou adições", () => {
    for (const sign of ["+", "-"]) {
      const all = rows("@@ -1,2 +1,2 @@\n" + sign + "um\n" + sign + "dois");
      const split = splitRows(all).slice(1);
      expect(split).toHaveLength(2);
      expect(split.map(r => r.kind === "line" && (sign === "+" ? r.after : r.before))).toEqual(all.slice(1));
      expect(split.every(r => r.kind === "line" && (sign === "+" ? r.before : r.after) === null)).toBe(true);
    }
  });
});
