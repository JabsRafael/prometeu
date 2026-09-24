import { t } from "./i18n";
import { icon } from "./icons";
import * as menu from "./menu";
import * as file from "./file-menu";
import { mac } from "./platform";

/// Build the file tree's context menus as data so the actions can be tested without a DOM, and so
/// the tree stays a drawing module. The same tree serves a workspace and the project-only view;
/// what changes between them arrives through the hooks. The conversation and path groups are
/// shared with the Changes panel through `file-menu.ts`.

export type Entry = { name: string; path: string; dir: boolean };

/// What the empty area needs. Paths are relative to the tree's root, as list_dir returns them.
export type RootHooks = {
  /// Start typing a new entry's name inside `parent` ("" for the root).
  create: (parent: string, dir: boolean) => void;
  reveal: (path: string) => void;
};

export type Hooks = file.Hooks &
  RootHooks & {
    open: (path: string) => void;
    toggle: (path: string) => void;
    rename: (entry: Entry) => void;
    trash: (entry: Entry) => void;
    /// Bring a deleted entry back from the last commit.
    restore: (path: string) => void;
  };

export type Context = file.Context & {
  expanded: boolean;
  /// The entry was deleted from disk and only Git still knows it: the struck-through rows.
  gone?: boolean;
  /// Shortcut hints follow the platform; tests pin it.
  mac?: boolean;
  hooks: Hooks;
};

export function treeMenu(entry: Entry, ctx: Context): menu.Item[] {
  const { hooks } = ctx;
  // Nothing is on disk to open, attach, rename or reveal; the path still copies.
  if (ctx.gone) {
    return [
      { label: t("tree.menu.restore"), glyph: icon("rotate"), run: () => hooks.restore(entry.path) },
      "sep",
      ...file.fileGroups({ path: entry.path, dir: entry.dir, missing: true }, ctx),
    ];
  }
  // A new entry lands inside a folder, or beside a file.
  const parent = entry.dir ? entry.path : parentOf(entry.path);
  return [
    entry.dir
      ? {
          label: t(ctx.expanded ? "tree.menu.collapse" : "tree.menu.expand"),
          glyph: icon(ctx.expanded ? "chevron-down" : "chevron-right"),
          run: () => hooks.toggle(entry.path),
        }
      : { label: t("tree.menu.open"), glyph: icon("file"), run: () => hooks.open(entry.path) },
    "sep",
    ...createItems(parent, hooks),
    "sep",
    ...file.fileGroups(entry, ctx),
    "sep",
    { label: t("tree.menu.rename"), glyph: icon("pencil"), hint: "F2", run: () => hooks.rename(entry) },
    {
      label: t("tree.menu.trash"),
      glyph: icon("trash"),
      hint: (ctx.mac ?? mac) ? "⌘⌫" : "Del",
      danger: true,
      run: () => hooks.trash(entry),
    },
  ];
}

/// The empty area below the rows stands for the root, like a file manager's background.
export function rootMenu(hooks: RootHooks): menu.Item[] {
  return [
    ...createItems("", hooks),
    "sep",
    { label: t("file.menu.reveal"), glyph: icon("external-link"), run: () => hooks.reveal("") },
  ];
}

export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/// Where `path` is after the tree moved `from` to `to`: unchanged when unrelated, carried along when
/// it is `from` or lies inside it, and null when `to` is null because the entry went to the trash.
/// Tabs, drafts and expanded folders all follow a renamed entry through this one rule.
export function relocate(path: string, from: string, to: string | null): string | null {
  if (path !== from && !path.startsWith(`${from}/`)) return path;
  return to === null ? null : to + path.slice(from.length);
}

function createItems(parent: string, hooks: RootHooks): menu.Item[] {
  return [
    { label: t("tree.menu.newFile"), glyph: icon("file-plus"), run: () => hooks.create(parent, false) },
    { label: t("tree.menu.newFolder"), glyph: icon("folder-plus"), run: () => hooks.create(parent, true) },
  ];
}
