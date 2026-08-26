import { invoke } from "@tauri-apps/api/core";
import { PROTO, formatInvite, parseInvite, type Down, type Inbox, type Member, type Shared, type Up, type Watching } from "../relay/src/protocol";
import { t } from "./i18n";

/// O time: a conexão com o relay e o que ele conta — quem está online, o que
/// está compartilhado, a caixa de notas. Vive aqui, no front, e não no Rust,
/// porque tudo de que o compartilhamento precisa já passa por aqui: os bytes
/// de todo terminal chegam pelo evento `pty`, e escrever num terminal é um
/// `invoke`. O back só guarda o `team.json`.
///
/// Uma conexão por app, sempre de pé enquanto houver time: cai, volta sozinha
/// com espera crescente; o `welcome` que o relay manda ao conectar é a verdade
/// e refaz o estado inteiro.

export type TeamConfig = {
  /// URL do relay quando não é a padrão do app.
  relay: string | null;
  team: string;
  secret: string;
  /// Quem você é para o time — nasce com o time e não muda.
  member: string;
  name: string;
};

export type Phase = "off" | "connecting" | "online";

/// O relay que `npm run relay:deploy` publicou. Vazio enquanto não há um: aí
/// só entra quem informar o seu em Configurações (ou `VITE_RELAY` no dev).
const RELAY = "";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

/* ---------- o que fala com o mundo ---------- */

/// O suficiente de um WebSocket para o mock do navegador fingir um.
export type SocketLike = {
  binaryType: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

export type Transport = {
  socket: (url: string) => SocketLike;
  create: (relay: string) => Promise<{ team: string; secret: string }>;
  /// O mock não tem relay nenhum e não precisa de URL.
  needsRelay: boolean;
};

let transport: Transport = {
  socket: (url) => new WebSocket(url) as unknown as SocketLike,
  create: async (relay) => {
    let r: Response;
    try {
      r = await fetch(`${httpUrl(relay)}/teams`, { method: "POST" });
    } catch (e) {
      throw t("err.team.relay", { cause: String(e) });
    }
    if (!r.ok) throw t("err.team.relay", { cause: `HTTP ${r.status}` });
    return (await r.json()) as { team: string; secret: string };
  },
  needsRelay: true,
};

export function useTransport(next: Transport) {
  transport = next;
}

/* ---------- estado ---------- */

let cfg: TeamConfig | null = null;
let defaultName = "";
/// Relay digitado antes de haver time — vai para o `team.json` quando houver.
let relayDraft = "";
let phase: Phase = "off";
let sock: SocketLike | null = null;
let you: string | null = null;
let members: Member[] = [];
let shares = new Map<string, Shared>();
let inbox: Inbox[] = [];
let watching: Watching = {};
let attempt = 0;
let retry = 0;
let pinger = 0;

const listeners = new Set<() => void>();
export const onChange = (cb: () => void) => void listeners.add(cb);
const changed = () => listeners.forEach((cb) => cb());

export type TeamStatus = {
  config: TeamConfig | null;
  phase: Phase;
  you: string | null;
  members: Member[];
  defaultName: string;
  /// O que está escrito como relay (vazio é "o padrão"), o padrão, e o que
  /// vale de fato.
  relay: string;
  relayDefault: string;
  relayEffective: string;
};

export const status = (): TeamStatus => ({
  config: cfg,
  phase,
  you,
  members,
  defaultName,
  relay: cfg ? (cfg.relay ?? "") : relayDraft,
  relayDefault: env?.VITE_RELAY || RELAY,
  relayEffective: relayOf(cfg),
});

export const nameOf = (member: string) => members.find((m) => m.id === member)?.name ?? member.slice(0, 8);
export const invite = () => (cfg ? formatInvite(cfg.team, cfg.secret) : null);
export const sharesOf = () => shares;
export const inboxItems = () => inbox;
export const watchingMine = () => watching;

/* ---------- ciclo de vida ---------- */

export async function init() {
  try {
    const file = await invoke<{ config: TeamConfig | null; default_name: string }>("team_config");
    cfg = file.config;
    defaultName = file.default_name;
  } catch {
    // Sem back (ou back velho) não há time; a tela segue de pé.
  }
  if (cfg) connect();
}

/// O relay que vale para uma configuração: o dela, o do ambiente de dev, o
/// padrão do app — e, no mock do navegador, um endereço qualquer, porque lá
/// não há relay e o socket é fingido.
const relayOf = (c: TeamConfig | null) =>
  (c ? c.relay || "" : relayDraft) || env?.VITE_RELAY || RELAY || (transport.needsRelay ? "" : "ws://mock");

/// `https://x` vira `wss://x`, `http://x` vira `ws://x`; `ws(s)://` fica.
function wsUrl(relay: string): string {
  return relay.replace(/^http/, "ws").replace(/\/+$/, "");
}
function httpUrl(relay: string): string {
  return relay.replace(/^ws/, "http").replace(/\/+$/, "");
}

function connect() {
  if (!cfg) return;
  const base = relayOf(cfg);
  if (!base) {
    phase = "off";
    changed();
    return;
  }
  const c = cfg;
  phase = "connecting";
  changed();
  const url = `${wsUrl(base)}/team/${c.team}?s=${c.secret}&m=${c.member}&n=${encodeURIComponent(c.name)}&p=${PROTO}`;
  const s = transport.socket(url);
  s.binaryType = "arraybuffer";
  sock = s;
  s.onopen = () => {
    attempt = 0;
    // O edge derruba socket parado; o relay responde sem acordar.
    pinger = setInterval(() => s.send("ping"), 30_000);
  };
  s.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      if (ev.data === "pong") return;
      let frame: Down;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      handle(frame);
    } else if (ev.data instanceof ArrayBuffer) {
      binary(ev.data);
    }
  };
  s.onclose = () => {
    if (sock !== s) return;
    sock = null;
    clearInterval(pinger);
    members = members.map((m) => ({ ...m, online: false }));
    for (const sh of shares.values()) sh.online = false;
    phase = cfg ? "connecting" : "off";
    changed();
    if (cfg) retry = setTimeout(connect, backoff());
  };
  s.onerror = () => {
    // O `close` vem logo atrás, e é ele que remarca.
  };
}

