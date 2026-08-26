/// O que atravessa o relay, num lugar só. Este arquivo é importado pelo Worker
/// (`relay/src/room.ts`) e pelo app (`src/team.ts`), então não pode depender
/// de nada de um lado que o outro não tenha: nem `@cloudflare/workers-types`,
/// nem DOM além do que o Node e o Worker também têm (`TextEncoder`).
///
/// Controle vai em texto JSON (`{ t: "…" }`); bytes de terminal vão em frame
/// binário, para não pagar base64 no caminho quente.

export const PROTO = 1;

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
/// A rolagem inteira de uma aba, para um membro só — quem acabou de abrir.
export const SNAPSHOT = 1;

export type Binary =
  | { kind: typeof LIVE; tab: string; bytes: Uint8Array }
  | { kind: typeof SNAPSHOT; tab: string; to: string; bytes: Uint8Array };

const enc = new TextEncoder();
const dec = new TextDecoder();

/// `[tipo][n][tab…][bytes]` — e, no snapshot, `[m][to…]` antes dos bytes. Os
/// ids vão com tamanho na frente, e não em 36 bytes fixos, para nenhum lado
/// depender do formato de uuid do outro.
export function encodeLive(tab: string, bytes: Uint8Array): Uint8Array {
  const id = enc.encode(tab);
  const out = new Uint8Array(2 + id.length + bytes.length);
  out[0] = LIVE;
  out[1] = id.length;
  out.set(id, 2);
  out.set(bytes, 2 + id.length);
  return out;
}

export function encodeSnapshot(tab: string, to: string, bytes: Uint8Array): Uint8Array {
  const id = enc.encode(tab);
  const who = enc.encode(to);
  const out = new Uint8Array(3 + id.length + who.length + bytes.length);
  out[0] = SNAPSHOT;
  out[1] = id.length;
  out.set(id, 2);
  out[2 + id.length] = who.length;
  out.set(who, 3 + id.length);
  out.set(bytes, 3 + id.length + who.length);
  return out;
}

/// `null` é frame que não segue o formato — descartado, nunca repassado.
export function decodeBinary(data: ArrayBuffer | Uint8Array): Binary | null {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (buf.length < 2) return null;
  const n = buf[1];
  if (buf.length < 2 + n || n === 0) return null;
  const tab = dec.decode(buf.subarray(2, 2 + n));
  if (buf[0] === LIVE) {
    return { kind: LIVE, tab, bytes: buf.subarray(2 + n) };
  }
  if (buf[0] === SNAPSHOT) {
    const at = 2 + n;
    if (buf.length < at + 1) return null;
    const m = buf[at];
    if (buf.length < at + 1 + m || m === 0) return null;
    const to = dec.decode(buf.subarray(at + 1, at + 1 + m));
    return { kind: SNAPSHOT, tab, to, bytes: buf.subarray(at + 1 + m) };
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
