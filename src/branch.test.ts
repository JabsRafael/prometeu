import { describe, expect, it } from "vitest";
import { freshBranch, pair } from "./branch";

/// Return predictable random values in sequence, then repeat the last one to make collision retries deterministic.
const dado = (...ns: number[]) => {
  let i = 0;
  return () => ns[Math.min(i++, ns.length - 1)];
};

describe("pair", () => {
  it("oferece 128 substantivos e 128 adjetivos distintos em ASCII", () => {
    const nomes = new Set<string>();
    const adjetivos = new Set<string>();
    for (let i = 0; i < 128; i++) {
      const nome = pair(dado(i / 128, i / 128));
      expect(nome).toMatch(/^[a-z]+-[a-z]+$/);
      const [substantivo, adjetivo] = nome.split("-");
      nomes.add(substantivo);
      adjetivos.add(adjetivo);
    }
    expect(nomes.size).toBe(128);
    expect(adjetivos.size).toBe(128);
  });

  it("é um par de palavras, sem acento e sem maiúscula", () => {
    expect(pair()).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("sorteios diferentes dão pares diferentes", () => {
    expect(pair(dado(0, 0))).not.toBe(pair(dado(0.5, 0.5)));
  });
});

describe("freshBranch", () => {
  it("nasce com palavras e quatro dígitos aleatórios", () => {
    const nome = freshBranch([]);
    expect(nome).toMatch(/^prometeu\/[a-z]+-[a-z]+-\d{4}$/);
  });

  it("varia o número mantendo as palavras e preserva quatro dígitos nos extremos", () => {
    expect(freshBranch([], dado(0, 0, 0))).toBe("prometeu/farol-lento-0000");
    expect(freshBranch([], dado(0, 0, 0.99999))).toBe("prometeu/farol-lento-9999");
  });

  it("nome de branch que já existe no repo não é oferecido de novo", () => {
    const primeiro = freshBranch([], dado(0, 0));
    const outro = freshBranch([primeiro], dado(0, 0, 0, 0.5, 0.5, 0.5));
    expect(outro).not.toBe(primeiro);
    expect(outro).toMatch(/^prometeu\/[a-z]+-[a-z]+-\d{4}$/);
  });

  it("branch só no remoto também conta como tomada", () => {
    const primeiro = freshBranch([], dado(0, 0));
    const outro = freshBranch([`origin/${primeiro}`], dado(0, 0, 0, 0.5, 0.5, 0.5));
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