/// 1 s, 2 s, 4 s… até 30 s, com um pouco de acaso para dois apps do mesmo
/// time não baterem no relay no mesmo instante.
function backoff(): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt++);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function disconnect() {
  clearTimeout(retry);
  clearInterval(pinger);
  const s = sock;
  sock = null;
  s?.close();
  phase = "off";
}

function send(frame: Up) {
  if (!sock || phase !== "online") return false;
  sock.send(JSON.stringify(frame));
  return true;
}

/* ---------- o que chega ---------- */

function handle(frame: Down) {
  switch (frame.t) {
    case "welcome":
      you = frame.you;
      members = frame.members;
      shares = new Map(frame.shares.map((s) => [s.id, s]));
      inbox = frame.inbox;
      watching = frame.watching;
      phase = "online";
      break;
    case "presence":
      members = frame.members;
      break;
    case "share":
      shares.set(frame.share.id, frame.share);
      break;
    case "unshare":
      shares.delete(frame.ws);
      break;
    case "inbox":
      inbox = frame.items;
      break;
    case "error":
      fail?.(t(`err.team.${frame.code}` as Parameters<typeof t>[0]));
      return;
    default:
      return;
  }
  changed();
}

function binary(_data: ArrayBuffer) {
  // Bytes de terminal: quem trata é o compartilhamento, quando houver.
}

let fail: ((text: string) => void) | null = null;
export const onError = (cb: (text: string) => void) => void (fail = cb);

/* ---------- ações ---------- */

async function adopt(next: TeamConfig) {
  await invoke("team_config_set", { config: next });
  disconnect();
  cfg = next;
  you = null;
  members = [];
  shares = new Map();
  inbox = [];
  attempt = 0;
  connect();
  changed();
}

const cleanName = (name: string) => {
  const n = name.trim();
  if (!n) throw t("err.team.name");
  return n;
};

export async function create(name: string) {
  const n = cleanName(name);
  const base = relayOf(null);
  if (!base) throw t("err.team.noRelay");
  const { team, secret } = await transport.create(base);
  await adopt({ relay: relayDraft || null, team, secret, member: crypto.randomUUID(), name: n });
}

export async function join(code: string, name: string) {
  const n = cleanName(name);
  const parsed = parseInvite(code);
  if (!parsed) throw t("err.team.badCode");
  await adopt({ relay: relayDraft || null, team: parsed.team, secret: parsed.secret, member: crypto.randomUUID(), name: n });
}

export async function leave() {
  disconnect();
  cfg = null;
  you = null;
  members = [];
  shares = new Map();
  inbox = [];
  watching = {};
  await invoke("team_config_set", { config: null });
  changed();
}

export async function setName(name: string) {
  if (!cfg) return;
  const n = cleanName(name);
  cfg = { ...cfg, name: n };
  await invoke("team_config_set", { config: cfg });
  send({ t: "me", name: n });
  changed();
}

export async function setRelay(url: string) {
  const u = url.trim().replace(/\/+$/, "");
  relayDraft = u;
  if (cfg) {
    cfg = { ...cfg, relay: u || null };
    await invoke("team_config_set", { config: cfg });
    disconnect();
    attempt = 0;
    connect();
  }
  changed();
}
