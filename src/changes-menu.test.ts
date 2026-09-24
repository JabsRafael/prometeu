import { beforeEach, describe, expect, it, vi } from "vitest";
import { t, use } from "./i18n";
import * as menu from "./menu";
import { changesMenu, refusal, type Availability, type Change, type Context, type Hooks } from "./changes-menu";

beforeEach(() => use("en"));

const ROOT = "/Users/me/wt/app";
const modified: Change = { path: "src/main.ts", status: "M" };
const deleted: Change = { path: "src/old.ts", status: "D" };

function hooks(): Hooks {
  return {
    review: vi.fn(),
    open: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    discard: vi.fn(),
    refused: vi.fn(),
    attach: vi.fn(),
    copy: vi.fn(),
    reveal: vi.fn(),
  };
}

function context(over: Partial<Context> & Partial<Availability> = {}): Context {
  const { agentRunning = false, blocked = false, ...rest } = over;
  return { root: ROOT, scope: "changes", availability: () => ({ agentRunning, blocked }), hooks: hooks(), ...rest };
}

const labels = (items: menu.Item[]) => items.map((item) => (item === "sep" ? "sep" : item.label));

function pick(items: menu.Item[], label: string) {
  const found = items.find((item) => item !== "sep" && item.label === label);
  if (!found || found === "sep") throw new Error(`no item labelled ${label}`);
  return found;
}

const PATH_GROUP = ["Attach to the conversation", "sep", "Copy path", "Copy absolute path", t("file.menu.reveal")];

describe("scopes", () => {
  it("offers staging and discarding an unstaged file, then the file's shared groups", () => {
    expect(labels(changesMenu(modified, context()))).toEqual([
      "Open diff",
      "Open file",
      "sep",
      "Stage file",
      "Discard changes",
      "sep",
      ...PATH_GROUP,
    ]);
    expect(pick(changesMenu(modified, context()), "Discard changes").danger).toBe(true);
  });

  it("offers only unstaging a staged file, never discarding what the index holds", () => {
    expect(labels(changesMenu(modified, context({ scope: "staged" })))).toEqual([
      "Open diff",
      "Open file",
      "sep",
      "Unstage file",
      "sep",
      ...PATH_GROUP,
    ]);
  });

  it("leads a conflict to its editor and leaves staging to the resolution", () => {
    const conflict: Change = { path: "src/main.ts", status: "U" };
    expect(labels(changesMenu(conflict, context({ scope: "conflict" })))).toEqual([
      "Resolve conflict",
      "Open file",
      "sep",
      ...PATH_GROUP,
    ]);
  });

  it("routes each action through the panel's own hooks", () => {
    const ctx = context();
    const items = changesMenu(modified, ctx);
    for (const label of ["Open diff", "Open file", "Stage file", "Discard changes"]) pick(items, label).run?.();
    expect(ctx.hooks.review).toHaveBeenCalledOnce();
    expect(ctx.hooks.open).toHaveBeenCalledOnce();
    expect(ctx.hooks.stage).toHaveBeenCalledOnce();
    expect(ctx.hooks.discard).toHaveBeenCalledOnce();
    const staged = context({ scope: "staged" });
    pick(changesMenu(modified, staged), "Unstage file").run?.();
    expect(staged.hooks.unstage).toHaveBeenCalledOnce();
  });

  it("copies and attaches against the repository's worktree", () => {
    const ctx = context();
    const items = changesMenu(modified, ctx);
    pick(items, "Copy path").run?.();
    expect(ctx.hooks.copy).toHaveBeenCalledWith("src/main.ts");
    pick(items, "Copy absolute path").run?.();
    expect(ctx.hooks.copy).toHaveBeenCalledWith(`${ROOT}/src/main.ts`);
    pick(items, "Attach to the conversation").run?.();
    expect(ctx.hooks.attach).toHaveBeenCalledWith(`${ROOT}/src/main.ts`);
  });
});

describe("deleted file", () => {
  it("keeps opening the file visible but disabled, and offers only its path", () => {
    const items = changesMenu(deleted, context());
    const open = pick(items, "Open file");
    expect(open.disabled).toBe(true);
    expect(open.hint).toBe(t("git.menu.open.deleted"));
    expect(open.run).toBeUndefined();
    expect(labels(items)).toEqual([
      "Open diff",
      "Open file",
      "sep",
      "Stage file",
      "Discard changes",
      "sep",
      "Copy path",
      "Copy absolute path",
    ]);
  });
});

describe("unavailable Git actions", () => {
  it("disables them while an agent runs and says why", () => {
    const items = changesMenu(modified, context({ agentRunning: true }));
    for (const label of ["Stage file", "Discard changes"]) {
      const item = pick(items, label);
      expect(item.disabled).toBe(true);
      expect(item.hint).toBe(t("err.git.agent"));
      expect(item.run).toBeUndefined();
    }
    expect(pick(items, "Open diff").disabled).toBeFalsy();
    expect(pick(items, "Copy path").disabled).toBeFalsy();
  });

  it("disables them while another operation runs", () => {
    const item = pick(changesMenu(modified, context({ scope: "staged", blocked: true })), "Unstage file");
    expect(item.disabled).toBe(true);
    expect(item.run).toBeUndefined();
  });
});

describe("state that changes while the menu is open", () => {
  it("refuses a Git item when an agent started after the menu opened", () => {
    const live: Availability = { agentRunning: false, blocked: false };
    const ctx = context({ availability: () => live });
    const items = changesMenu(modified, ctx);
    live.agentRunning = true;
    for (const label of ["Stage file", "Discard changes"]) pick(items, label).run?.();
    expect(ctx.hooks.stage).not.toHaveBeenCalled();
    expect(ctx.hooks.discard).not.toHaveBeenCalled();
    expect(ctx.hooks.refused).toHaveBeenCalledWith("agent");
  });

  it("refuses unstaging when another operation began after the menu opened", () => {
    const live: Availability = { agentRunning: false, blocked: false };
    const ctx = context({ scope: "staged", availability: () => live });
    const item = pick(changesMenu(modified, ctx), "Unstage file");
    live.blocked = true;
    item.run?.();
    expect(ctx.hooks.unstage).not.toHaveBeenCalled();
    expect(ctx.hooks.refused).toHaveBeenCalledWith("blocked");
  });

  it("leaves the file's other groups unaffected", () => {
    const live: Availability = { agentRunning: false, blocked: false };
    const ctx = context({ availability: () => live });
    const items = changesMenu(modified, ctx);
    live.agentRunning = true;
    pick(items, "Open diff").run?.();
    pick(items, "Copy path").run?.();
    expect(ctx.hooks.review).toHaveBeenCalledOnce();
    expect(ctx.hooks.copy).toHaveBeenCalledOnce();
    expect(ctx.hooks.refused).not.toHaveBeenCalled();
  });

  it("names the agent before another operation, since only the agent needs explaining", () => {
    expect(refusal({ agentRunning: false, blocked: false })).toBeNull();
    expect(refusal({ agentRunning: true, blocked: true })).toBe("agent");
    expect(refusal({ agentRunning: false, blocked: true })).toBe("blocked");
  });
});
