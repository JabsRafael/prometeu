import { describe, expect, it } from "vitest";
import { relocate, relocateKeys, relocateTabs } from "./tree-moves";

describe("relocate", () => {
  it("carries the entry and everything inside it to the new name", () => {
    expect(relocate("src", "src", "lib")).toBe("lib");
    expect(relocate("src/deep/main.ts", "src", "lib")).toBe("lib/deep/main.ts");
  });

  it("leaves unrelated paths alone, including siblings that share a prefix", () => {
    expect(relocate("src2/main.ts", "src", "lib")).toBe("src2/main.ts");
    expect(relocate("README.md", "src", "lib")).toBe("README.md");
  });

  it("drops what went to the trash", () => {
    expect(relocate("src/main.ts", "src", null)).toBeNull();
    expect(relocate("src2/main.ts", "src", null)).toBe("src2/main.ts");
  });
});

describe("file tabs", () => {
  const tabs = { open: ["README.md", "src/main.ts", "src/util.ts", "src2/x.ts"], active: "src/util.ts" };

  it("keep their place in the strip and the active file under a renamed folder", () => {
    expect(relocateTabs(tabs, "src", "lib")).toEqual({
      open: ["README.md", "lib/main.ts", "lib/util.ts", "src2/x.ts"],
      active: "lib/util.ts",
    });
  });

  it("follow a renamed file that is not the one on screen", () => {
    expect(relocateTabs(tabs, "README.md", "GUIDE.md")).toEqual({
      open: ["GUIDE.md", "src/main.ts", "src/util.ts", "src2/x.ts"],
      active: "src/util.ts",
    });
  });

  it("close with a trashed entry and hand the view to the first tab left", () => {
    expect(relocateTabs(tabs, "src", null)).toEqual({ open: ["README.md", "src2/x.ts"], active: "README.md" });
    expect(relocateTabs({ open: ["a.md"], active: "a.md" }, "a.md", null)).toEqual({ open: [], active: null });
  });

  it("leave the conversation on screen when no file was", () => {
    expect(relocateTabs({ ...tabs, active: null }, "src", null).active).toBeNull();
  });
});

describe("drafts", () => {
  const drafts = () =>
    new Map([
      ["ws1\nsrc/main.ts", "edited main"],
      ["ws1\nsrc2/x.ts", "edited x"],
      ["ws2\nsrc/main.ts", "other workspace"],
    ]);

  it("follow a rename in their own workspace only", () => {
    const map = drafts();
    relocateKeys(map, "ws1\n", "src", "lib");
    expect([...map]).toEqual([
      ["ws1\nsrc2/x.ts", "edited x"],
      ["ws2\nsrc/main.ts", "other workspace"],
      ["ws1\nlib/main.ts", "edited main"],
    ]);
  });

  it("go to the trash with their file", () => {
    const map = drafts();
    relocateKeys(map, "ws1\n", "src/main.ts", null);
    expect([...map.keys()]).toEqual(["ws1\nsrc2/x.ts", "ws2\nsrc/main.ts"]);
  });
});
