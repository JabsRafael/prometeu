/// O que atravessa o relay, num lugar só. Este arquivo é importado pelo Worker
/// (`relay/src/room.ts`) e pelo app (`src/team.ts`), então não pode depender
/// de nada de um lado que o outro não tenha: nem `@cloudflare/workers-types`,
/// nem DOM além do que o Node e o Worker também têm (`TextEncoder`).
///
/// Controle vai em texto JSON (`{ t: "…" }`); bytes de terminal vão em frame
/// binário, para não pagar base64 no caminho quente.

// v3 troca o segredo coletivo usado em todo WebSocket por uma matrícula e uma
// credencial individuais. O segredo do convite passa a servir somente para
// matricular um membro novo.
export const PROTO = 3;

/* ---------- limites e validação de controle ---------- */

export const ID_MAX = 64;
export const NAME_MAX = 80;
export const TITLE_MAX = 256;
export const URL_MAX = 2 * 1024;
export const TAB_NOTE_MAX = 4 * 1024;
export const TABS_MAX = 32;
export const AUDIENCE_MAX = 64;
export const MENTIONS_MAX = 32;
export const SHARES_MAX = 64;
export const NOTES_PER_WORKSPACE_MAX = 200;
export const NOTES_TOTAL_MAX = 2_000;
export const INBOX_MAX = 500;
export const NOTE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
export const WRITE_MAX = 64 * 1024;
export const TEXT_FRAME_MAX = 128 * 1024;
// `welcome` agrega tudo que foi aceito em vários frames individuais. Continua
// limitado no cliente, mas precisa caber mais que um único `share`.
export const DOWN_FRAME_MAX = 16 * 1024 * 1024;
export const BINARY_FRAME_MAX = 1024 * 1024;
export const BINARY_SEGMENTS_MAX = 256;
export const MEMBERS_MAX = 64;
export const SOCKETS_MAX = 128;
export const SOCKETS_PER_MEMBER_MAX = 4;
export const RATE_WINDOW_MS = 10_000;
export const FRAMES_PER_WINDOW_MAX = 500;
export const BYTES_PER_WINDOW_MAX = 4 * 1024 * 1024;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{32,128}$/;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STATUSES = new Set<Status>(["rodando", "querendo", "pronta", "desligada"]);

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number, empty = true): v is string =>
  typeof v === "string" && v.length <= max && (empty || v.trim().length > 0) && !v.includes("\0");
const id = (v: unknown): v is string => typeof v === "string" && ID.test(v) && !RESERVED_KEYS.has(v);
const noteId = (v: unknown): v is string => typeof v === "string" && NOTE_ID.test(v);
const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;

export const isId = id;
export const isInviteSecret = (v: unknown): v is string => typeof v === "string" && SECRET.test(v);
export const isCredential = (v: unknown): v is string => typeof v === "string" && CREDENTIAL.test(v);

export function normalizeName(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const clean = value.trim();
  return text(clean, NAME_MAX, false) ? clean : fallback;
}

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
  /// Para quem: ids de membros, ou `null` para o time inteiro. É o relay que
  /// faz valer — quem está fora não recebe o share, não abre aba, não escreve
  /// e não vê comentário.
  audience: string[] | null;
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
  /// Trecho do transcript que o comentário cita, se cita.
  quote: string | null;
  ts: number;
  /// Conversa e pedaço do transcript a que o comentário pertence. Ausentes
  /// nas notas escritas antes de comentários contextuais.
  tab?: string | null;
  anchor?: string | null;
  /// Respostas ficam planas no storage e apontam para o comentário raiz.
  parent?: string | null;
  /// Só vale na raiz. Ausente significa aberto, para dados antigos.
  resolved?: boolean;
};

