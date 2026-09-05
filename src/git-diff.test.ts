import { describe, expect, it } from "vitest";
import { splitPatch } from "./git-diff";

describe("splitPatch", () => {
  it("alinha substituições de tamanhos diferentes e preserva números entre hunks", () => {
    const rows = splitPatch("@@ -10,3 +20,4 @@\n a\n-b\n+c\n+d\n e\n@@ -90 +100 @@\n-velho\n+novo\n\\ No newline at end of file");
    expect(rows.map(row => [row.old, row.next, row.before, row.after])).toEqual([
      [null, null, "@@ -10,3 +20,4 @@", "@@ -10,3 +20,4 @@"],
      [10, 20, "a", "a"], [11, 21, "b", "c"], [null, 22, "", "d"], [12, 23, "e", "e"],
      [null, null, "@@ -90 +100 @@", "@@ -90 +100 @@"], [90, 100, "velho", "novo"],
    ]);
  });

  it("não inventa linhas antigas para arquivos novos nem novas para apagados", () => {
    expect(splitPatch("@@ -0,0 +1,2 @@\n+um\n+dois").slice(1).map(row => [row.old, row.next])).toEqual([[null, 1], [null, 2]]);
    expect(splitPatch("@@ -1,2 +0,0 @@\n-um\n-dois").slice(1).map(row => [row.old, row.next])).toEqual([[1, null], [2, null]]);
  });
});
