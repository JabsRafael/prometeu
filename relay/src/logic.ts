/// O time inteiro, sem tubulação: quem está conectado, o que está
/// compartilhado, quem olha o quê, as notas e a caixa de cada um. `reduce`
/// recebe um evento e devolve o que fazer — mandar frame, gravar chave — e é
/// isso que o teste exercita. O Durable Object (`room.ts`) só converte
/// WebSocket em evento e efeito em `send`/`storage`.
///
/// O estado vive em memória e é reconstruído do storage quando o objeto acorda
/// (`room.ts`); os sockets vêm da própria plataforma, com o membro e a aba que
/// cada um olha guardados junto do socket (`serializeAttachment`).

import type { Down, Inbox, Member, Note, Share, Shared, Up, Watching } from "./protocol";
import { decodeBinary, LIVE, NOTE_QUOTE_MAX, NOTE_TEXT_MAX, SNAPSHOT } from "./protocol";

export type Attached = { ws: string; tab: string } | null;
export type Sock = { id: string; member: string; attached: Attached };
export type Entry = { share: Share; owner: string; online: boolean };

export type State = {
  members: Map<string, { name: string; last_seen: number }>;
  socks: Map<string, Sock>;
  shares: Map<string, Entry>;
  /// Por workspace, na ordem em que foram escritas.
  notes: Map<string, Note[]>;
  /// Por membro: o que menciona ele e ele ainda não abriu.
  inbox: Map<string, Inbox[]>;
};

export const empty = (): State => ({
  members: new Map(),
  socks: new Map(),
  shares: new Map(),
  notes: new Map(),
  inbox: new Map(),
});

export type Event =
  | { k: "open"; sock: string; member: string; name: string; now: number }
  | { k: "close"; sock: string; now: number }
  | { k: "text"; sock: string; frame: Up; now: number; rand: string }
  | { k: "binary"; sock: string; data: Uint8Array };

export type Effect =
  | { e: "send"; sock: string; frame: Down }
  | { e: "sendBinary"; sock: string; data: Uint8Array }
  /// O socket passou a olhar outra aba (ou nenhuma): vai para o attachment.
  | { e: "attachment"; sock: string; member: string; attached: Attached }
  | { e: "put"; key: string; value: unknown }
  | { e: "del"; key: string };

/* ---------- leituras ---------- */

const online = (s: State, member: string) => [...s.socks.values()].some((k) => k.member === member);

export function members(s: State): Member[] {
  return [...s.members].map(([id, m]) => ({ id, name: m.name, online: online(s, id) }));
}

const socksOf = (s: State, member: string) =>
  [...s.socks.values()].filter((k) => k.member === member).map((k) => k.id);

const shared = (e: Entry): Shared => ({ ...e.share, owner: e.owner, online: e.online });

/// Sockets olhando uma aba.
const attachedTo = (s: State, ws: string, tab: string) =>
  [...s.socks.values()].filter((k) => k.attached?.ws === ws && k.attached.tab === tab);

/// Membros olhando uma aba, cada um uma vez.
const watchers = (s: State, ws: string, tab: string) => [...new Set(attachedTo(s, ws, tab).map((k) => k.member))];

/// O que o dono precisa saber ao chegar: quem já estava olhando cada aba sua.
function watching(s: State, owner: string): Watching {
  const out: Watching = {};
  for (const [ws, e] of s.shares) {
    if (e.owner !== owner) continue;
    for (const tab of e.share.tabs) {
      const who = watchers(s, ws, tab.id);
      if (who.length) (out[ws] ??= {})[tab.id] = who;
    }
  }
  return out;
}

function byTab(s: State, tab: string): [string, Entry] | null {
  for (const pair of s.shares) {
    if (pair[1].share.tabs.some((t) => t.id === tab)) return pair;
  }
  return null;
}

/* ---------- escritas ---------- */

const broadcast = (s: State, frame: Down): Effect[] => [...s.socks.keys()].map((sock) => ({ e: "send", sock, frame }));

