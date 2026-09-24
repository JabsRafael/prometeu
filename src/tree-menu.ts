import { t } from "./i18n";
import { icon } from "./icons";
import * as menu from "./menu";
import * as file from "./file-menu";

/// Build the file tree's context menu as data so the actions can be tested without a DOM, and so
/// the tree stays a drawing module. The same tree serves a workspace and the project-only view;
/// what changes between them arrives through the hooks. The conversation and path groups are
/// shared with the Changes panel through `file-menu.ts`.

export type Entry = { name: string; path: string; dir: boolean };

export type Hooks = file.Hooks & {
  open: (path: string) => void;
  toggle: (path: string) => void;
};

export type Context = file.Context & {
  expanded: boolean;
  hooks: Hooks;
};

export function treeMenu(entry: Entry, ctx: Context): menu.Item[] {
  const { hooks } = ctx;
  return [
    entry.dir
      ? {
          label: t(ctx.expanded ? "tree.menu.collapse" : "tree.menu.expand"),
          glyph: icon(ctx.expanded ? "chevron-down" : "chevron-right"),
          run: () => hooks.toggle(entry.path),
        }
      : { label: t("tree.menu.open"), glyph: icon("file"), run: () => hooks.open(entry.path) },
    "sep",
    ...file.fileGroups(entry, ctx),
  ];
}