/// Um comentário aberto que espera você. `id` é sempre o da raiz. `text` e
/// `tab` são opcionais para caixas gravadas por versões anteriores.
export type Inbox = { id: string; ws: string; author: string; ts: number; tab?: string | null; text?: string };

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
  | { t: "note"; ws: string; tab?: string | null; anchor?: string | null; text: string; mentions: string[]; quote: string | null }
  | { t: "note_reply"; ws: string; note: string; text: string; mentions: string[] }
  | { t: "note_resolve"; ws: string; note: string }
  | { t: "notes"; ws: string }
  | { t: "inbox_read"; id: string };

/// Relay → app.
export type Down =
  | { t: "welcome"; you: string; members: Member[]; shares: Shared[]; inbox: Inbox[]; watching: Watching; comments?: 1 }
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

/// Tetos do que um comentário carrega. Cortados no app antes de sair; o relay
/// recusa o que passar, para um cliente estranho não encher o storage.
export const NOTE_TEXT_MAX = 8 * 1024;
export const NOTE_QUOTE_MAX = 4 * 1024;
export const NOTE_ANCHOR_MAX = 128;

/// Respostas HTTP usadas ao criar um time e ao trocar um convite por uma
/// identidade. `secret` continua no convite; `credential` nunca deve ser
/// compartilhada e é a única prova aceita no WebSocket.
export type Membership = { member: string; credential: string };
export type CreatedTeam = Membership & { team: string; secret: string };
export type EnrollRequest = { secret: string };
export type EnrollResponse = Membership;

export function parseMembership(value: unknown): Membership | null {
  if (!record(value) || !id(value.member) || !isCredential(value.credential)) return null;
  return { member: value.member, credential: value.credential };
}

export function parseCreatedTeam(value: unknown): CreatedTeam | null {
  const membership = parseMembership(value);
  if (!membership || !record(value) || !id(value.team) || !isInviteSecret(value.secret)) return null;
  return { team: value.team, secret: value.secret, ...membership };
}

export function parseShare(value: unknown): Share | null {
  if (!record(value) || !id(value.id)) return null;
  if (!text(value.title, TITLE_MAX) || !text(value.repo_name, TITLE_MAX) || !text(value.branch, TITLE_MAX) || !text(value.stage, TITLE_MAX)) return null;

  let issue: Share["issue"] = null;
  if (value.issue !== null) {
    if (!record(value.issue)) return null;
    if (
      !text(value.issue.identifier, TITLE_MAX, false) ||
      !text(value.issue.title, TITLE_MAX) ||
      !text(value.issue.url, URL_MAX) ||
      !/^https?:\/\/[^\s]+$/i.test(value.issue.url)
    ) return null;
    issue = { identifier: value.issue.identifier, title: value.issue.title, url: value.issue.url };
  }

  if (!Array.isArray(value.tabs) || value.tabs.length > TABS_MAX) return null;
  const tabs: ShareTab[] = [];
  const tabIds = new Set<string>();
  for (const raw of value.tabs) {
    if (!record(raw) || !id(raw.id) || tabIds.has(raw.id) || !text(raw.title, TITLE_MAX)) return null;
    if (typeof raw.status !== "string" || !STATUSES.has(raw.status as Status)) return null;
    if (raw.note !== null && !text(raw.note, TAB_NOTE_MAX)) return null;
    if (raw.tokens !== null && !integer(raw.tokens, 0, Number.MAX_SAFE_INTEGER)) return null;
    tabIds.add(raw.id);
    tabs.push({ id: raw.id, title: raw.title, status: raw.status as Status, note: raw.note as string | null, tokens: raw.tokens as number | null });
  }

  if (value.active !== null && (!id(value.active) || !tabIds.has(value.active))) return null;
  if (!record(value.sizes) || Object.keys(value.sizes).length > tabs.length) return null;
  const sizes: Record<string, [number, number]> = Object.create(null) as Record<string, [number, number]>;
  for (const [tab, size] of Object.entries(value.sizes)) {
    if (!tabIds.has(tab) || !Array.isArray(size) || size.length !== 2 || !integer(size[0], 1, 1_000) || !integer(size[1], 1, 1_000)) return null;
    sizes[tab] = [size[0], size[1]];
  }

  let audience: string[] | null = null;
  if (value.audience !== null && value.audience !== undefined) {
    if (!Array.isArray(value.audience) || value.audience.length > AUDIENCE_MAX || !value.audience.every(id)) return null;
    audience = [...new Set(value.audience)];
  }

  return {
    id: value.id,
    title: value.title,
    repo_name: value.repo_name,
    branch: value.branch,
    stage: value.stage,
    issue,
    active: value.active as string | null,
    tabs,
    sizes,
    audience,
  };
}

