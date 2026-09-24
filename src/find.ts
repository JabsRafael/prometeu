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

/// Markup for the viewer's marker layer: the full text (made transparent by CSS, so glyph
/// positions match the editor exactly) with each match wrapped in a <mark>.
export function markup(text: string, matches: Match[], active: number): string {
  if (!matches.length) return "";
  let html = "";
  let at = 0;
  matches.forEach((m, i) => {
    html += escapeHtml(text.slice(at, m.start));
    html += `<mark${i === active ? ' class="on"' : ""}>${escapeHtml(text.slice(m.start, m.end))}</mark>`;
    at = m.end;
  });
  return html + escapeHtml(text.slice(at));
}
