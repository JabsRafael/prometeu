import { afterEach, describe, expect, it } from "vitest";
import { EN } from "./i18n.en";
import { PT } from "./i18n.pt";
import { current, fromBack, match, stage, t, tn, use } from "./i18n";

afterEach(() => use("pt-BR"));

describe("match", () => {
  it("o que bate inteiro ganha do que bate na raiz", () => {
    expect(match(["pt-BR"])).toBe("pt-BR");
    expect(match(["en-US"])).toBe("en");
  });

  it("português de outro lugar cai no que temos", () => {
    expect(match(["pt-PT"])).toBe("pt-BR");
    expect(match(["PT-pt"])).toBe("pt-BR");
  });

  it("a ordem da lista é a preferência do computador", () => {
    expect(match(["fr-FR", "pt-BR", "en"])).toBe("pt-BR");
  });

  it("idioma que não falamos é inglês", () => {
    expect(match(["ja"])).toBe("en");
    expect(match([])).toBe("en");
  });
});

describe("t", () => {
  it("troca cada buraco pelo que veio", () => {
    use("pt-BR");
    expect(t("rail.newIn", { project: "njord" })).toBe("Novo workspace em njord");
    use("en");
    expect(t("rail.newIn", { project: "njord" })).toBe("New workspace in njord");
  });

  it("buraco sem valor fica como está, em vez de virar undefined", () => {
    use("pt-BR");
    expect(t("ws.copied", {})).toBe("{name} copiado");
  });
});

describe("tn", () => {
  it("um é singular, o resto é plural, nos dois idiomas", () => {
    use("pt-BR");
    expect(tn(1, "diff.files")).toBe("1 arquivo");
    expect(tn(0, "diff.files")).toBe("0 arquivos");
    use("en");
    expect(tn(1, "diff.files")).toBe("1 file");
    expect(tn(3, "diff.files")).toBe("3 files");
  });
});

describe("stage", () => {
  it("etapa que o app criou é traduzida; a que alguém escreveu, não", () => {
    use("en");
    expect(stage("Fazendo")).toBe("In progress");
    expect(stage("Esperando o Jorge")).toBe("Esperando o Jorge");
  });
});

describe("fromBack", () => {
  it("código do back vira frase no idioma da tela", () => {
    use("en");
    expect(fromBack('i18n:{"code":"err.pty.gone"}')).toBe("terminal is not running");
    use("pt-BR");
    expect(fromBack('i18n:{"code":"err.session.notGit","args":{"path":"/tmp/x"}}')).toBe(
      "/tmp/x não é um repositório git",
    );
  });

  it("o que não é código passa reto — erro de plugin continua legível", () => {
    expect(fromBack("process.restart not allowed")).toBe("process.restart not allowed");
    expect(fromBack(new Error("boom"))).toBe("Error: boom");
  });

  it("código torto não some: volta como veio", () => {
    expect(fromBack("i18n:{isto não é json")).toBe("i18n:{isto não é json");
  });
});

describe("catálogo", () => {
  it("os dois idiomas têm exatamente as mesmas chaves", () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(PT).sort());
  });

  // Um `{buraco}` que só existe de um lado é texto que sai errado num idioma e
  // certo no outro — e ninguém repara até estar na tela de quem lê o outro.
  it("cada frase tem os mesmos buracos nos dois idiomas", () => {
    const holes = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(PT) as (keyof typeof PT)[]) {
      expect([key, holes(EN[key])]).toEqual([key, holes(PT[key])]);
    }
  });

  it("nenhuma frase ficou vazia", () => {
    for (const [key, text] of Object.entries(PT)) expect([key, text.length > 0]).toEqual([key, true]);
    for (const [key, text] of Object.entries(EN)) expect([key, text.length > 0]).toEqual([key, true]);
  });

  it("idioma sem tradução para a chave cai no inglês em vez de sumir", () => {
    use("pt-BR");
    expect(current()).toBe("pt-BR");
    // `stage.Code review` é igual nos dois; o que importa é que existe nos dois.
    expect(t("stage.Code review")).toBe("Code review");
  });
});
