import { describe, expect, it } from "vitest";
import { brief, matches, typing } from "./commands";

describe("typing", () => {
  it("finds the slash command at the start of the input up to the cursor", () => {
    expect(typing("/", 1)).toEqual({ query: "" });
    expect(typing("/com", 4)).toEqual({ query: "com" });
    expect(typing("/com later", 4)).toEqual({ query: "com" });
  });
  it("rejects embedded spaces, embedded slashes and commands away from the start", () => {
    expect(typing("/compact ok", 11)).toBeNull();
    expect(typing("/Users/x", 8)).toBeNull();
    expect(typing("hi /com", 7)).toBeNull();
    expect(typing("no slash", 8)).toBeNull();
  });
});

describe("matches", () => {
  const list = ["context", "compact", "caveman:caveman-commit", "release", "open-pr"].map((name) => ({ name }));
  const names = (q: string) => matches(q, list).map((c) => c.name);
  it("returns everything in order for an empty query", () => {
    expect(names("")).toEqual(["caveman:caveman-commit", "compact", "context", "open-pr", "release"]);
  });
  it("ranks full prefixes before prefixes of individual parts", () => {
    expect(names("com")).toEqual(["compact", "caveman:caveman-commit"]);
    expect(names("pr")).toEqual(["open-pr"]);
    expect(names("CON")).toEqual(["context"]);
  });
  it("returns nothing when no command matches", () => {
    expect(names("xyz")).toEqual([]);
  });
});

describe("brief", () => {
  it("returns only the first sentence", () => {
    expect(brief("Free up context by summarizing the conversation so far")).toBe("Free up context by summarizing the conversation so far");
    expect(brief("Surgical 1-2 file edit. Typo fixes, single-function rewrites.")).toBe("Surgical 1-2 file edit.");
    expect(brief("")).toBe("");
  });
  it("truncates long sentences with an ellipsis", () => {
    const long = "a".repeat(100);
    expect(brief(long).length).toBe(72);
    expect(brief(long).endsWith("…")).toBe(true);
  });
});
