/// O que atravessa o relay, num lugar só. Este arquivo é importado pelo Worker
/// (`relay/src/room.ts`) e pelo app (`src/team.ts`), então não pode depender
/// de nada de um lado que o outro não tenha: nem `@cloudflare/workers-types`,
/// nem DOM além do que o Node e o Worker também têm (`TextEncoder`).
///
/// Controle vai em texto JSON (`{ t: "…" }`); bytes de terminal vão em frame
/// binário, para não pagar base64 no caminho quente.

export const PROTO = 2;

export type Status = "rodando" | "querendo" | "pronta" | "desligada";

/// Uma aba como o dono a anuncia: o que o card do colega precisa para desenhar.
export type ShareTab = {
  id: string;
  title: string;
  status: Status;
  note: string | null;
  tokens: number | null;
};

/// Um workspace compartilhado, como o dono o anuncia. Muda a cada evento do
/// quadro do dono que mexa nele; o relay guarda o último.
export type Share = {
  id: string;
  title: string;
  repo_name: string;
  branch: string;
  stage: string;
  issue: { identifier: string; title: string; url: string } | null;
  active: string | null;
  tabs: ShareTab[];
  /// Tamanho do terminal de cada aba, `[cols, rows]` — o colega desenha nesse.
  sizes: Record<string, [number, number]>;
};

/// O mesmo, com o que só o relay sabe: de quem é, e se o dono está aí.
export type Shared = Share & { owner: string; online: boolean };

export type Member = { id: string; name: string; online: boolean };

export type Note = {
  id: string;
  ws: string;
  author: string;
  text: string;
  mentions: string[];
  /// Trecho do terminal que a nota cita, se cita.
  quote: string | null;
  ts: number;
};

/// Uma nota que menciona você e você ainda não abriu. `id` é o da nota.
export type Inbox = { id: string; ws: string; author: string; ts: number };

/// Quem está olhando cada aba dos seus workspaces: `ws → tab → membros`.
export type Watching = Record<string, Record<string, string[]>>;

/// App → relay.
export type Up =
  | { t: "me"; name: string }
  | { t: "share"; share: Share }
  | { t: "unshare"; ws: string }
  | { t: "attach"; ws: string; tab: string }
  | { t: "detach" }
  | { t: "size"; ws: string; tab: string; cols: number; rows: number }
  | { t: "write"; ws: string; tab: string; data: string }
  | { t: "note"; ws: string; text: string; mentions: string[]; quote: string | null }
  | { t: "notes"; ws: string }
  | { t: "inbox_read"; id: string };

/// Relay → app.
export type Down =
  | { t: "welcome"; you: string; members: Member[]; shares: Shared[]; inbox: Inbox[]; watching: Watching }
  | { t: "presence"; members: Member[] }
  | { t: "share"; share: Shared }
  | { t: "unshare"; ws: string }
  | { t: "watch"; ws: string; tab: string; members: string[]; added: string[] }
  | { t: "write"; ws: string; tab: string; data: string; from: string }
  | { t: "size"; ws: string; tab: string; cols: number; rows: number }
  | { t: "note"; note: Note }
  | { t: "notes"; ws: string; items: Note[] }
  | { t: "inbox"; items: Inbox[] }
  | { t: "error"; code: string };

/// Tetos do que uma nota carrega. Cortados no app antes de sair; o relay
/// recusa o que passar, para um cliente estranho não encher o storage.
export const NOTE_TEXT_MAX = 8 * 1024;
export const NOTE_QUOTE_MAX = 4 * 1024;

/* ---------- frames binários ---------- */

/// Saída ao vivo de uma aba: vai para quem está olhando aquela aba.
export const LIVE = 0;
/// A conversa inteira de uma aba, para um membro só — quem acabou de abrir.
/// Vai em partes: o relay limita cada mensagem a 1 MB, e uma conversa longa
/// passa disso. Cada parte diz se vem mais; a última fecha.
export const SNAPSHOT = 1;

/// Um pedaço de saída como o PTY entregou, com o número dele. O dono junta
/// vários num frame só (menos mensagens, que é o que o relay cobra), e o
/// número de cada um é o que deixa o colega pular o que o snapshot dele já
/// trazia — sem ninguém coordenar nada.
export type Segment = { seq: number; bytes: Uint8Array };

