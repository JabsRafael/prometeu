import { describe, expect, it } from "vitest";
import { notesOf } from "./team";

describe("notas do time", () => {
  it("não consulta um workspace local que nunca foi anunciado", () => {
    expect(notesOf("workspace-local-nunca-compartilhado")).toEqual([]);
  });
});
