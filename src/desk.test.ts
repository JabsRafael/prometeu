import { describe, expect, it } from "vitest";
import { arrange } from "./desk-layout";

/// A ordem da mesa é da pessoa: o que ela arrastou fica onde ficou, quem
/// fechou sai, quem abriu entra no fim — e nada aparece duas vezes.
describe("arrange", () => {
  it("mantém a ordem guardada, tira quem foi e põe quem chegou no fim", () => {
    expect(arrange(["a", "b", "c", "d"], ["c", "x", "a"])).toEqual(["c", "a", "b", "d"]);
  });

  it("sem ordem guardada, a do quadro", () => {
    expect(arrange(["b", "a"], [])).toEqual(["b", "a"]);
  });

  it("ordem guardada com repetição não duplica quadro", () => {
    expect(arrange(["a", "b"], ["b", "b", "a"])).toEqual(["b", "a"]);
  });
});
