/// Alinha os dois lados de um patch Git sem reconstruir o arquivo inteiro.
/// Linhas de contexto preservam os números originais; blocos de remoção e
/// adição compartilham linhas visuais mesmo quando seus tamanhos diferem.
export type SplitRow = {
  old: number | null;
  next: number | null;
  before: string;
  after: string;
  kind: "context" | "change" | "hunk";
};

export function splitPatch(patch: string): SplitRow[] {
  const rows: SplitRow[] = [];
  let old = 0, next = 0;
  let removed: string[] = [], added: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ old: i < removed.length ? old++ : null, next: i < added.length ? next++ : null,
        before: removed[i] ?? "", after: added[i] ?? "", kind: "change" });
    }
    removed = []; added = [];
  };
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      flush(); old = Number(hunk[1]); next = Number(hunk[2]);
      rows.push({ old: null, next: null, before: line, after: line, kind: "hunk" });
    } else if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith(" ")) {
      flush(); rows.push({ old: old++, next: next++, before: line.slice(1), after: line.slice(1), kind: "context" });
    }
  }
  flush();
  return rows;
}
