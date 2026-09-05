import { describe, expect, it } from "vitest";
import { use } from "./i18n";
import { branchTaken, fmtTokens, type Board, type Workspace } from "./types";

// `1,2M` é a vírgula decimal do português: o formato do número segue o idioma.
use("pt-BR");

describe("fmtTokens", () => {
  it("abaixo de mil é o número; depois k e M arredondados", () => {
    expect(fmtTokens(812)).toBe("812");
    expect(fmtTokens(56_748)).toBe("57k");
    expect(fmtTokens(999_400)).toBe("999k");
    expect(fmtTokens(1_234_000)).toBe("1,2M");
  });
});

describe("branchTaken", () => {
  const ws = (id: string, branch: string, repos: string[], solto = false) =>
    ({
      id,
      title: id,
      branch,
      cleaned: false,
      repo: repos[0],
      worktree: solto ? repos[0] : `/wt/${repos.map((r) => r.slice(1)).join("+")}/${branch}`,
      repos: repos.map((path) => ({ path, name: path.slice(1), worktree: "", base: "", pr: null })),
    }) as unknown as Workspace;

  const board = (...workspaces: Workspace[]) =>
    ({ stages: [], projects: [], workspaces }) as unknown as Board;

  it("acusa o workspace que já abriu a branch quando os repos não são os mesmos", () => {
    const um = ws("um", "aut-49", ["/rules"]);
    expect(branchTaken(board(um), ["/rules", "/autonomous"], "aut-49")?.id).toBe("um");
  });

  it("mesmos repos caem na mesma pasta: reaproveitar não é disputar", () => {
    const um = ws("um", "aut-49", ["/rules"]);
    expect(branchTaken(board(um), ["/rules"], "aut-49")).toBeNull();
  });

  it("branch presa ao clone (sem worktree) disputa até com os mesmos repos", () => {
    const solto = ws("solto", "aut-49", ["/rules"], true);
    expect(branchTaken(board(solto), ["/rules"], "aut-49")?.id).toBe("solto");
  });

  it("outra branch, outro repo ou worktree já devolvido não disputam nada", () => {
    const outra = ws("outra", "aut-50", ["/rules"]);
    const alheio = ws("alheio", "aut-49", ["/outro"]);
    const limpo = { ...ws("limpo", "aut-49", ["/rules"]), cleaned: true } as Workspace;
    expect(branchTaken(board(outra, alheio, limpo), ["/rules", "/autonomous"], "aut-49")).toBeNull();
  });
});