const toMember = (s: State, member: string, frame: Down): Effect[] =>
  socksOf(s, member).map((sock) => ({ e: "send", sock, frame }));

const error = (sock: string, code: string): Effect[] => [{ e: "send", sock, frame: { t: "error", code } }];

/// Quem olha uma aba mudou: o dono fica sabendo, e `added` é quem acabou de
/// chegar — para ele mandar a rolagem inteira só a esse.
function watchChanged(s: State, at: { ws: string; tab: string }, added: string[] = []): Effect[] {
  const e = s.shares.get(at.ws);
  if (!e) return [];
  return toMember(s, e.owner, { t: "watch", ws: at.ws, tab: at.tab, members: watchers(s, at.ws, at.tab), added });
}

function setAttached(sock: Sock, attached: Attached): Effect {
  sock.attached = attached;
  return { e: "attachment", sock: sock.id, member: sock.member, attached };
}

export function reduce(s: State, ev: Event): Effect[] {
  switch (ev.k) {
    case "open": {
      const known = s.members.get(ev.member);
      const name = ev.name.trim() || known?.name || ev.member.slice(0, 8);
      s.members.set(ev.member, { name, last_seen: ev.now });
      s.socks.set(ev.sock, { id: ev.sock, member: ev.member, attached: null });
      // O dono voltou: o que ele compartilhava volta a estar de pé antes de
      // ele reanunciar nada. Sem isto o card do colega ficava dizendo
      // "offline" com o terminal andando atrás — e digitar não funcionava.
      const woke: Effect[] = [];
      for (const [ws, e] of s.shares) {
        if (e.owner !== ev.member || e.online) continue;
        e.online = true;
        woke.push({ e: "put", key: `share:${ws}`, value: e }, ...broadcast(s, { t: "share", share: shared(e) }));
      }
      const presence: Down = { t: "presence", members: members(s) };
      return [
        { e: "put", key: `member:${ev.member}`, value: { id: ev.member, name, last_seen: ev.now } },
        {
          e: "send",
          sock: ev.sock,
          frame: {
            t: "welcome",
            you: ev.member,
            members: presence.members,
            shares: [...s.shares.values()].map(shared),
            inbox: s.inbox.get(ev.member) ?? [],
            watching: watching(s, ev.member),
          },
        },
        ...woke,
        ...[...s.socks.keys()].filter((k) => k !== ev.sock).map((sock): Effect => ({ e: "send", sock, frame: presence })),
      ];
    }

    case "close": {
      const sock = s.socks.get(ev.sock);
      if (!sock) return [];
      s.socks.delete(ev.sock);
      const out: Effect[] = [];
      if (sock.attached) out.push(...watchChanged(s, sock.attached));
      if (!online(s, sock.member)) {
        const m = s.members.get(sock.member);
        if (m) {
          m.last_seen = ev.now;
          out.push({ e: "put", key: `member:${sock.member}`, value: { id: sock.member, ...m } });
        }
        // O dono foi embora: o que ele compartilhava continua na lista, mas
        // parado — ninguém mais vai receber byte nenhum até ele voltar.
        for (const [ws, e] of s.shares) {
          if (e.owner !== sock.member || !e.online) continue;
          e.online = false;
          out.push({ e: "put", key: `share:${ws}`, value: e }, ...broadcast(s, { t: "share", share: shared(e) }));
        }
      }
      out.push(...broadcast(s, { t: "presence", members: members(s) }));
      return out;
    }

    case "binary": {
      const sock = s.socks.get(ev.sock);
      const bin = decodeBinary(ev.data);
      if (!sock || !bin) return [];
      const found = byTab(s, bin.tab);
      // Só o dono da aba transmite; o resto é descartado calado, que é o que se
      // faz com bytes de quem não devia estar mandando.
      if (!found || found[1].owner !== sock.member) return [];
      const [ws] = found;
      const targets = attachedTo(s, ws, bin.tab).filter((k) => k.id !== sock.id);
      if (bin.kind === LIVE) {
        return targets.map((k): Effect => ({ e: "sendBinary", sock: k.id, data: ev.data }));
      }
      if (bin.kind === SNAPSHOT) {
        return targets.filter((k) => k.member === bin.to).map((k): Effect => ({ e: "sendBinary", sock: k.id, data: ev.data }));
      }
      return [];
    }

    case "text":
      return text(s, ev);
  }
}

