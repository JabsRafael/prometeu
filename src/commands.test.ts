import { describe, expect, it } from "vitest";
import { brief, matches, typing } from "./commands";

describe("typing", () => {
  it("acha o /… no começo da caixa até o cursor", () => {
    expect(typing("/", 1)).toEqual({ query: "" });
    expect(typing("/com", 4)).toEqual({ query: "com" });
    expect(typing("/com depois", 4)).toEqual({ query: "com" });
  });
  it("não é comando com espaço no meio, barra no meio, nem fora do começo", () => {
    expect(typing("/compact já", 11)).toBeNull();
    expect(typing("/Users/x", 8)).toBeNull();
    expect(typing("oi /com", 7)).toBeNull();
    expect(typing("sem barra", 9)).toBeNull();
  });
});

describe("matches", () => {
  const list = ["context", "compact", "caveman:caveman-commit", "release", "open-pr"].map((name) => ({ name }));
  const names = (q: string) => matches(q, list).map((c) => c.name);
  it("vazio é tudo, em ordem", () => {
    expect(names("")).toEqual(["caveman:caveman-commit", "compact", "context", "open-pr", "release"]);
  });
  it("primeiro quem começa assim, depois quem tem uma parte começando assim", () => {
    expect(names("com")).toEqual(["compact", "caveman:caveman-commit"]);
    expect(names("pr")).toEqual(["open-pr"]);
    expect(names("CON")).toEqual(["context"]);
  });
  it("sem nada parecido, nada", () => {
    expect(names("xyz")).toEqual([]);
  });
});

describe("brief", () => {
  it("a primeira frase, e não mais", () => {
    expect(brief("Free up context by summarizing the conversation so far")).toBe("Free up context by summarizing the conversation so far");
    expect(brief("Surgical 1-2 file edit. Typo fixes, single-function rewrites.")).toBe("Surgical 1-2 file edit.");
    expect(brief("")).toBe("");
  });
  it("frase comprida demais é cortada com reticências", () => {
    const long = "a".repeat(100);
    expect(brief(long).length).toBe(72);
    expect(brief(long).endsWith("…")).toBe(true);
  });
});
