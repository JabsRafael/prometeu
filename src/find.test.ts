import { describe, expect, it } from "vitest";
import { caseSensitive, findCapped, findMatches, follow, markup, nearest, step } from "./find";

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

describe("findCapped", () => {
  it("reports exactly the cap as complete", () => {
    const { matches, more } = findCapped("x".repeat(5), "x", 5);
    expect(matches).toHaveLength(5);
    expect(more).toBe(false);
  });

  it("reports one past the cap as truncated without keeping the extra match", () => {
    const { matches, more } = findCapped("x".repeat(6), "x", 5);
    expect(matches).toHaveLength(5);
    expect(more).toBe(true);
  });
});

describe("follow", () => {
  it("shifts offsets after an edit by its length change", () => {
    expect(follow("aa foo foo", "aaXX foo foo", 7)).toBe(9);
    expect(follow("aaXX foo foo", "aa foo foo", 9)).toBe(7);
  });

  it("keeps offsets before an edit", () => {
    expect(follow("foo bar foo", "foo bar foo!!", 8)).toBe(8);
  });

  it("collapses offsets inside a replaced range to where the edit starts", () => {
    expect(follow("a foo b", "a b", 3)).toBe(2);
  });

  it("keeps the same active match when an edit before it removes text", () => {
    const before = "abc foo foo";
    const after = "foo foo";
    const was = findMatches(before, "foo")[0].start;
    const hits = findMatches(after, "foo");
    // Searching from the stale offset would jump to the next match.
    expect(nearest(hits, was)).toBe(1);
    expect(nearest(hits, follow(before, after, was))).toBe(0);
  });

  it("keeps the same active match when an edit before it inserts text", () => {
    const before = "foo foo";
    const after = "XXXXXfoo foo";
    const was = findMatches(before, "foo")[1].start;
    const hits = findMatches(after, "foo");
    expect(nearest(hits, was)).toBe(0);
    expect(nearest(hits, follow(before, after, was))).toBe(1);
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
    expect(markup(text, hits, 1)).toBe(
      '<div style="--row:0">&lt;<mark>a</mark>&gt; &amp; <mark class="on">a</mark></div>',
    );
  });

  it("emits rows only for lines that hold a match", () => {
    const text = "one\ntwo a\nthree\na four a\nfive";
    const hits = findMatches(text, "a");
    expect(markup(text, hits, 2)).toBe(
      '<div style="--row:1">two <mark>a</mark></div>' +
        '<div style="--row:3"><mark>a</mark> four <mark class="on">a</mark></div>',
    );
  });

  it("renders nothing without matches", () => {
    expect(markup("abc", [], -1)).toBe("");
  });
});
