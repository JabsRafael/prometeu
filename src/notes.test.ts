import { describe, expect, it } from "vitest";
import { matches, typing } from "./notes";

describe("typing", () => {
  it("acha o @… que vai até o cursor", () => {
    expect(typing("oi @ti", 6)).toEqual({ from: 3, query: "ti" });
    expect(typing("@", 1)).toEqual({ from: 0, query: "" });
    expect(typing("@ti depois", 3)).toEqual({ from: 0, query: "ti" });
  });
  it("não é menção com espaço no meio, nem @ dentro de palavra, nem longe do cursor", () => {
    expect(typing("@Thiago já", 10)).toBeNull();
    expect(typing("gustavo@x", 9)).toBeNull();
    expect(typing("@ti depois", 10)).toBeNull();
    expect(typing("sem arroba", 10)).toBeNull();
  });
});

describe("matches", () => {
  const people = [{ name: "Thiago Souza" }, { name: "Érica Lima" }, { name: "Sofia" }];
  it("prefixo de qualquer palavra do nome, sem acento nem maiúscula", () => {
    expect(matches("th", people).map((p) => p.name)).toEqual(["Thiago Souza"]);
    expect(matches("so", people).map((p) => p.name)).toEqual(["Thiago Souza", "Sofia"]);
    expect(matches("eri", people).map((p) => p.name)).toEqual(["Érica Lima"]);
    expect(matches("", people)).toHaveLength(3);
    expect(matches("zz", people)).toEqual([]);
  });
});
