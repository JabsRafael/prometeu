import { describe, expect, it } from "vitest";
import { fmtTokens, heaviest, type Workspace } from "./types";

describe("fmtTokens", () => {
  it("abaixo de mil é o número; depois k e M arredondados", () => {
    expect(fmtTokens(812)).toBe("812");
    expect(fmtTokens(56_748)).toBe("57k");
    expect(fmtTokens(999_400)).toBe("999k");
    expect(fmtTokens(1_234_000)).toBe("1,2M");
  });
});

describe("heaviest", () => {
  it("escolhe a aba com mais contexto e ignora as que nunca responderam", () => {
    const ws = {
      tabs: [
        { id: "a", title: "a", status: "pronta", note: null, tokens: null },
        { id: "b", title: "b", status: "pronta", note: null, tokens: 20_000 },
        { id: "c", title: "c", status: "rodando", note: null, tokens: 90_000 },
      ],
    } as unknown as Workspace;
    expect(heaviest(ws)?.id).toBe("c");
    expect(heaviest({ tabs: [] } as unknown as Workspace)).toBeUndefined();
  });
});
