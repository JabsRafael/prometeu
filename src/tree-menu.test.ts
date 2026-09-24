import { beforeEach, describe, expect, it, vi } from "vitest";
import { t, use } from "./i18n";
import * as menu from "./menu";
import { relocate, rootMenu, treeMenu, type Context, type Entry, type Hooks } from "./tree-menu";

beforeEach(() => use("en"));

const file: Entry = { name: "main.ts", path: "src/main.ts", dir: false };
const folder: Entry = { name: "scripts", path: "scripts", dir: true };

const ROOT = "/Users/me/wt/app";

function hooks(): Hooks {
  return {
    open: vi.fn(),
    toggle: vi.fn(),
    attach: vi.fn(),
    copy: vi.fn(),
    reveal: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn(),
  };
}

function context(over: Partial<Context> = {}): Context {
  return { root: ROOT, expanded: false, mac: true, hooks: hooks(), ...over };
}

const labels = (items: menu.Item[]) => items.map((item) => (item === "sep" ? "sep" : item.label));

function pick(items: menu.Item[], label: string) {
  const found = items.find((item) => item !== "sep" && item.label === label);
  if (!found || found === "sep") throw new Error(`no item labelled ${label}`);
  return found;
}

describe("file menu", () => {
  it("offers opening, creating, attaching, the path actions and the edits in that order", () => {
    expect(labels(treeMenu(file, context()))).toEqual([
      "Open",
      "sep",
      "New file",
      "New folder",
      "sep",
      "Attach to the conversation",
      "sep",
      "Copy path",
      "Copy absolute path",
      t("file.menu.reveal"),
      "sep",
      "Rename",
      "Move to trash",
    ]);
  });

  it("opens the file through the same path the row's click uses", () => {
    const ctx = context();
    pick(treeMenu(file, ctx), "Open").run?.();
    expect(ctx.hooks.open).toHaveBeenCalledWith("src/main.ts");
  });

  it("attaches the absolute path because the composer shortens it against the worktree", () => {
    const ctx = context();
    pick(treeMenu(file, ctx), "Attach to the conversation").run?.();
    expect(ctx.hooks.attach).toHaveBeenCalledWith(`${ROOT}/src/main.ts`);
  });

  it("copies the relative path the agent understands, and the absolute one on demand", () => {
    const ctx = context();
    const items = treeMenu(file, ctx);
    pick(items, "Copy path").run?.();
    expect(ctx.hooks.copy).toHaveBeenCalledWith("src/main.ts");
    pick(items, "Copy absolute path").run?.();
    expect(ctx.hooks.copy).toHaveBeenCalledWith(`${ROOT}/src/main.ts`);
  });

  it("reveals the file itself rather than the folder holding it", () => {
    const ctx = context();
    pick(treeMenu(file, ctx), t("file.menu.reveal")).run?.();
    expect(ctx.hooks.reveal).toHaveBeenCalledWith("src/main.ts");
  });
});

describe("file edits", () => {
  it("creates beside the file, in the folder that holds it", () => {
    const ctx = context();
    const items = treeMenu(file, ctx);
    pick(items, "New file").run?.();
    expect(ctx.hooks.create).toHaveBeenCalledWith("src", false);
    pick(items, "New folder").run?.();
    expect(ctx.hooks.create).toHaveBeenCalledWith("src", true);
  });

  it("creates at the root beside a top-level file", () => {
    const ctx = context();
    pick(treeMenu({ name: "README.md", path: "README.md", dir: false }, ctx), "New file").run?.();
    expect(ctx.hooks.create).toHaveBeenCalledWith("", false);
  });

  it("renames and trashes the entry itself", () => {
    const ctx = context();
    const items = treeMenu(file, ctx);
    pick(items, "Rename").run?.();
    expect(ctx.hooks.rename).toHaveBeenCalledWith(file);
    pick(items, "Move to trash").run?.();
    expect(ctx.hooks.trash).toHaveBeenCalledWith(file);
  });

  it("shows the row shortcuts and marks trashing as destructive", () => {
    const items = treeMenu(file, context());
    expect(pick(items, "Rename").hint).toBe("F2");
    const trash = pick(items, "Move to trash");
    expect(trash.hint).toBe("⌘⌫");
    expect(trash.danger).toBe(true);
  });

  it("names the Delete key outside macOS", () => {
    expect(pick(treeMenu(file, context({ mac: false })), "Move to trash").hint).toBe("Del");
  });
});

