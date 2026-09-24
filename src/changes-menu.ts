import { t } from "./i18n";
import { icon } from "./icons";
import * as menu from "./menu";
import * as file from "./file-menu";

/// Build the context menu of a changed file in the Changes panel as data, so what a scope and the
/// workspace state allow is tested without a DOM. Reviewing and the Git group belong to this panel;
/// the conversation and path groups are the same ones the Files tree offers (`file-menu.ts`).

export type Scope = "staged" | "changes" | "conflict";

export type Change = { path: string; status: string };

export type Hooks = file.Hooks & {
  /// Select the file in the panel: its diff, or the conflict editor.
  review: () => void;
  /// The full file in the viewer.
  open: () => void;
  stage: () => void;
  unstage: () => void;
  /// Asks for confirmation before anything is lost; the builder only offers it.
  discard: () => void;
};

export type Context = file.Context & {
  scope: Scope;
  /// A running turn may be editing the same files, so Git actions wait for it.
  agentRunning: boolean;
  /// Another Git operation is in flight or the repository did not answer.
  blocked: boolean;
  hooks: Hooks;
};

export function changesMenu(change: Change, ctx: Context): menu.Item[] {
  const { hooks } = ctx;
  const deleted = change.status === "D";
  const items: menu.Item[] = [
    ctx.scope === "conflict"
      ? { label: t("git.menu.resolve"), glyph: icon("git-merge"), run: hooks.review }
      : { label: t("git.menu.diff"), glyph: icon("diff"), run: hooks.review },
    deleted
      ? { label: t("git.openFile"), glyph: icon("file"), disabled: true, hint: t("git.menu.open.deleted") }
      : { label: t("git.openFile"), glyph: icon("file"), run: hooks.open },
    "sep",
  ];

  // Keep blocked actions visible so the person learns why they wait.
  const gate = (item: Exclude<menu.Item, "sep">): menu.Item =>
    ctx.agentRunning
      ? { ...item, disabled: true, hint: t("err.git.agent"), run: undefined }
      : ctx.blocked
        ? { ...item, disabled: true, run: undefined }
        : item;
  // Conflicts are settled in their editor, which stages the result; the menu only leads there.
  if (ctx.scope === "staged") {
    items.push(gate({ label: t("git.unstage"), glyph: icon("x"), run: hooks.unstage }), "sep");
  } else if (ctx.scope === "changes") {
    items.push(
      gate({ label: t("git.stage"), glyph: icon("plus"), run: hooks.stage }),
      gate({ label: t("git.menu.discard"), glyph: icon("trash"), danger: true, run: hooks.discard }),
      "sep",
    );
  }

  items.push(...file.fileGroups({ path: change.path, dir: false, missing: deleted }, ctx));
  return items;
}
