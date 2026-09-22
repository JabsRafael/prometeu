import { describe, expect, it } from "vitest";
import { rows, splitRows } from "./diff";

describe("rows", () => {
  it("preserves line numbers on both sides after a replacement", () => {
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

  it("resets line counts at each hunk and accepts ranges without commas", () => {
    const patch = ["@@ -5 +7 @@", "-before", "+after", "@@ -80,2 +90,3 @@ context", " eight", "+nine", " ten"].join("\n");
    expect(rows(patch).filter(r => r.kind !== "hunk").map(r => [r.before, r.after])).toEqual([
      [5, null], [null, 7], [80, 90], [null, 91], [81, 92],
    ]);
  });

  it("accepts entirely added or removed files", () => {
    expect(rows("@@ -0,0 +1,2 @@\n+one\n+two").slice(1).map(r => [r.before, r.after])).toEqual([[null, 1], [null, 2]]);
    expect(rows("@@ -1,2 +0,0 @@\n-one\n-two").slice(1).map(r => [r.before, r.after])).toEqual([[1, null], [2, null]]);
  });

  it("ignores newline notices without consuming line numbers or empty content", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-before", "\\ No newline at end of file", "+after", " "].join("\n");
    expect(rows(patch).slice(1)).toEqual([
      { kind: "del", before: 1, after: null, text: "before" },
      { kind: "add", before: null, after: 1, text: "after" },
      { kind: "ctx", before: 2, after: 2, text: "" },
    ]);
  });

  it("does not interpret metadata or malformed hunks as content", () => {
    const patch = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ invalid @@", "+invalid", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(rows(patch).map(r => r.text)).toEqual(["@@ -1 +1 @@", "a", "b"]);
  });

  it("preserves whitespace and prefixes belonging to the file", () => {
    const patch = ["@@ -1,2 +1,2 @@", "--- content", "+++ content", " \t  context  "].join("\n");
    expect(rows(patch).slice(1).map(r => r.text)).toEqual(["-- content", "++ content", "\t  context  "]);
  });
});

describe("splitRows", () => {
  it("aligns unequal replacements and leaves the unmatched side empty", () => {
    const all = rows(["@@ -10,3 +10,4 @@", " a", "-b", "+c", "+d", " e"].join("\n"));
    expect(splitRows(all)).toEqual([
      { kind: "hunk", hunk: all[0] },
      { kind: "line", before: all[1], after: all[1] },
      { kind: "line", before: all[2], after: all[3] },
      { kind: "line", before: null, after: all[4] },
      { kind: "line", before: all[5], after: all[5] },
    ]);
  });

  it("does not align blocks separated by context or hunks", () => {
    const all = rows(["@@ -1,2 +1 @@", "-one", " two", "@@ -30 +29,2 @@", "+thirty", " thirty one"].join("\n"));
    expect(splitRows(all)).toEqual([
      { kind: "hunk", hunk: all[0] },
      { kind: "line", before: all[1], after: null },
      { kind: "line", before: all[2], after: all[2] },
      { kind: "hunk", hunk: all[3] },
      { kind: "line", before: null, after: all[4] },
      { kind: "line", before: all[5], after: all[5] },
    ]);
  });

  it("preserves every line in addition-only and deletion-only changes", () => {
    for (const sign of ["+", "-"]) {
      const all = rows("@@ -1,2 +1,2 @@\n" + sign + "one\n" + sign + "two");
      const split = splitRows(all).slice(1);
      expect(split).toHaveLength(2);
      expect(split.map(r => r.kind === "line" && (sign === "+" ? r.after : r.before))).toEqual(all.slice(1));
      expect(split.every(r => r.kind === "line" && (sign === "+" ? r.before : r.after) === null)).toBe(true);
    }
  });
});