describe("folder menu", () => {
  it("expands instead of opening, and offers no attachment", () => {
    expect(labels(treeMenu(folder, context()))).toEqual([
      "Expand",
      "sep",
      "New file",
      "New folder",
      "sep",
      "Copy path",
      "Copy absolute path",
      t("file.menu.reveal"),
      "sep",
      "Rename",
      "Move to trash",
    ]);
  });

  it("creates inside the folder itself", () => {
    const ctx = context();
    const items = treeMenu(folder, ctx);
    pick(items, "New file").run?.();
    expect(ctx.hooks.create).toHaveBeenCalledWith("scripts", false);
    pick(items, "New folder").run?.();
    expect(ctx.hooks.create).toHaveBeenCalledWith("scripts", true);
  });

  it("collapses an expanded folder", () => {
    const ctx = context({ expanded: true });
    const items = treeMenu(folder, ctx);
    expect(labels(items)[0]).toBe("Collapse");
    pick(items, "Collapse").run?.();
    expect(ctx.hooks.toggle).toHaveBeenCalledWith("scripts");
  });
});

describe("unavailable actions", () => {
  it("drops the attachment where no conversation exists, such as the project view", () => {
    const items = treeMenu(file, context({ hooks: { ...hooks(), attach: null } }));
    expect(labels(items)).not.toContain("Attach to the conversation");
  });

  it("keeps the attachment visible but disabled when the agent cannot take files", () => {
    const items = treeMenu(
      file,
      context({ hooks: { ...hooks(), attach: null }, attachHint: "Codex does not take attachments" }),
    );
    const attach = pick(items, "Attach to the conversation");
    expect(attach.disabled).toBe(true);
    expect(attach.hint).toBe("Codex does not take attachments");
  });

  it("omits what needs an absolute path while the root is unresolved", () => {
    const items = treeMenu(file, context({ root: null }));
    expect(labels(items)).toEqual([
      "Open",
      "sep",
      "New file",
      "New folder",
      "sep",
      "Copy path",
      t("file.menu.reveal"),
      "sep",
      "Rename",
      "Move to trash",
    ]);
  });
});

describe("deleted entry menu", () => {
  it("offers restoring and copying the path, since nothing is on disk to open, edit or reveal", () => {
    expect(labels(treeMenu(file, context({ gone: true })))).toEqual([
      "Restore",
      "sep",
      "Copy path",
      "Copy absolute path",
    ]);
  });

  it("restores the entry's path, file or folder", () => {
    const ctx = context({ gone: true });
    pick(treeMenu(folder, ctx), "Restore").run?.();
    expect(ctx.hooks.restore).toHaveBeenCalledWith("scripts");
  });

  it("offers no attachment even where the conversation takes files", () => {
    const items = treeMenu(file, context({ gone: true, attachHint: "Codex does not take attachments" }));
    expect(labels(items)).not.toContain("Attach to the conversation");
  });
});

describe("empty area menu", () => {
  it("creates at the root and reveals the root", () => {
    const root = { create: vi.fn(), reveal: vi.fn() };
    const items = rootMenu(root);
    expect(labels(items)).toEqual(["New file", "New folder", "sep", t("file.menu.reveal")]);
    pick(items, "New file").run?.();
    expect(root.create).toHaveBeenCalledWith("", false);
    pick(items, "New folder").run?.();
    expect(root.create).toHaveBeenCalledWith("", true);
    pick(items, t("file.menu.reveal")).run?.();
    expect(root.reveal).toHaveBeenCalledWith("");
  });
});

describe("moved entries", () => {
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
