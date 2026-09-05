import { describe, expect, it } from "vitest";
import type { Note } from "../relay/src/protocol";
import { matches, repliesOf, rootsOf, typing } from "./notes";

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

describe("threads", () => {
  const note = (id: string, ts: number, extra: Partial<Note> = {}): Note => ({
    id,
    ws: "ws1",
    author: "ana",
    text: id,
    mentions: [],
    quote: null,
    ts,
    tab: "t1",
    parent: null,
    resolved: false,
    ...extra,
  });

  it("agrupa respostas e ordena raízes pela atividade mais recente", () => {
    const items = [
      note("a", 1),
      note("b", 3),
      note("r1", 5, { parent: "a" }),
      note("r2", 4, { parent: "a" }),
    ];
    expect(rootsOf(items, "t1").map((item) => item.id)).toEqual(["a", "b"]);
    expect(repliesOf(items, "a").map((item) => item.id)).toEqual(["r2", "r1"]);
  });

  it("separa conversas e mantém notas antigas sem aba", () => {
    const items = [note("a", 1), note("b", 2, { tab: "t2" }), note("legacy", 3, { tab: null })];
    expect(rootsOf(items, "t1").map((item) => item.id)).toEqual(["legacy", "a"]);
    expect(rootsOf(items, "t2").map((item) => item.id)).toEqual(["legacy", "b"]);
  });
});