function text(s: State, ev: Extract<Event, { k: "text" }>): Effect[] {
  const sock = s.socks.get(ev.sock);
  if (!sock) return [];
  const me = sock.member;
  const f = ev.frame;
  if (!f || typeof f !== "object" || typeof f.t !== "string") return error(sock.id, "bad");

  switch (f.t) {
    case "me": {
      const name = String(f.name ?? "").trim();
      if (!name) return error(sock.id, "empty");
      const m = s.members.get(me);
      if (!m) return [];
      m.name = name;
      return [
        { e: "put", key: `member:${me}`, value: { id: me, ...m } },
        ...broadcast(s, { t: "presence", members: members(s) }),
      ];
    }

    case "share": {
      const share = f.share;
      if (!share || typeof share.id !== "string" || !Array.isArray(share.tabs)) return error(sock.id, "bad");
      const had = s.shares.get(share.id);
      if (had && had.owner !== me) return error(sock.id, "owner");
      const e: Entry = { share, owner: me, online: true };
      s.shares.set(share.id, e);
      return [{ e: "put", key: `share:${share.id}`, value: e }, ...broadcast(s, { t: "share", share: shared(e) })];
    }

    case "unshare": {
      const e = s.shares.get(f.ws);
      if (!e) return [];
      if (e.owner !== me) return error(sock.id, "owner");
      s.shares.delete(f.ws);
      const out: Effect[] = [{ e: "del", key: `share:${f.ws}` }];
      // Quem olhava fica olhando o nada: solta, para o dono que compartilhar
      // de novo não achar espectador fantasma.
      for (const k of s.socks.values()) {
        if (k.attached?.ws === f.ws) out.push(setAttached(k, null));
      }
      out.push(...broadcast(s, { t: "unshare", ws: f.ws }));
      return out;
    }

    case "attach": {
      const e = s.shares.get(f.ws);
      if (!e) return error(sock.id, "noShare");
      if (!e.share.tabs.some((t) => t.id === f.tab)) return error(sock.id, "noTab");
      const prev = sock.attached;
      if (prev?.ws === f.ws && prev.tab === f.tab) return [];
      const already = watchers(s, f.ws, f.tab).includes(me);
      const out: Effect[] = [setAttached(sock, { ws: f.ws, tab: f.tab })];
      if (prev) out.push(...watchChanged(s, prev));
      out.push(...watchChanged(s, { ws: f.ws, tab: f.tab }, already ? [] : [me]));
      return out;
    }

    case "detach": {
      const prev = sock.attached;
      if (!prev) return [];
      return [setAttached(sock, null), ...watchChanged(s, prev)];
    }

    case "size": {
      const e = s.shares.get(f.ws);
      if (!e || e.owner !== me) return error(sock.id, "owner");
      const cols = Number(f.cols);
      const rows = Number(f.rows);
      if (!(cols > 0 && rows > 0)) return error(sock.id, "bad");
      e.share.sizes[f.tab] = [cols, rows];
      const frame: Down = { t: "size", ws: f.ws, tab: f.tab, cols, rows };
      return [
        { e: "put", key: `share:${f.ws}`, value: e },
        ...attachedTo(s, f.ws, f.tab).map((k): Effect => ({ e: "send", sock: k.id, frame })),
      ];
    }

    case "write": {
      const e = s.shares.get(f.ws);
      if (!e) return error(sock.id, "noShare");
      if (!e.online) return error(sock.id, "offline");
      if (typeof f.data !== "string") return error(sock.id, "bad");
      return toMember(s, e.owner, { t: "write", ws: f.ws, tab: f.tab, data: f.data, from: me });
    }

    case "note": {
      const textBody = String(f.text ?? "").trim();
      const quote = f.quote == null ? null : String(f.quote);
      if (!textBody) return error(sock.id, "empty");
      if (textBody.length > NOTE_TEXT_MAX || (quote?.length ?? 0) > NOTE_QUOTE_MAX) return error(sock.id, "tooBig");
      if (typeof f.ws !== "string" || !f.ws) return error(sock.id, "bad");
      // Menção só a quem existe, e nunca a si mesmo — a nota já é sua.
      const mentions = [...new Set((Array.isArray(f.mentions) ? f.mentions : []).map(String))].filter(
        (m) => m !== me && s.members.has(m),
      );
      const note: Note = {
        id: `${ev.now}-${ev.rand}`,
        ws: f.ws,
        author: me,
        text: textBody,
        mentions,
        quote,
        ts: ev.now,
      };
      const list = s.notes.get(f.ws) ?? [];
      list.push(note);
      s.notes.set(f.ws, list);
      const out: Effect[] = [
        { e: "put", key: `note:${f.ws}:${note.id}`, value: note },
        ...broadcast(s, { t: "note", note }),
      ];
      for (const m of mentions) {
        const item: Inbox = { id: note.id, ws: f.ws, author: me, ts: ev.now };
        const box = s.inbox.get(m) ?? [];
        box.push(item);
        s.inbox.set(m, box);
        out.push({ e: "put", key: `inbox:${m}:${note.id}`, value: item }, ...toMember(s, m, { t: "inbox", items: box }));
      }
      return out;
    }

    case "notes":
      return [{ e: "send", sock: sock.id, frame: { t: "notes", ws: f.ws, items: s.notes.get(f.ws) ?? [] } }];

    case "inbox_read": {
      const box = s.inbox.get(me) ?? [];
      const at = box.findIndex((i) => i.id === f.id);
      if (at === -1) return [];
      box.splice(at, 1);
      return [{ e: "del", key: `inbox:${me}:${f.id}` }, ...toMember(s, me, { t: "inbox", items: box })];
    }
  }
  return error(sock.id, "bad");
}

