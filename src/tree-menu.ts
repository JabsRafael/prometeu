import { t } from "./i18n";
import { icon } from "./icons";
import * as menu from "./menu";

/// Build the file tree's context menu as data so the actions can be tested without a DOM, and so
/// the tree stays a drawing module. The same tree serves a workspace and the project-only view;
/// what changes between them arrives through the hooks.

export type Entry = { name: string; path: string; dir: boolean };

export type Hooks = {
  open: (path: string) => void;
  toggle: (path: string) => void;
  /// Absolute path: the composer shortens it back against the worktree when it sends the message.
  /// Null where no conversation can take the file.
  attach: ((absolute: string) => void) | null;
  copy: (text: string) => void;
  reveal: (path: string) => void;
};

export type Context = {
  /// Worktree or project clone. Null while the board has not resolved one.
  root: string | null;
  expanded: boolean;
  /// Explain an attachment the conversation refuses, so the action stays discoverable. Without a
  /// conversation at all there is nothing to explain and the item is dropped.
  attachHint?: string;
  hooks: Hooks;
};

export function treeMenu(entry: Entry, ctx: Context): menu.Item[] {
  const { hooks } = ctx;
  const absolute = ctx.root ? `${ctx.root}/${entry.path}` : null;
  const items: menu.Item[] = [
    entry.dir
      ? {
          label: t(ctx.expanded ? "tree.menu.collapse" : "tree.menu.expand"),
          glyph: icon(ctx.expanded ? "chevron-down" : "chevron-right"),
          run: () => hooks.toggle(entry.path),
        }
      : { label: t("tree.menu.open"), glyph: icon("file"), run: () => hooks.open(entry.path) },
    "sep",
  ];

  // Folders are not attachments; the conversation takes files.
  if (!entry.dir && absolute && hooks.attach) {
    const attach = hooks.attach;
    items.push({ label: t("tree.menu.attach"), glyph: icon("paperclip"), run: () => attach(absolute) }, "sep");
  } else if (!entry.dir && ctx.attachHint) {
    items.push({ label: t("tree.menu.attach"), glyph: icon("paperclip"), disabled: true, hint: ctx.attachHint }, "sep");
  }

  items.push({ label: t("tree.menu.copyPath"), glyph: icon("copy"), run: () => hooks.copy(entry.path) });
  if (absolute) {
    items.push({ label: t("tree.menu.copyAbsolute"), glyph: icon("copy"), run: () => hooks.copy(absolute) });
  }
  items.push({ label: t("tree.menu.reveal"), glyph: icon("external-link"), run: () => hooks.reveal(entry.path) });
  return items;
}