/// Decodifica e copia um frame de controle. Nunca devolve o objeto que veio
/// do JSON: assim propriedades inesperadas, getters e valores sem limite não
/// atravessam a fronteira do relay.
export function parseUp(value: unknown): Up | null {
  if (!record(value) || typeof value.t !== "string") return null;
  switch (value.t) {
    case "me":
      return text(value.name, NAME_MAX) ? { t: "me", name: value.name } : null;
    case "share": {
      const share = parseShare(value.share);
      return share ? { t: "share", share } : null;
    }
    case "unshare":
    case "notes":
      return id(value.ws) ? { t: value.t, ws: value.ws } : null;
    case "attach":
      return id(value.ws) && id(value.tab) ? { t: "attach", ws: value.ws, tab: value.tab } : null;
    case "detach":
      return { t: "detach" };
    case "size":
      return id(value.ws) && id(value.tab) && integer(value.cols, 1, 1_000) && integer(value.rows, 1, 1_000)
        ? { t: "size", ws: value.ws, tab: value.tab, cols: value.cols, rows: value.rows }
        : null;
    case "write":
      return id(value.ws) && id(value.tab) && text(value.data, WRITE_MAX)
        ? { t: "write", ws: value.ws, tab: value.tab, data: value.data }
        : null;
    case "note": {
      if (!id(value.ws) || !text(value.text, TEXT_FRAME_MAX) || (value.quote !== null && !text(value.quote, TEXT_FRAME_MAX))) return null;
      if (!Array.isArray(value.mentions) || value.mentions.length > MENTIONS_MAX) return null;
      if (value.tab !== null && value.tab !== undefined && !id(value.tab)) return null;
      if (value.anchor !== null && value.anchor !== undefined && !text(value.anchor, NOTE_ANCHOR_MAX, false)) return null;
      const mentions = value.mentions.filter(id);
      return {
        t: "note",
        ws: value.ws,
        tab: (value.tab as string | null | undefined) ?? null,
        anchor: (value.anchor as string | null | undefined) ?? null,
        text: value.text,
        mentions: [...new Set(mentions)],
        quote: value.quote as string | null,
      };
    }
    case "note_reply": {
      if (!id(value.ws) || !noteId(value.note) || !text(value.text, TEXT_FRAME_MAX)) return null;
      if (!Array.isArray(value.mentions) || value.mentions.length > MENTIONS_MAX) return null;
      const mentions = value.mentions.filter(id);
      return { t: "note_reply", ws: value.ws, note: value.note, text: value.text, mentions: [...new Set(mentions)] };
    }
    case "note_resolve":
      return id(value.ws) && noteId(value.note) ? { t: "note_resolve", ws: value.ws, note: value.note } : null;
    case "inbox_read":
      return noteId(value.id) ? { t: "inbox_read", id: value.id } : null;
    default:
      return null;
  }
}

function parseMembers(value: unknown): Member[] | null {
  if (!Array.isArray(value) || value.length > MEMBERS_MAX) return null;
  const out: Member[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!record(raw) || !id(raw.id) || seen.has(raw.id) || !text(raw.name, NAME_MAX, false) || typeof raw.online !== "boolean") return null;
    seen.add(raw.id);
    out.push({ id: raw.id, name: raw.name, online: raw.online });
  }
  return out;
}

function parseShared(value: unknown): Shared | null {
  const share = parseShare(value);
  if (!share || !record(value) || !id(value.owner) || typeof value.online !== "boolean") return null;
  return { ...share, owner: value.owner, online: value.online };
}