/* ---------- storage → estado ---------- */

/// O que o objeto lê ao acordar. As chaves são as mesmas que os efeitos
/// `put`/`del` escrevem; os sockets não entram aqui, vêm da plataforma.
export function hydrate(rows: Iterable<[string, unknown]>, socks: Sock[]): State {
  const s = empty();
  for (const [key, value] of rows) {
    const v = value as Record<string, unknown>;
    if (key.startsWith("member:")) {
      s.members.set(key.slice("member:".length), { name: String(v.name ?? ""), last_seen: Number(v.last_seen ?? 0) });
    } else if (key.startsWith("share:")) {
      const e = v as unknown as Entry;
      s.shares.set(key.slice("share:".length), { share: e.share, owner: e.owner, online: false });
    } else if (key.startsWith("note:")) {
      const n = v as unknown as Note;
      const list = s.notes.get(n.ws) ?? [];
      list.push(n);
      s.notes.set(n.ws, list);
    } else if (key.startsWith("inbox:")) {
      const member = key.split(":")[1];
      const box = s.inbox.get(member) ?? [];
      box.push(v as unknown as Inbox);
      s.inbox.set(member, box);
    }
  }
  // `list` devolve em ordem de chave, e o id da nota começa pelo instante —
  // mas ordenar aqui é barato e não depende disso.
  for (const list of s.notes.values()) list.sort((a, b) => a.ts - b.ts);
  for (const box of s.inbox.values()) box.sort((a, b) => a.ts - b.ts);
  for (const k of socks) s.socks.set(k.id, k);
  // Share cujo dono está conectado agora está de pé — ele vai reanunciar de
  // qualquer jeito, mas até lá o card não pode dizer "offline" à toa.
  for (const e of s.shares.values()) e.online = online(s, e.owner);
  return s;
}
