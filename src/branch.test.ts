import { describe, expect, it } from "vitest";
import { freshBranch, pair } from "./branch";

/// Um sorteio previsível: devolve os números na ordem dada e depois repete o
/// último, para o teste dizer exatamente que par sai de cada tentativa.
const dado = (...ns: number[]) => {
  let i = 0;
  return () => ns[Math.min(i++, ns.length - 1)];
};

describe("pair", () => {
  it("é um par de palavras, sem acento e sem maiúscula", () => {
    expect(pair()).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("sorteios diferentes dão pares diferentes", () => {
    expect(pair(dado(0, 0))).not.toBe(pair(dado(0.5, 0.5)));
  });
});

describe("freshBranch", () => {
  it("nasce com nome de palavras, sem data nem horário", () => {
    const nome = freshBranch([]);
    expect(nome).toMatch(/^prometheus\/[a-z]+-[a-z]+$/);
  });

  it("nome de branch que já existe no repo não é oferecido de novo", () => {
    const primeiro = freshBranch([], dado(0, 0));
    const outro = freshBranch([primeiro], dado(0, 0, 0.5, 0.5));
    expect(outro).not.toBe(primeiro);
    expect(outro).toMatch(/^prometheus\/[a-z]+-[a-z]+$/);
  });

  it("branch só no remoto também conta como tomada", () => {
    const primeiro = freshBranch([], dado(0, 0));
    const outro = freshBranch([`origin/${primeiro}`], dado(0, 0, 0.5, 0.5));
    expect(outro).not.toBe(primeiro);
  });

  it("sorteio teimoso no mesmo nome tomado acaba num número no fim", () => {
    const primeiro = freshBranch([], dado(0));
    expect(freshBranch([primeiro], dado(0))).toBe(`${primeiro}-2`);
  });

  it("nome parecido de outro projeto não atrapalha", () => {
    const nome = freshBranch([], dado(0));
    const taken = [`outro-${nome}`];
    expect(freshBranch(taken, dado(0))).toBe(nome);
  });
});
