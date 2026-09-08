import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

/// Highlighting converts user-file contents into HTML. Test both escaping and token classification.

const classes = (html: string) => [...html.matchAll(/class="h-(\w)"/g)].map((m) => m[1]);

describe("highlight", () => {
  it("escapa o que veio do arquivo, dentro e fora de token", () => {
    const out = highlight('const x = "<img onerror=1>";', "a.ts");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    // Escape files without a recognized grammar too.
    expect(highlight("<b>&</b>", "leiame.txt")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  it("não perde nem duplica texto", () => {
    const code = 'def soma(a, b) # tudo\n  a + b # "não é string"\nend\n';
    const plain = highlight(code, "x.rb").replace(/<[^>]+>/g, "");
    const back = plain.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(back).toBe(code);
  });

  it("comentário vence o que estiver dentro dele", () => {
    // Keywords inside comments remain comments; rule order is part of this contract.
    expect(classes(highlight("# class Foo", "x.rb"))).toEqual(["c"]);
    expect(classes(highlight("// const x", "x.ts"))).toEqual(["c"]);
  });

  it("conhece a linguagem pelo nome do arquivo, não só pela extensão", () => {
    expect(classes(highlight("class Foo", "Gemfile"))).toContain("k");
    expect(classes(highlight("# nada", ".env.local"))).toEqual(["c"]);
  });

  it("string sem fechar não engole o resto do arquivo", () => {
    // An unmatched quote must not color subsequent lines.
    const out = highlight('x = "aberta\nconst depois = 1', "a.ts");
    expect(classes(out)).toContain("k");
  });

  it("markdown não pinta Constante em prosa", () => {
    // Capitalized words are constants in code but ordinary names in prose.
    expect(classes(highlight("O Prometeu roda o Claude Code.", "x.md"))).toEqual([]);
    expect(classes(highlight("# Título", "x.md"))).toEqual(["k"]);
  });
});
