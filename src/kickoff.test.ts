import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalog, effectiveKickoff, KICKOFF_KEY, rememberKickoff, storedKickoff } from "./kickoff";

const standalone = [
  { id: "review", description: "Review a diff.", content: "x" },
  { id: "discovery", description: "Interview first.", content: "x" },
];
const shipped = [
  { plugin: "sdd-kit", name: "specify", description: "Write a spec." },
  { plugin: "sdd-kit", name: "clarify", description: "" },
];

describe("kickoff catalog", () => {
  it("lists standalone skills first, then plugin skills, with backend IDs", () => {
    expect(catalog(standalone, shipped)).toEqual([
      { id: "skill-discovery/discovery", name: "discovery", description: "Interview first.", plugin: null },
      { id: "skill-review/review", name: "review", description: "Review a diff.", plugin: null },
      { id: "sdd-kit/clarify", name: "clarify", description: "", plugin: "sdd-kit" },
      { id: "sdd-kit/specify", name: "specify", description: "Write a spec.", plugin: "sdd-kit" },
    ]);
  });

  it("drops duplicate entries", () => {
    expect(catalog([], [...shipped, shipped[0]])).toHaveLength(2);
  });
});

describe("kickoff preference", () => {
  let saved: Map<string, string>;
  beforeEach(() => {
    saved = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores only a choice the catalog still offers", () => {
    const entries = catalog(standalone, shipped);
    expect(storedKickoff(entries)).toBe("");
    rememberKickoff("sdd-kit/specify");
    expect(localStorage.getItem(KICKOFF_KEY)).toBe("sdd-kit/specify");
    expect(storedKickoff(entries)).toBe("sdd-kit/specify");
    expect(storedKickoff(catalog(standalone, []))).toBe("");
    rememberKickoff("");
    expect(storedKickoff(entries)).toBe("");
  });

  it("starts without a kickoff when storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(() => rememberKickoff("sdd-kit/specify")).not.toThrow();
    expect(storedKickoff(catalog(standalone, shipped))).toBe("");
  });
});

describe("effective kickoff", () => {
  const entries = catalog(standalone, shipped);
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => "skill-review/review", setItem: () => {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an explicit choice across an unsupported provider", () => {
    expect(effectiveKickoff("sdd-kit/specify", entries, false)).toBe("");
    expect(effectiveKickoff("sdd-kit/specify", entries, true)).toBe("sdd-kit/specify");
  });

  it("uses the remembered preference until the person chooses, and honors an explicit none", () => {
    expect(effectiveKickoff(null, entries, true)).toBe("skill-review/review");
    expect(effectiveKickoff("", entries, true)).toBe("");
  });

  it("falls back to none when the chosen skill left the catalog", () => {
    expect(effectiveKickoff("sdd-kit/specify", catalog(standalone, []), true)).toBe("");
  });
});
