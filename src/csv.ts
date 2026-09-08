/// Read-only CSV parsing for the viewer. Infer the separator from the first row, preserve quoted separators and newlines, and fall back from UTF-8 to Windows-1252.

/// Try strict UTF-8 first; exported Excel files commonly use Windows-1252.
export function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/// Count unquoted separators only in the header so decimal commas in later rows do not distort detection.
export function sniff(text: string): string {
  const end = text.indexOf("\n");
  const line = end === -1 ? text : text.slice(0, end);
  const count: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c in count) count[c]++;
  }
  return count[";"] > count[","] ? ";" : count["\t"] > count[","] ? "\t" : ",";
}

/// Parse RFC 4180 in one pass: doubled quotes escape a quote, CRLF/LF end rows, and a trailing empty row is omitted. ponytail: synchronous on the UI thread, about 1 s per 50 MB; move to a worker if this becomes disruptive.
export function parse(text: string, sep = sniff(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let start = 0;
  let quoted = false;
  const s = sep.charCodeAt(0);
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (quoted) {
      if (c !== 34) continue;
      cell += text.slice(start, i);
      if (text.charCodeAt(i + 1) === 34) {
        cell += '"';
        i++;
      } else quoted = false;
      start = i + 1;
      continue;
    }
    if (c === 34) {
      cell += text.slice(start, i);
      quoted = true;
      start = i + 1;
    } else if (c === s || c === 10 || c === 13) {
      row.push(cell + text.slice(start, i));
      cell = "";
      if (c !== s) {
        if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
        rows.push(row);
        row = [];
      }
      start = i + 1;
    }
  }
  cell += text.slice(start);
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
