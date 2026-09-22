import { describe, expect, it } from "vitest";
import { mentions, short, typing } from "./paths";

describe("path being typed", () => {
  it("starts at an at-sign at a word boundary", () => {
    expect(typing("see @app/mo", 11)).toEqual({ from: 4, query: "app/mo" });
    expect(typing("@", 1)).toEqual({ from: 0, query: "" });
  });

  it("ignores at-signs inside words", () => {
    expect(typing("gustavo@x", 9)).toBeNull();
  });

  it("stops at whitespace after a completed mention", () => {
    expect(typing("@app/user.rb has bug", 20)).toBeNull();
  });

  it("reads up to the cursor rather than the end of the input", () => {
    expect(typing("@app afterward", 4)).toEqual({ from: 0, query: "app" });
  });
});

describe("message attachments become mentions", () => {
  const root = "/Users/me/wt/app";

  it("uses relative paths inside the worktree", () => {
    expect(mentions([`${root}/src/main.ts`], root)).toBe("@src/main.ts");
    expect(short(`${root}/src/main.ts`, root)).toBe("src/main.ts");
  });

  it("preserves absolute paths outside the worktree", () => {
    expect(mentions(["/Users/me/Desktop/screenshot.png"], root)).toBe("@/Users/me/Desktop/screenshot.png");
  });

  it("separates multiple attachments with a space", () => {
    expect(mentions([`${root}/a.ts`, "/tmp/b.ts"], root)).toBe("@a.ts @/tmp/b.ts");
  });

  it("quotes filenames containing spaces to preserve the whole mention", () => {
    expect(mentions(["/Users/me/My Files/final note.md"], root)).toBe('@"/Users/me/My Files/final note.md"');
  });

  it("produces no mentions without attachments", () => {
    expect(mentions([], root)).toBe("");
  });

  it("preserves all absolute paths without a worktree", () => {
    expect(mentions(["/tmp/a.ts"], null)).toBe("@/tmp/a.ts");
  });
});