export function parseNote(value: unknown): Note | null {
  if (!record(value) || !noteId(value.id) || !id(value.ws) || !id(value.author)) return null;
  if (!text(value.text, NOTE_TEXT_MAX) || (value.quote !== null && !text(value.quote, NOTE_QUOTE_MAX))) return null;
  if (!Array.isArray(value.mentions) || value.mentions.length > MENTIONS_MAX || !value.mentions.every(id)) return null;
  if (!integer(value.ts, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (value.tab !== undefined && value.tab !== null && !id(value.tab)) return null;
  if (value.anchor !== undefined && value.anchor !== null && !text(value.anchor, NOTE_ANCHOR_MAX, false)) return null;
  if (value.parent !== undefined && value.parent !== null && !noteId(value.parent)) return null;
  if (value.resolved !== undefined && typeof value.resolved !== "boolean") return null;
  return {
    id: value.id,
    ws: value.ws,
    author: value.author,
    text: value.text,
    mentions: [...new Set(value.mentions)],
    quote: value.quote as string | null,
    ts: value.ts,
    tab: (value.tab as string | null | undefined) ?? null,
    anchor: (value.anchor as string | null | undefined) ?? null,
    parent: (value.parent as string | null | undefined) ?? null,
    resolved: value.resolved === true,
  };
}

export function parseInbox(value: unknown): Inbox | null {
  if (!record(value) || !noteId(value.id) || !id(value.ws) || !id(value.author) || !integer(value.ts, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (value.tab !== undefined && value.tab !== null && !id(value.tab)) return null;
  if (value.text !== undefined && !text(value.text, NOTE_TEXT_MAX)) return null;
  return {
    id: value.id,
    ws: value.ws,
    author: value.author,
    ts: value.ts,
    tab: (value.tab as string | null | undefined) ?? null,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
  };
}

function list<T>(value: unknown, max: number, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: T[] = [];
  for (const raw of value) {
    const item = parse(raw);
    if (!item) return null;
    out.push(item);
  }
  return out;
}

function parseWatching(value: unknown): Watching | null {
  if (!record(value) || Object.keys(value).length > SHARES_MAX) return null;
  const out: Watching = Object.create(null) as Watching;
  for (const [ws, rawTabs] of Object.entries(value)) {
    if (!id(ws) || !record(rawTabs) || Object.keys(rawTabs).length > TABS_MAX) return null;
    const tabs: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const [tab, rawMembers] of Object.entries(rawTabs)) {
      if (!id(tab) || !Array.isArray(rawMembers) || rawMembers.length > MEMBERS_MAX || !rawMembers.every(id)) return null;
      tabs[tab] = [...new Set(rawMembers)];
    }
    out[ws] = tabs;
  }
  return out;
}

/// Valida tudo que um relay configurável devolve antes de tocar no estado da
/// webview. Além de evitar exceções, os limites impedem um endpoint estranho
/// de transformar um único frame em estruturas sem teto na memória.
export function parseDown(value: unknown): Down | null {
  if (!record(value) || typeof value.t !== "string") return null;
  switch (value.t) {
    case "welcome": {
      if (!id(value.you)) return null;
      const members = parseMembers(value.members);
      const shares = list(value.shares, SHARES_MAX, parseShared);
      const inbox = list(value.inbox, INBOX_MAX, parseInbox);
      const watching = parseWatching(value.watching);
      if (value.comments !== undefined && value.comments !== 1) return null;
      return members && shares && inbox && watching
        ? { t: "welcome", you: value.you, members, shares, inbox, watching, ...(value.comments === 1 ? { comments: 1 as const } : {}) }
        : null;
    }
    case "presence": {
      const members = parseMembers(value.members);
      return members ? { t: "presence", members } : null;
    }
    case "share": {
      const share = parseShared(value.share);
      return share ? { t: "share", share } : null;
    }
    case "unshare":
      return id(value.ws) ? { t: "unshare", ws: value.ws } : null;
    case "watch": {
      if (!id(value.ws) || !id(value.tab)) return null;
      if (!Array.isArray(value.members) || value.members.length > MEMBERS_MAX || !value.members.every(id)) return null;
      if (!Array.isArray(value.added) || value.added.length > MEMBERS_MAX || !value.added.every(id)) return null;
      return { t: "watch", ws: value.ws, tab: value.tab, members: [...new Set(value.members)], added: [...new Set(value.added)] };
    }
    case "write":
      return id(value.ws) && id(value.tab) && id(value.from) && text(value.data, WRITE_MAX)
        ? { t: "write", ws: value.ws, tab: value.tab, data: value.data, from: value.from }
        : null;
    case "size":
      return id(value.ws) && id(value.tab) && integer(value.cols, 1, 1_000) && integer(value.rows, 1, 1_000)
        ? { t: "size", ws: value.ws, tab: value.tab, cols: value.cols, rows: value.rows }
        : null;
    case "note": {
      const note = parseNote(value.note);
      return note ? { t: "note", note } : null;
    }
    case "notes": {
      if (!id(value.ws)) return null;
      const items = list(value.items, NOTES_PER_WORKSPACE_MAX, parseNote);
      return items && items.every((note) => note.ws === value.ws) ? { t: "notes", ws: value.ws, items } : null;
    }
    case "inbox": {
      const items = list(value.items, INBOX_MAX, parseInbox);
      return items ? { t: "inbox", items } : null;
    }
    case "error":
      return id(value.code) ? { t: "error", code: value.code } : null;
    default:
      return null;
  }
}

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
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function decodeId(bytes: Uint8Array): string | null {
  try {
    const value = dec.decode(bytes);
    return id(value) ? value : null;
  } catch {
    return null;
  }
}

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
  if (buf.length > BINARY_FRAME_MAX) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 2) return null;
  const n = buf[1];
  if (n === 0 || buf.length < 2 + n) return null;
  const tab = decodeId(buf.subarray(2, 2 + n));
  if (!tab) return null;
  let at = 2 + n;
  if (buf[0] === LIVE) {
    if (buf.length < at + 2) return null;
    const k = view.getUint16(at);
    if (k === 0 || k > BINARY_SEGMENTS_MAX) return null;
    at += 2;
    if (buf.length < at + k * 12) return null;
    const heads: [number, number][] = [];
    for (let i = 0; i < k; i++) {
      const seq = getU64(view, at);
      const len = view.getUint32(at + 8);
      if (!Number.isSafeInteger(seq)) return null;
      heads.push([seq, len]);
      at += 12;
    }
    const segments: Segment[] = [];
    for (const [seq, len] of heads) {
      if (buf.length < at + len) return null;
      segments.push({ seq, bytes: buf.subarray(at, at + len) });
      at += len;
    }
    if (at !== buf.length) return null;
    return { kind: LIVE, tab, segments };
  }
  if (buf[0] === SNAPSHOT) {
    if (buf.length < at + 1) return null;
    const m = buf[at];
    if (m === 0 || buf.length < at + 1 + m + 9) return null;
    const to = decodeId(buf.subarray(at + 1, at + 1 + m));
    if (!to) return null;
    at += 1 + m;
    const seq = getU64(view, at);
    if (!Number.isSafeInteger(seq) || (buf[at + 8] !== 0 && buf[at + 8] !== 1)) return null;
    return { kind: SNAPSHOT, tab, to, seq, more: buf[at + 8] === 1, bytes: buf.subarray(at + 9) };
  }
  return null;
}

/* ---------- convite ---------- */

/// `pm2.<time>.<segredo>`: o `pm2` é a versão com matrícula individual, para
/// um código velho ser
/// recusado com um erro claro em vez de conectar em lugar nenhum.
export function formatInvite(team: string, secret: string): string {
  return `pm2.${team}.${secret}`;
}

export function parseInvite(code: string): { team: string; secret: string } | null {
  const m = /^pm2\.([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{16,128})$/.exec(code.trim());
  return m ? { team: m[1], secret: m[2] } : null;
}
