/// The message format for attachments: every sent path is an @mention the agents resolve. Pure, so the mobile shell renders the same chips.

/// Prepend attachments as @path references, matching the launcher's first-message behavior. Use workspace-relative paths for internal files, absolute paths otherwise, and quote paths containing spaces.
export function mentions(picked: string[], root: string | null): string {
  return picked
    .filter(Boolean)
    .map((p) => `@${quoted(short(p, root))}`)
    .join(" ");
}

const MENTIONS = /^@(?:"[^"\n]+"|[^\s"]+)(?: @(?:"[^"\n]+"|[^\s"]+))*(?=\n\n|$)/;

/// Reverse `mentions` for display: the attachment paragraph that opens a sent message. Only a first paragraph made entirely of mentions qualifies, so an @path typed inside the text stays text.
export function leadingMentions(text: string): { paths: string[]; rest: string } | null {
  const line = MENTIONS.exec(text)?.[0];
  if (!line) return null;
  const paths = line.split(/ (?=@)/).map((token) => token.slice(1).replace(/^"(.*)"$/, "$1"));
  return { paths, rest: text.slice(line.length) };
}

export const isImage = (path: string) => /\.(?:png|jpe?g|gif|webp)$/i.test(path);

/// Use the path relative to the worktree when possible; retain absolute paths outside it.
export function short(path: string, root: string | null): string {
  const base = root?.replace(/\/+$/, "");
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

const quoted = (path: string) => (/\s/.test(path) ? `"${path}"` : path);