export type Binary =
  | { kind: typeof LIVE; tab: string; segments: Segment[] }
  | { kind: typeof SNAPSHOT; tab: string; to: string; seq: number; more: boolean; bytes: Uint8Array };

const enc = new TextEncoder();
const dec = new TextDecoder();

/// Escreve um inteiro de até 2^53 em oito bytes, big-endian, sem BigInt.
function putU64(view: DataView, at: number, n: number) {
  view.setUint32(at, Math.floor(n / 4294967296));
  view.setUint32(at + 4, n >>> 0);
}
function getU64(view: DataView, at: number): number {
  return view.getUint32(at) * 4294967296 + view.getUint32(at + 4);
}

/// `[0][n][tab…][k][seq,len × k][bytes…]`. Os ids vão com tamanho na frente,
/// e não em 36 bytes fixos, para nenhum lado depender do formato de uuid do
/// outro.
export function encodeLive(tab: string, segments: Segment[]): Uint8Array {
  const id = enc.encode(tab);
  const total = segments.reduce((n, s) => n + s.bytes.length, 0);
  const out = new Uint8Array(2 + id.length + 2 + segments.length * 12 + total);
  const view = new DataView(out.buffer);
  out[0] = LIVE;
  out[1] = id.length;
  out.set(id, 2);
  let at = 2 + id.length;
  view.setUint16(at, segments.length);
  at += 2;
  for (const s of segments) {
    putU64(view, at, s.seq);
    view.setUint32(at + 8, s.bytes.length);
    at += 12;
  }
  for (const s of segments) {
    out.set(s.bytes, at);
    at += s.bytes.length;
  }
  return out;
}

/// `[1][n][tab…][m][to…][seq][more][bytes…]`: uma parte da conversa até o
/// pedaço `seq`. `more` é 1 quando outra parte vem atrás.
export function encodeSnapshot(tab: string, to: string, seq: number, bytes: Uint8Array, more = false): Uint8Array {
  const id = enc.encode(tab);
  const who = enc.encode(to);
  const out = new Uint8Array(3 + id.length + who.length + 9 + bytes.length);
  const view = new DataView(out.buffer);
  out[0] = SNAPSHOT;
  out[1] = id.length;
  out.set(id, 2);
  let at = 2 + id.length;
  out[at] = who.length;
  out.set(who, at + 1);
  at += 1 + who.length;
  putU64(view, at, seq);
  out[at + 8] = more ? 1 : 0;
  out.set(bytes, at + 9);
  return out;
}

/// `null` é frame que não segue o formato — descartado, nunca repassado.
export function decodeBinary(data: ArrayBuffer | Uint8Array): Binary | null {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 2) return null;
  const n = buf[1];
  if (n === 0 || buf.length < 2 + n) return null;
  const tab = dec.decode(buf.subarray(2, 2 + n));
  let at = 2 + n;
  if (buf[0] === LIVE) {
    if (buf.length < at + 2) return null;
    const k = view.getUint16(at);
    at += 2;
    if (buf.length < at + k * 12) return null;
    const heads: [number, number][] = [];
    for (let i = 0; i < k; i++) {
      heads.push([getU64(view, at), view.getUint32(at + 8)]);
      at += 12;
    }
    const segments: Segment[] = [];
    for (const [seq, len] of heads) {
      if (buf.length < at + len) return null;
      segments.push({ seq, bytes: buf.subarray(at, at + len) });
      at += len;
    }
    return { kind: LIVE, tab, segments };
  }
  if (buf[0] === SNAPSHOT) {
    if (buf.length < at + 1) return null;
    const m = buf[at];
    if (m === 0 || buf.length < at + 1 + m + 9) return null;
    const to = dec.decode(buf.subarray(at + 1, at + 1 + m));
    at += 1 + m;
    const seq = getU64(view, at);
    return { kind: SNAPSHOT, tab, to, seq, more: buf[at + 8] === 1, bytes: buf.subarray(at + 9) };
  }
  return null;
}

/* ---------- convite ---------- */

/// `pm1.<time>.<segredo>`: o `pm1` é a versão, para um código velho ser
/// recusado com um erro claro em vez de conectar em lugar nenhum.
export function formatInvite(team: string, secret: string): string {
  return `pm1.${team}.${secret}`;
}

export function parseInvite(code: string): { team: string; secret: string } | null {
  const m = /^pm1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  return m ? { team: m[1], secret: m[2] } : null;
}
