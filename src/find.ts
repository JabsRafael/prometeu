/// Pure in-file search used by the file viewer's find bar. Offsets are UTF-16 indices into the
/// buffer so they map directly onto textarea selection ranges.

export type Match = { start: number; end: number; line: number };

/// Rendering thousands of marks costs more than it helps; the counter reports the cap instead.
export const MAX_MATCHES = 5000;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/// Smart case: an all-lowercase query ignores case; any uppercase letter makes it exact.
export function caseSensitive(query: string): boolean {
  return query !== query.toLowerCase();
}

/// Non-overlapping literal occurrences with zero-based line numbers, in document order.
/// The regex `i` flag folds case without changing offsets, unlike lowercasing the buffer.
export function findMatches(text: string, query: string, limit = MAX_MATCHES): Match[] {
  if (!query) return [];
  const re = new RegExp(escapeRegExp(query), caseSensitive(query) ? "g" : "gi");
  const out: Match[] = [];
  let line = 0;
  let scanned = 0;
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    for (let i = scanned; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
    scanned = m.index;
    out.push({ start: m.index, end: m.index + m[0].length, line });
  }
  return out;
}

/// Matches up to the cap, plus whether the text holds more. Collecting one extra match tells
/// exactly `limit` occurrences apart from a truncated list.
export function findCapped(text: string, query: string, limit = MAX_MATCHES): { matches: Match[]; more: boolean } {
  const matches = findMatches(text, query, limit + 1);
  const more = matches.length > limit;
  if (more) matches.pop();
  return { matches, more };
}

/// Map an offset in `before` onto `after`, assuming one contiguous edit between them. Offsets
/// before the edit stay, offsets after it shift by the length change, and offsets inside the
/// replaced range collapse to where the edit starts.
export function follow(before: string, after: string, offset: number): number {
  if (before === after) return offset;
  const shortest = Math.min(before.length, after.length);
  let head = 0;
  while (head < shortest && before.charCodeAt(head) === after.charCodeAt(head)) head++;
  let tail = 0;
  while (
    tail < shortest - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  )
    tail++;
  if (offset <= head) return offset;
  if (offset >= before.length - tail) return offset + after.length - before.length;
  return head;
}

/// The first match at or after the caret, wrapping to the first match; -1 when there are none.
export function nearest(matches: Match[], offset: number): number {
  if (!matches.length) return -1;
  const at = matches.findIndex((m) => m.start >= offset);
  return at < 0 ? 0 : at;
}

/// Move through matches with wraparound in both directions.
export function step(index: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  if (index < 0) return delta < 0 ? count - 1 : 0;
  return (((index + delta) % count) + count) % count;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/// Markup for the viewer's marker layer: one row per line that holds a match, placed by its line
/// number (`--row`, multiplied by the editor's line height in CSS). Each row repeats its line's
/// text, made transparent by CSS, so glyph positions match the editor exactly; lines without a
/// match cost nothing.
export function markup(text: string, matches: Match[], active: number): string {
  let html = "";
  let i = 0;
  while (i < matches.length) {
    const line = matches[i].line;
    const start = matches[i].start;
    const from = start > 0 ? text.lastIndexOf("\n", start - 1) + 1 : 0;
    let row = "";
    let at = from;
    for (; i < matches.length && matches[i].line === line; i++) {
      const m = matches[i];
      row += escapeHtml(text.slice(at, m.start));
      row += `<mark${i === active ? ' class="on"' : ""}>${escapeHtml(text.slice(m.start, m.end))}</mark>`;
      at = m.end;
    }
    const end = text.indexOf("\n", at);
    row += escapeHtml(text.slice(at, end < 0 ? text.length : end));
    html += `<div style="--row:${line}">${row}</div>`;
  }
  return html;
}
