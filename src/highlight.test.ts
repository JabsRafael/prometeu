import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

/// O tokenizador escreve HTML a partir de texto que veio de um arquivo do
/// usuário. Dois riscos moram aqui: escapar errado (e um `<script>` num arquivo
/// lido virar tag de verdade na tela) e classificar errado.

const classes = (html: string) => [...html.matchAll(/class="h-(\w)"/g)].map((m) => m[1]);

describe("highlight", () => {
  it("escapa o que veio do arquivo, dentro e fora de token", () => {
    const out = highlight('const x = "<img onerror=1>";', "a.ts");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    // Fora de qualquer gramática também: arquivo sem linguagem sai escapado.
    expect(highlight("<b>&</b>", "leiame.txt")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  it("não perde nem duplica texto", () => {
    const code = 'def soma(a, b) # tudo\n  a + b # "não é string"\nend\n';
    const plain = highlight(code, "x.rb").replace(/<[^>]+>/g, "");
    const back = plain.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(back).toBe(code);
  });

  it("comentário vence o que estiver dentro dele", () => {
    // `class` dentro do comentário não pode sair como palavra reservada: a
    // ordem das regras é o que decide, e é ela que este teste tranca.
    expect(classes(highlight("# class Foo", "x.rb"))).toEqual(["c"]);
    expect(classes(highlight("// const x", "x.ts"))).toEqual(["c"]);
  });

  it("conhece a linguagem pelo nome do arquivo, não só pela extensão", () => {
    expect(classes(highlight("class Foo", "Gemfile"))).toContain("k");
    expect(classes(highlight("# nada", ".env.local"))).toEqual(["c"]);
  });

  it("string sem fechar não engole o resto do arquivo", () => {
    // Uma aspa solta numa linha não pode pintar as linhas seguintes: o `\\n`
    // fora da classe é o que segura isso.
    const out = highlight('x = "aberta\nconst depois = 1', "a.ts");
    expect(classes(out)).toContain("k");
  });

  it("markdown não pinta Constante em prosa", () => {
    // Palavra com maiúscula é Constante em código e nome próprio em texto.
    expect(classes(highlight("O Prometeu roda o Claude Code.", "x.md"))).toEqual([]);
    expect(classes(highlight("# Título", "x.md"))).toEqual(["k"]);
  });
});
