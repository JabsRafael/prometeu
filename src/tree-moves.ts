/// Where the file tree's renames and trashes leave the paths other screens hold: open tabs, unsaved
/// drafts and expanded folders. Pure, so the one rule they share is tested without a DOM.

/// Where `path` is after the tree moved `from` to `to`: unchanged when unrelated, carried along when
/// it is `from` or lies inside it, and null when `to` is null because the entry went to the trash.
export function relocate(path: string, from: string, to: string | null): string | null {
  if (path !== from && !path.startsWith(`${from}/`)) return path;
  return to === null ? null : to + path.slice(from.length);
}

export type Tabs = { open: string[]; active: string | null };

/// File tabs after a move: renamed tabs keep their place in the strip, trashed ones leave it, and a
/// trashed active file hands the view to the first tab left, or to none.
export function relocateTabs(tabs: Tabs, from: string, to: string | null): Tabs {
  const open = tabs.open.flatMap((path) => relocate(path, from, to) ?? []);
  const active = tabs.active === null ? null : (relocate(tabs.active, from, to) ?? open[0] ?? null);
  return { open, active };
}

/// Move the entries of `map` whose keys are `prefix` plus a moved path, in place. Keys under other
/// prefixes (another workspace's drafts) are left alone.
export function relocateKeys<V>(map: Map<string, V>, prefix: string, from: string, to: string | null) {
  for (const [key, value] of [...map]) {
    if (!key.startsWith(prefix)) continue;
    const path = key.slice(prefix.length);
    const next = relocate(path, from, to);
    if (next === path) continue;
    map.delete(key);
    if (next !== null) map.set(prefix + next, value);
  }
}
