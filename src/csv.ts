/// CSV para a tabela do viewer. Só leitura: separador adivinhado pela primeira
/// linha, campo entre aspas com vírgula ou quebra de linha dentro fica inteiro,
/// e arquivo que não é UTF-8 cai para latin-1 em vez de virar caractere quebrado.

/// UTF-8 estrito primeiro; se não for, é quase sempre Excel em pt-BR (cp1252).
export function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/// O separador é o que mais aparece na primeira linha, fora de aspas. Só a
/// primeira: nas outras a vírgula decimal do pt-BR confundiria a conta.
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

/// RFC 4180, numa passada só: `""` dentro de aspas é aspa literal, `\r\n` e
/// `\n` são fim de linha, e a linha vazia do fim não vira registro.
// ponytail: síncrono no thread da tela — ~1 s por 50 MB. Worker se incomodar.
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
