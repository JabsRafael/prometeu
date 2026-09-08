/// Parse the CLI's /context markdown report into totals and sections for chat.ts; large tool tables are summarized instead of rendered verbatim.

export type Section = { title: string; headers: string[]; rows: string[][] };
export type Category = { name: string; tokens: string; n: number; pct: number };
export type Report = {
  model: string;
  used: string;
  total: string;
  pct: number;
  categories: Category[];
  sections: Section[];
};

const CATEGORIES = "Estimated usage by category";

export function isContextReport(text: string): boolean {
  return /^## Context Usage/m.test(text);
}

export function parseContext(text: string): Report | null {
  if (!isContextReport(text)) return null;
  const model = /\*\*Model:\*\*\s*(.+?)\s*$/m.exec(text)?.[1] ?? "";
  const use = /\*\*Tokens:\*\*\s*(\S+)\s*\/\s*(\S+)\s*\((\d+(?:\.\d+)?)%\)/.exec(text);
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const head = /^###\s+(.+)$/.exec(line);
    if (head) {
      cur = { title: head[1].trim(), headers: [], rows: [] };
      sections.push(cur);
      continue;
    }
    if (!cur || !line.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) continue;
    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => c.trim());
    if (!cur.headers.length) cur.headers = cells;
    else cur.rows.push(cells);
  }
  const cat = sections.find((s) => s.title === CATEGORIES);
  const categories: Category[] = (cat?.rows ?? []).map(([name = "", tokens = "", pct = ""]) => ({
    name,
    tokens,
    n: tokenCount(tokens),
    pct: Number.parseFloat(pct) || 0,
  }));
  return {
    model,
    used: use?.[1] ?? "",
    total: use?.[2] ?? "",
    pct: use ? Number.parseFloat(use[3]) : 0,
    categories,
    sections: sections.filter((s) => s !== cat && s.rows.length),
  };
}

/// Parse compact counts: 24k is 24000, 1m is 1000000, and ~190 is 190. Invalid input is zero.
export function tokenCount(s: string): number {
  const m = /^~?\s*(\d+(?:\.\d+)?)\s*([km])?$/i.exec(s.trim());
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  return Math.round(n * (m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1000 : 1));
}

/// 24000 → "24k", 3132 → "3.1k", 368 → "368".
export function kilo(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  if (k >= 1000) return `${(k / 1000).toFixed(1).replace(/\.0$/, "")}m`;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

/// Group large sections by their second column, such as MCP server or skill source, summing tokens. Preserve small sections as individual rows.
export function grouped(s: Section): { name: string; n: number; rows: string[][] }[] | null {
  if (s.rows.length < 8 || s.headers.length < 3) return null;
  const by = new Map<string, string[][]>();
  for (const row of s.rows) {
    const key = row[1] ?? "";
    by.set(key, [...(by.get(key) ?? []), row]);
  }
  if (by.size < 2) return null;
  return [...by].map(([name, rows]) => ({ name, n: rows.reduce((a, r) => a + tokenCount(r[2] ?? ""), 0), rows }));
}

export function sectionTotal(s: Section): number {
  const col = s.headers.length - 1;
  return s.rows.reduce((a, r) => a + tokenCount(r[col] ?? ""), 0);
}
