import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

/// Highlighting converts user-file contents into HTML. Test both escaping and token classification.

const classes = (html: string) => [...html.matchAll(/class="h-(\w)"/g)].map((m) => m[1]);

describe("highlight", () => {
  it("escapes file content inside and outside tokens", () => {
    const out = highlight('const x = "<img onerror=1>";', "a.ts");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    // Escape files without a recognized grammar too.
    expect(highlight("<b>&</b>", "readme.txt")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  it("does not lose or duplicate text", () => {
    const code = 'def sum(a, b) # all\n  a + b # "not a string"\nend\n';
    const plain = highlight(code, "x.rb").replace(/<[^>]+>/g, "");
    const back = plain.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(back).toBe(code);
  });

  it("gives comments precedence over their contents", () => {
    // Keywords inside comments remain comments; rule order is part of this contract.
    expect(classes(highlight("# class Foo", "x.rb"))).toEqual(["c"]);
    expect(classes(highlight("// const x", "x.ts"))).toEqual(["c"]);
  });

  it("recognizes languages by filename as well as extension", () => {
    expect(classes(highlight("class Foo", "Gemfile"))).toContain("k");
    expect(classes(highlight("# nothing", ".env.local"))).toEqual(["c"]);
  });

  it("does not let an unclosed string consume the rest of the file", () => {
    // An unmatched quote must not color subsequent lines.
    const out = highlight('x = "open\nconst after = 1', "a.ts");
    expect(classes(out)).toContain("k");
  });

  it("does not highlight capitalized prose as constants in Markdown", () => {
    // Capitalized words are constants in code but ordinary names in prose.
    expect(classes(highlight("Prometeu runs Claude Code.", "x.md"))).toEqual([]);
    expect(classes(highlight("# Title", "x.md"))).toEqual(["k"]);
  });
});
