import { describe, expect, it } from "vitest";
import { caseSensitive, findMatches, markup, nearest, step } from "./find";

describe("findMatches", () => {
  it("returns nothing for an empty query", () => {
    expect(findMatches("abc", "")).toEqual([]);
  });

  it("finds literal occurrences with line numbers", () => {
    const text = "let a = 1;\nlet b = a;\n\nreturn a;";
    expect(findMatches(text, "a")).toEqual([
      { start: 4, end: 5, line: 0 },
      { start: 19, end: 20, line: 1 },
      { start: 30, end: 31, line: 3 },
    ]);
  });

  it("treats regex metacharacters literally", () => {
    expect(findMatches("a.b a*b (x)", ".")).toEqual([{ start: 1, end: 2, line: 0 }]);
    expect(findMatches("a.b a*b (x)", "(x)")).toEqual([{ start: 8, end: 11, line: 0 }]);
  });

  it("ignores case for lowercase queries and matches exactly otherwise", () => {
    expect(caseSensitive("foo")).toBe(false);
    expect(caseSensitive("Foo")).toBe(true);
    expect(findMatches("Foo foo FOO", "foo").map((m) => m.start)).toEqual([0, 4, 8]);
    expect(findMatches("Foo foo FOO", "Foo").map((m) => m.start)).toEqual([0]);
  });

  it("does not overlap matches", () => {
    expect(findMatches("aaaa", "aa").map((m) => m.start)).toEqual([0, 2]);
  });

  it("keeps UTF-16 offsets for accented and astral text", () => {
    const text = "café 🎉 CAFÉ";
    const hits = findMatches(text, "café");
    expect(hits.map((m) => text.slice(m.start, m.end))).toEqual(["café", "CAFÉ"]);
  });

  it("stops at the limit", () => {
    expect(findMatches("x".repeat(20), "x", 5)).toHaveLength(5);
  });
});

describe("navigation", () => {
  const hits = findMatches("a\na\na", "a");

  it("starts at the first match at or after the caret and wraps", () => {
    expect(nearest(hits, 0)).toBe(0);
    expect(nearest(hits, 1)).toBe(1);
    expect(nearest(hits, 5)).toBe(0);
    expect(nearest([], 0)).toBe(-1);
  });

  it("steps forward and backward with wraparound", () => {
    expect(step(0, 3, 1)).toBe(1);
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 3, -1)).toBe(2);
    expect(step(-1, 3, -1)).toBe(2);
    expect(step(-1, 3, 1)).toBe(0);
    expect(step(0, 0, 1)).toBe(-1);
  });
});

describe("markup", () => {
  it("escapes text and marks the active match", () => {
    const text = "<a> & a";
    const hits = findMatches(text, "a");
    expect(markup(text, hits, 1)).toBe('&lt;<mark>a</mark>&gt; &amp; <mark class="on">a</mark>');
  });

  it("renders nothing without matches", () => {
    expect(markup("abc", [], -1)).toBe("");
  });
});
