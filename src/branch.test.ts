import { describe, expect, it } from "vitest";
import { freshBranch, pair } from "./branch";

/// Return predictable random values in sequence, then repeat the last one to make collision retries deterministic.
const draw = (...ns: number[]) => {
  let i = 0;
  return () => ns[Math.min(i++, ns.length - 1)];
};

describe("pair", () => {
  it("provides 128 distinct ASCII nouns and 128 distinct ASCII adjectives", () => {
    const nouns = new Set<string>();
    const adjectives = new Set<string>();
    for (let i = 0; i < 128; i++) {
      const name = pair(draw(i / 128, i / 128));
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
      const [noun, adjective] = name.split("-");
      nouns.add(noun);
      adjectives.add(adjective);
    }
    expect(nouns.size).toBe(128);
    expect(adjectives.size).toBe(128);
  });

  it("returns a lowercase pair of words without accents", () => {
    expect(pair()).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("different random draws produce different pairs", () => {
    expect(pair(draw(0, 0))).not.toBe(pair(draw(0.5, 0.5)));
  });
});

describe("freshBranch", () => {
  it("starts with words and four random digits", () => {
    const name = freshBranch([]);
    expect(name).toMatch(/^prometeu\/[a-z]+-[a-z]+-\d{4}$/);
  });

  it("varies the number while preserving words and four digits at both bounds", () => {
    expect(freshBranch([], draw(0, 0, 0))).toBe("prometeu/farol-lento-0000");
    expect(freshBranch([], draw(0, 0, 0.99999))).toBe("prometeu/farol-lento-9999");
  });

  it("does not offer a branch name that already exists in the repository", () => {
    const first = freshBranch([], draw(0, 0));
    const other = freshBranch([first], draw(0, 0, 0, 0.5, 0.5, 0.5));
    expect(other).not.toBe(first);
    expect(other).toMatch(/^prometeu\/[a-z]+-[a-z]+-\d{4}$/);
  });

  it("treats remote-only branches as taken", () => {
    const first = freshBranch([], draw(0, 0));
    const other = freshBranch([`origin/${first}`], draw(0, 0, 0, 0.5, 0.5, 0.5));
    expect(other).not.toBe(first);
  });

  it("appends a number when repeated draws produce the same taken name", () => {
    const first = freshBranch([], draw(0));
    expect(freshBranch([first], draw(0))).toBe(`${first}-2`);
  });

  it("ignores similar names from other projects", () => {
    const name = freshBranch([], draw(0));
    const taken = [`other-${name}`];
    expect(freshBranch(taken, draw(0))).toBe(name);
  });
});
