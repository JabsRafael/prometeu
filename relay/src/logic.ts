/// O time inteiro, sem tubulação: quem está conectado, o que está
/// compartilhado, quem olha o quê, as notas e a caixa de cada um. `reduce`
/// recebe um evento e devolve o que fazer — mandar frame, gravar chave — e é
/// isso que o teste exercita. O Durable Object (`room.ts`) só converte
/// WebSocket em evento e efeito em `send`/`storage`.
///
/// O estado vive em memória e é reconstruído do storage quando o objeto acorda
/// (`room.ts`); os sockets vêm da própria plataforma, com o membro e a aba que
/// cada um olha guardados junto do socket (`serializeAttachment`).

import type { Down, Inbox, Member, Note, Share, Shared, Watching } from "./protocol";
import {
  decodeBinary,
  INBOX_MAX,
  isId,
  LIVE,
  normalizeName,
  NOTES_PER_WORKSPACE_MAX,
  NOTES_TOTAL_MAX,
  NOTE_TTL_MS,
  NOTE_QUOTE_MAX,
  NOTE_TEXT_MAX,
  parseShare,
  parseUp,
  SHARES_MAX,
  SNAPSHOT,
} from "./protocol";

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
  | { k: "text"; sock: string; frame: unknown; now: number; rand: string }
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

/// Este membro vê este share? O dono sempre; o resto, se a audiência é o time
/// inteiro (`null`) ou o inclui.
const canSee = (e: Entry, member: string) => e.owner === member || !e.share.audience || e.share.audience.includes(member);

const visibleTo = (s: State, ws: string, member: string) => {
  const e = s.shares.get(ws);
  return !!e && canSee(e, member);
};

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

/// Só a quem vê o share; workspace inexistente não tem audiência.
const toAudience = (s: State, ws: string, frame: Down): Effect[] =>
  [...s.socks.values()].filter((k) => visibleTo(s, ws, k.member)).map((k) => ({ e: "send", sock: k.id, frame }));

const toMember = (s: State, member: string, frame: Down): Effect[] =>
  socksOf(s, member).map((sock) => ({ e: "send", sock, frame }));

const error = (sock: string, code: string): Effect[] => [{ e: "send", sock, frame: { t: "error", code } }];

const noteKey = (n: Pick<Note, "ws" | "id">) => `note:${n.ws}:${n.id}`;
const inboxKey = (member: string, id: string) => `inbox:${member}:${id}`;

/// Expira conteúdo que tem custo linear no storage. Roda antes do welcome e
/// das escritas; os `del` tornam a limpeza persistente quando o objeto acorda.
function prune(s: State, now: number): Effect[] {
  const out: Effect[] = [];
  const cutoff = now - NOTE_TTL_MS;
  const all: Note[] = [];
  for (const [ws, list] of s.notes) {
    const keep = list.filter((n) => n.ts >= cutoff);
    for (const n of list) if (n.ts < cutoff) out.push({ e: "del", key: noteKey(n) });
    if (keep.length) {
      keep.sort((a, b) => a.ts - b.ts);
      s.notes.set(ws, keep);
      all.push(...keep);
    } else {
      s.notes.delete(ws);
    }
  }

  // Hydrate também pode encontrar storage escrito por uma versão antiga.
  // Conserva os mais novos e apaga o excesso em vez de carregá-lo para sempre.
  all.sort((a, b) => b.ts - a.ts);
  const allowed = new Set(all.slice(0, NOTES_TOTAL_MAX).map((n) => `${n.ws}\0${n.id}`));
  for (const [ws, list] of s.notes) {
    const keep = list.filter((n) => allowed.has(`${n.ws}\0${n.id}`)).slice(-NOTES_PER_WORKSPACE_MAX);
    const keepIds = new Set(keep.map((n) => n.id));
    for (const n of list) if (!keepIds.has(n.id)) out.push({ e: "del", key: noteKey(n) });
    if (keep.length) s.notes.set(ws, keep);
    else s.notes.delete(ws);
  }

  const liveNotes = new Set([...s.notes.values()].flat().map((n) => `${n.ws}\0${n.id}`));
  for (const [member, box] of s.inbox) {
    const keep = box.filter((i) => i.ts >= cutoff && liveNotes.has(`${i.ws}\0${i.id}`)).slice(-INBOX_MAX);
    const keepIds = new Set(keep.map((i) => i.id));
    for (const item of box) if (!keepIds.has(item.id)) out.push({ e: "del", key: inboxKey(member, item.id) });
    if (keep.length) s.inbox.set(member, keep);
    else s.inbox.delete(member);
  }
  return out;
}

