import { describe, expect, it } from "vitest";
import { label } from "./plugins";

/// O que o botão escreve. A distinção que importa é entre não ter escolhido e
/// ter escolhido nenhum: a primeira deixa o CLI carregar o que sempre
/// carregou, a segunda é uma sessão sem plugin nenhum além disso — e as duas
/// não podem parecer a mesma coisa na tela.
describe("o rótulo do seletor", () => {
  it("nunca escolher e escolher nenhum são frases diferentes", () => {
    expect(label(null)).not.toBe(label([]));
    expect(label(null)).toBeTruthy();
    expect(label([])).toBeTruthy();
  });

  it("um escolhido aparece pelo nome, e vários pela conta", () => {
    expect(label(["caveman"])).toBe("caveman");
    expect(label(["caveman", "ponytail"])).toContain("2");
  });
});
