import { describe, expect, it } from "vitest";
import { use } from "./i18n";
import { cmp, localize, parse, unseen, type Release } from "./news";

// Set the relevant language explicitly because Node defaults to English.
use("pt-BR");

const CHANGELOG = `# Changelog

O que muda no Prometeu, versão a versão, para quem usa o app.

## [0.4.8] - 2026-08-31

### Novidades

- **arquivos:** Editar e salvar o arquivo aberto sem passar pelo agente

### Correções

- **conversa:** Mensagens não ficam presas ao retomar uma aba

## [0.4.7] - 2026-08-30

### Correções

- **barra:** Simplifica o topo

## [0.1.0] - 2026-08-01

### Novidades

- O começo
`;

describe("parse", () => {
  it("uma versão por seção, da mais nova para a mais velha", () => {
    const all = parse(CHANGELOG);
    expect(all.map((r) => r.version)).toEqual(["0.4.8", "0.4.7", "0.1.0"]);
    expect(all[0].date).toBe("2026-08-31");
    expect(all[0].body).toContain("### Novidades");
    expect(all[0].body).toContain("Mensagens não ficam presas");
    // A release body ends at the next release heading.
    expect(all[0].body).not.toContain("Simplifica o topo");
  });

  it("o preâmbulo do arquivo não é versão nenhuma", () => {
    expect(parse(CHANGELOG).some((r) => r.body.includes("versão a versão"))).toBe(false);
  });

  it("arquivo vazio não quebra", () => {
    expect(parse("")).toEqual([]);
    expect(parse("# Changelog\n\nnada aqui\n")).toEqual([]);
  });

  it("versão sem data ainda conta", () => {
    const [one] = parse("## [0.5.0]\n\n### Novidades\n\n- algo\n");
    expect(one).toMatchObject({ version: "0.5.0", date: "" });
  });
});

describe("cmp", () => {
  it("ordena pelas três partes do número, e não pelo texto", () => {
    expect(cmp("0.4.10", "0.4.9")).toBe(1);
    expect(cmp("0.4.9", "0.4.10")).toBe(-1);
    expect(cmp("0.5.0", "0.4.99")).toBe(1);
    expect(cmp("1.0.0", "0.9.9")).toBe(1);
    expect(cmp("0.4.8", "0.4.8")).toBe(0);
  });
});

describe("unseen", () => {
  const all = parse(CHANGELOG);
  const versions = (rs: Release[]) => rs.map((r) => r.version);

  it("conta o que saiu depois da última que você viu", () => {
    expect(versions(unseen(all, "0.4.8", "0.4.7"))).toEqual(["0.4.8"]);
    expect(versions(unseen(all, "0.4.8", "0.1.0"))).toEqual(["0.4.8", "0.4.7"]);
  });

  it("em dia não conta nada", () => {
    expect(unseen(all, "0.4.8", "0.4.8")).toEqual([]);
    // Downgrading below the last viewed version shows no new releases.
    expect(unseen(all, "0.4.7", "0.4.8")).toEqual([]);
  });

  it("sem nada guardado mostra só a versão de agora", () => {
    expect(versions(unseen(all, "0.4.8", null))).toEqual(["0.4.8"]);
    expect(versions(unseen(all, "0.4.7", null))).toEqual(["0.4.7"]);
  });

  it("nunca conta o que ainda não está instalado", () => {
    expect(versions(unseen(all, "0.4.7", "0.1.0"))).toEqual(["0.4.7"]);
  });
});

describe("localize", () => {
  it("os títulos do git-cliff falam o idioma da tela", () => {
    const body = "### Novidades\n\n- **conversa:** algo\n\n### Correções\n\n- outro\n";
    use("en");
    expect(localize(body)).toContain("### New");
    expect(localize(body)).toContain("### Fixes");
    // Commit descriptions are content and remain unchanged.
    expect(localize(body)).toContain("**conversa:** algo");
    use("pt-BR");
    expect(localize(body)).toContain("### Novidades");
  });

  it("título que não é de seção passa intacto", () => {
    expect(localize("### Outra coisa\n")).toBe("### Outra coisa\n");
  });

  it("escolhe só o bloco do idioma nas notas bilíngues", () => {
    const body = `<!-- lang:pt-BR -->
### Novidades

- Abre conversas
<!-- lang:en -->
### New

- Opens conversations
<!-- lang:end -->`;
    use("en");
    expect(localize(body)).toBe("### New\n\n- Opens conversations");
    use("pt-BR");
    expect(localize(body)).toBe("### Novidades\n\n- Abre conversas");
  });
});