function purgeNotes(s: State, ws: string): Effect[] {
  const out: Effect[] = [];
  for (const note of s.notes.get(ws) ?? []) out.push({ e: "del", key: noteKey(note) });
  s.notes.delete(ws);
  for (const [member, box] of s.inbox) {
    const removed = box.filter((item) => item.ws === ws);
    if (!removed.length) continue;
    const keep = box.filter((item) => item.ws !== ws);
    if (keep.length) s.inbox.set(member, keep);
    else s.inbox.delete(member);
    for (const item of removed) out.push({ e: "del", key: inboxKey(member, item.id) });
    out.push(...toMember(s, member, { t: "inbox", items: keep }));
  }
  return out;
}

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
      const cleanup = prune(s, ev.now);
      const known = s.members.get(ev.member);
      const name = normalizeName(ev.name, known?.name || ev.member.slice(0, 8));
      s.members.set(ev.member, { name, last_seen: ev.now });
      s.socks.set(ev.sock, { id: ev.sock, member: ev.member, attached: null });
      // O dono voltou: o que ele compartilhava volta a estar de pé antes de
      // ele reanunciar nada. Sem isto o card do colega ficava dizendo
      // "offline" com o terminal andando atrás — e digitar não funcionava.
      const woke: Effect[] = [];
      for (const [ws, e] of s.shares) {
        if (e.owner !== ev.member || e.online) continue;
        e.online = true;
        woke.push({ e: "put", key: `share:${ws}`, value: e }, ...toAudience(s, ws, { t: "share", share: shared(e) }));
      }
      const presence: Down = { t: "presence", members: members(s) };
      return [
        ...cleanup,
        { e: "put", key: `member:${ev.member}`, value: { id: ev.member, name, last_seen: ev.now } },
        {
          e: "send",
          sock: ev.sock,
          frame: {
            t: "welcome",
            you: ev.member,
            members: presence.members,
            shares: [...s.shares.values()].filter((e) => canSee(e, ev.member)).map(shared),
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
          out.push({ e: "put", key: `share:${ws}`, value: e }, ...toAudience(s, ws, { t: "share", share: shared(e) }));
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
      return [...prune(s, ev.now), ...text(s, ev)];
  }
}

function text(s: State, ev: Extract<Event, { k: "text" }>): Effect[] {
  const sock = s.socks.get(ev.sock);
  if (!sock) return [];
  const me = sock.member;
  const f = parseUp(ev.frame);
  if (!f) return error(sock.id, "bad");

  switch (f.t) {
    case "me": {
      const name = normalizeName(f.name);
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
      const had = s.shares.get(share.id);
      if (had && had.owner !== me) return error(sock.id, "owner");
      if (!had && s.shares.size >= SHARES_MAX) return error(sock.id, "quota");
      // Uma aba precisa identificar uma conversa sem ambiguidade nos frames
      // binários, que carregam a aba mas não o workspace.
      for (const tab of share.tabs) {
        const found = byTab(s, tab.id);
        if (found && found[0] !== share.id) return error(sock.id, "tabConflict");
      }
      const audience = share.audience?.filter((member) => member !== me && s.members.has(member)) ?? null;
      const e: Entry = { share: { ...share, audience }, owner: me, online: true };
      s.shares.set(share.id, e);
      const out: Effect[] = [{ e: "put", key: `share:${share.id}`, value: e }];
      const detachedFrom: { ws: string; tab: string }[] = [];
      // Quem via e deixou de ver recebe o unshare, e solta a aba se olhava:
      // para ele o workspace sumiu, e é isso que a tela dele deve mostrar.
      for (const k of s.socks.values()) {
        const tabStillExists = !k.attached || k.attached.ws !== share.id || e.share.tabs.some((tab) => tab.id === k.attached?.tab);
        if (canSee(e, k.member) && tabStillExists) {
          out.push({ e: "send", sock: k.id, frame: { t: "share", share: shared(e) } });
          continue;
        }
        if (k.attached?.ws === share.id) {
          detachedFrom.push(k.attached);
          out.push(setAttached(k, null));
        }
        if (had && canSee(had, k.member) && !canSee(e, k.member)) {
          out.push({ e: "send", sock: k.id, frame: { t: "unshare", ws: share.id } });
        } else if (canSee(e, k.member)) {
          out.push({ e: "send", sock: k.id, frame: { t: "share", share: shared(e) } });
        }
      }
      // Caixa de quem perdeu acesso não pode continuar revelando notas do
      // workspace. As notas em si seguem visíveis para a nova audiência.
      for (const [member, box] of s.inbox) {
        if (canSee(e, member)) continue;
        const removed = box.filter((item) => item.ws === share.id);
        if (!removed.length) continue;
        const keep = box.filter((item) => item.ws !== share.id);
        if (keep.length) s.inbox.set(member, keep);
        else s.inbox.delete(member);
        for (const item of removed) out.push({ e: "del", key: inboxKey(member, item.id) });
        out.push(...toMember(s, member, { t: "inbox", items: keep }));
      }
      // O dono ouve de novo quem olha cada aba: quem saiu da audiência saiu
      // da lista.
      for (const at of detachedFrom) out.push(...watchChanged(s, at));
      if (had) {
        for (const tab of e.share.tabs) out.push(...watchChanged(s, { ws: share.id, tab: tab.id }));
      }
      return out;
    }

    case "unshare": {
      const e = s.shares.get(f.ws);
      if (!e) return [];
      if (e.owner !== me) return error(sock.id, "owner");
      s.shares.delete(f.ws);
      const out: Effect[] = [{ e: "del", key: `share:${f.ws}` }, ...purgeNotes(s, f.ws)];
      // Quem olhava fica olhando o nada: solta, para o dono que compartilhar
      // de novo não achar espectador fantasma.
      for (const k of s.socks.values()) {
        if (k.attached?.ws === f.ws) out.push(setAttached(k, null));
      }
      out.push(...[...s.socks.values()].filter((k) => canSee(e, k.member)).map((k): Effect => ({ e: "send", sock: k.id, frame: { t: "unshare", ws: f.ws } })));
      return out;
    }

    case "attach": {
      const e = s.shares.get(f.ws);
      // Fora da audiência é como se não existisse — nem o código do erro
      // conta que existe.
      if (!e || !canSee(e, me)) return error(sock.id, "noShare");
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
      if (!e.share.tabs.some((tab) => tab.id === f.tab)) return error(sock.id, "noTab");
      const cols = f.cols;
      const rows = f.rows;
      e.share.sizes[f.tab] = [cols, rows];
      const frame: Down = { t: "size", ws: f.ws, tab: f.tab, cols, rows };
      return [
        { e: "put", key: `share:${f.ws}`, value: e },
        ...attachedTo(s, f.ws, f.tab).map((k): Effect => ({ e: "send", sock: k.id, frame })),
      ];
    }

    case "write": {
      const e = s.shares.get(f.ws);
      if (!e || !canSee(e, me)) return error(sock.id, "noShare");
      if (!e.share.tabs.some((tab) => tab.id === f.tab)) return error(sock.id, "noTab");
      if (sock.attached?.ws !== f.ws || sock.attached.tab !== f.tab) return error(sock.id, "notAttached");
      if (!e.online) return error(sock.id, "offline");
      return toMember(s, e.owner, { t: "write", ws: f.ws, tab: f.tab, data: f.data, from: me });
    }

    case "note": {
      const textBody = f.text.trim();
      const quote = f.quote;
      if (!textBody) return error(sock.id, "empty");
      if (textBody.length > NOTE_TEXT_MAX || (quote?.length ?? 0) > NOTE_QUOTE_MAX) return error(sock.id, "tooBig");
      const entry = s.shares.get(f.ws);
      if (!entry || !canSee(entry, me)) return error(sock.id, "noShare");
      if ([...s.notes.values()].reduce((total, list) => total + list.length, 0) >= NOTES_TOTAL_MAX) return error(sock.id, "quota");
      // Menção só a quem existe e vê o workspace, e nunca a si mesmo — a nota
      // já é sua. Marcar quem está fora não abre a porta: quem abre é o dono,
      // mudando a audiência.
      const mentions = f.mentions.filter(
        (m) => m !== me && s.members.has(m) && visibleTo(s, f.ws, m),
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
        ...toAudience(s, f.ws, { t: "note", note }),
      ];
      while (list.length > NOTES_PER_WORKSPACE_MAX) {
        const old = list.shift();
        if (!old) continue;
        out.push({ e: "del", key: noteKey(old) });
        for (const [member, box] of s.inbox) {
          const at = box.findIndex((item) => item.ws === old.ws && item.id === old.id);
          if (at === -1) continue;
          box.splice(at, 1);
          out.push({ e: "del", key: inboxKey(member, old.id) }, ...toMember(s, member, { t: "inbox", items: [...box] }));
        }
      }
      for (const m of mentions) {
        const item: Inbox = { id: note.id, ws: f.ws, author: me, ts: ev.now };
        const box = s.inbox.get(m) ?? [];
        box.push(item);
        s.inbox.set(m, box);
        while (box.length > INBOX_MAX) {
          const old = box.shift();
          if (old) out.push({ e: "del", key: inboxKey(m, old.id) });
        }
        out.push({ e: "put", key: inboxKey(m, note.id), value: item }, ...toMember(s, m, { t: "inbox", items: [...box] }));
      }
      return out;
    }

    case "notes":
      if (!visibleTo(s, f.ws, me)) return error(sock.id, "noShare");
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
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    if (key.startsWith("member:")) {
      const member = key.slice("member:".length);
      const name = normalizeName(v.name);
      if (isId(member) && name && typeof v.last_seen === "number" && Number.isFinite(v.last_seen)) {
        s.members.set(member, { name, last_seen: v.last_seen });
      }
    } else if (key.startsWith("share:")) {
      const ws = key.slice("share:".length);
      const share = parseShare(v.share);
      if (
        isId(ws) &&
        share?.id === ws &&
        isId(v.owner) &&
        share.tabs.every((tab) => !byTab(s, tab.id)) &&
        s.shares.size < SHARES_MAX
      ) s.shares.set(ws, { share, owner: v.owner, online: false });
    } else if (key.startsWith("note:")) {
      const parsed = parseUp({ t: "note", ws: v.ws, text: v.text, mentions: v.mentions, quote: v.quote });
      if (
        parsed?.t === "note" &&
        isId(v.id) &&
        isId(v.author) &&
        typeof v.ts === "number" &&
        Number.isFinite(v.ts) &&
        parsed.text.length <= NOTE_TEXT_MAX &&
        (parsed.quote?.length ?? 0) <= NOTE_QUOTE_MAX
      ) {
        const n: Note = { id: v.id, ws: parsed.ws, author: v.author, text: parsed.text, mentions: parsed.mentions, quote: parsed.quote, ts: v.ts };
        if (key !== noteKey(n)) continue;
        const list = s.notes.get(n.ws) ?? [];
        list.push(n);
        s.notes.set(n.ws, list);
      }
    } else if (key.startsWith("inbox:")) {
      const member = key.split(":")[1];
      if (
        isId(member) &&
        isId(v.id) &&
        isId(v.ws) &&
        isId(v.author) &&
        key === inboxKey(member, v.id) &&
        typeof v.ts === "number" &&
        Number.isFinite(v.ts)
      ) {
        const box = s.inbox.get(member) ?? [];
        box.push({ id: v.id, ws: v.ws, author: v.author, ts: v.ts });
        s.inbox.set(member, box);
      }
    }
  }
  // `list` devolve em ordem de chave, e o id da nota começa pelo instante —
  // mas ordenar aqui é barato e não depende disso.
  for (const list of s.notes.values()) list.sort((a, b) => a.ts - b.ts);
  for (const box of s.inbox.values()) box.sort((a, b) => a.ts - b.ts);
  for (const k of socks) {
    const attached = k.attached;
    if (!isId(k.id) || !isId(k.member)) continue;
    const entry = attached && isId(attached.ws) && isId(attached.tab) ? s.shares.get(attached.ws) : null;
    const allowed =
      entry &&
      canSee(entry, k.member) &&
      entry.share.tabs.some((tab) => tab.id === attached?.tab);
    s.socks.set(k.id, {
      ...k,
      // Attachment também é estado persistido. Só restaurar uma audiência
      // que ainda existe evita espectador fantasma depois de hibernar.
      attached: allowed ? attached : null,
    });
  }
  // Share cujo dono está conectado agora está de pé — ele vai reanunciar de
  // qualquer jeito, mas até lá o card não pode dizer "offline" à toa.
  for (const e of s.shares.values()) e.online = online(s, e.owner);
  return s;
}
