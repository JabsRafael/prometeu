import { t } from "./i18n";
import { icon } from "./icons";
import * as menu from "./menu";

/// The groups a file offers whichever panel shows it: handing it to the conversation and using its
/// path. Each panel builds its own leading groups (the tree opens and folds, Changes reviews and
/// stages) and appends these, so a file means the same thing in the Files tree and in Changes.

export type Hooks = {
  /// Absolute path: the composer shortens it back against the worktree when it sends the message.
  /// Null where no conversation can take the file.
  attach: ((absolute: string) => void) | null;
  copy: (text: string) => void;
  reveal: (path: string) => void;
};

export type Context = {
  /// Folder the subject's path is relative to: the worktree, the project clone or, in Changes, the
  /// repository's worktree. Null while the board has not resolved one.
  root: string | null;
  /// Explain an attachment the conversation refuses, so the action stays discoverable. Without a
  /// conversation at all there is nothing to explain and the item is dropped.
  attachHint?: string;
  hooks: Hooks;
};

export type Subject = {
  path: string;
  dir: boolean;
  /// Deleted from disk, as a removed file in Changes: only its path remains to copy.
  missing?: boolean;
};

export function fileGroups(subject: Subject, ctx: Context): menu.Item[] {
  const { hooks } = ctx;
  const absolute = ctx.root ? `${ctx.root}/${subject.path}` : null;
  const items: menu.Item[] = [];

  // Folders are not attachments; the conversation takes files that exist.
  const attachable = !subject.dir && !subject.missing;
  if (attachable && absolute && hooks.attach) {
    const attach = hooks.attach;
    items.push({ label: t("file.menu.attach"), glyph: icon("paperclip"), run: () => attach(absolute) }, "sep");
  } else if (attachable && ctx.attachHint) {
    items.push({ label: t("file.menu.attach"), glyph: icon("paperclip"), disabled: true, hint: ctx.attachHint }, "sep");
  }

  items.push({ label: t("file.menu.copyPath"), glyph: icon("copy"), run: () => hooks.copy(subject.path) });
  if (absolute) {
    items.push({ label: t("file.menu.copyAbsolute"), glyph: icon("copy"), run: () => hooks.copy(absolute) });
  }
  if (!subject.missing) {
    items.push({ label: t("file.menu.reveal"), glyph: icon("external-link"), run: () => hooks.reveal(subject.path) });
  }
  return items;
}
