/// One Durable Object per team adapts platform WebSockets and storage to the reducer. After hibernation,
/// restore state from storage and recover member/viewed-tab metadata from socket attachments.

import { DurableObject } from "cloudflare:workers";
import { hydrate, reduce, type Effect, type Sock, type State } from "./logic";
import { authorizeOrganization } from "./cloud";
import { smallJson } from "./http";
import {
  BINARY_FRAME_MAX,
  BYTES_PER_WINDOW_MAX,
  FRAMES_PER_WINDOW_MAX,
  isCredential,
  isId,
  isInviteSecret,
  MEMBERS_MAX,
  normalizeName,
  PROTO,
  RATE_WINDOW_MS,
  SOCKETS_MAX,
  SOCKETS_PER_MEMBER_MAX,
  TEXT_FRAME_MAX,
  type EnrollRequest,
  type EnrollResponse,
} from "./protocol";

export type Env = { TEAM: DurableObjectNamespace<TeamRoom>; CLOUD_URL?: string };

type Attachment = { auth: typeof PROTO; sock: string; member: string; attached: Sock["attached"]; expires_at?: number };
type Meta = { invite_hash: string; created_at: number; member_count: number };
type Credential = { hash: string; created_at: number };

const HASH = /^[a-f0-9]{64}$/;
const TEAM_CREATIONS_PER_HOUR_MAX = 10;

export function randomToken(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export class TeamRoom extends DurableObject<Env> {
  private state: State | null = null;
  private bySock = new Map<string, WebSocket>();
  private rates = new Map<string, { since: number; frames: number; bytes: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Automatic heartbeat avoids waking the object; the edge closes idle sockets after roughly 100
    // seconds.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /// Current state, restored from storage and socket attachments when needed.
  private async load(): Promise<State> {
    if (this.state) return this.state;
    const rows = await this.ctx.storage.list<unknown>();
    const socks: Sock[] = [];
    const perMember = new Map<string, number>();
    this.bySock.clear();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att || att.auth !== PROTO || !isId(att.sock) || !isId(att.member) || (att.expires_at !== undefined && att.expires_at <= Date.now())) {
        ws.close(1008, "reauthenticate");
        continue;
      }
      const count = perMember.get(att.member) ?? 0;
      if (socks.length >= SOCKETS_MAX || count >= SOCKETS_PER_MEMBER_MAX || this.bySock.has(att.sock)) {
        ws.close(1008, "socket quota");
        continue;
      }
      socks.push({ id: att.sock, member: att.member, attached: att.attached });
      this.bySock.set(att.sock, ws);
      perMember.set(att.member, count + 1);
    }
    this.state = hydrate([...rows].filter(([k]) => k !== "meta" && !k.startsWith("credential:")), socks);
    return this.state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // The Worker isolates rate limits by IP. This internal route uses a transaction to serialize
    // concurrent requests.
    if (req.method === "POST" && url.pathname === "/permit-create") {
      const hour = Number(url.searchParams.get("h"));
      if (!Number.isSafeInteger(hour) || hour < 0) return new Response("bad", { status: 400 });
      const allowed = await this.ctx.storage.transaction(async (txn) => {
        const saved = await txn.get<{ hour: number; count: number }>("create_rate");
        const current = saved?.hour === hour && Number.isSafeInteger(saved.count) && saved.count >= 0 ? saved.count : 0;
        if (current >= TEAM_CREATIONS_PER_HOUR_MAX) return false;
        await txn.put("create_rate", { hour, count: current + 1 });
        return true;
      });
      return new Response(allowed ? null : "rate limit", { status: allowed ? 204 : 429 });
    }

    // The Worker initializes the invite hash once. Never persist its plaintext secret.
    if (req.method === "POST" && url.pathname === "/init") {
      if (await this.ctx.storage.get("meta")) return new Response("exists", { status: 409 });
      const parsed = await smallJson(req, 1024);
      if (parsed.error) return parsed.error;
      const body = parsed.value;
      const hash = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).invite_hash : null;
      if (typeof hash !== "string" || !HASH.test(hash)) return new Response("bad", { status: 400 });
      await this.ctx.storage.put("meta", { invite_hash: hash, created_at: Date.now(), member_count: 0 } satisfies Meta);
      return new Response("ok");
    }

    // Each enrollment creates an individual identity and credential. The transaction prevents concurrent
    // enrollments from exceeding capacity.
    if (req.method === "POST" && url.pathname === "/enroll") {
      const parsed = await smallJson(req, 1024);
      if (parsed.error) return parsed.error;
      const body = parsed.value;
      const secret = body && typeof body === "object" && !Array.isArray(body) ? (body as Partial<EnrollRequest>).secret : null;
      if (!isInviteSecret(secret)) return new Response("unauthorized", { status: 401 });
      const inviteHash = await sha256(secret);
      const member = randomToken(12);
      const credential = randomToken(32);
      const credentialHash = await sha256(credential);
      const enrolled = await this.ctx.storage.transaction(async (txn): Promise<"ok" | "unauthorized" | "full"> => {
        const meta = await txn.get<Meta>("meta");
        if (!meta || !HASH.test(meta.invite_hash) || !sameHash(meta.invite_hash, inviteHash)) return "unauthorized";
        if (!Number.isSafeInteger(meta.member_count) || meta.member_count < 0 || meta.member_count >= MEMBERS_MAX) return "full";
        await txn.put(`credential:${member}`, { hash: credentialHash, created_at: Date.now() } satisfies Credential);
        await txn.put("meta", { ...meta, member_count: meta.member_count + 1 });
        return "ok";
      });
      if (enrolled === "unauthorized") return new Response("unauthorized", { status: 401 });
      if (enrolled === "full") return new Response("full", { status: 429 });
      return Response.json({ member, credential } satisfies EnrollResponse, { headers: { "Cache-Control": "no-store" } });
    }

    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (url.searchParams.get("p") !== String(PROTO)) return new Response("protocol", { status: 426 });

    // Authenticate before accepting the socket. Relay-assigned enrollment credentials prevent
    // impersonating another member.
    let member = url.searchParams.get("m") ?? "";
    let name = normalizeName(url.searchParams.get("n"));
    let expires_at: number | undefined;
    const organization = /^\/organization\/([A-Za-z0-9_-]{8,64})$/.exec(url.pathname);
    const access = organization ? await authorizeOrganization(this.env.CLOUD_URL ?? "https://app.prometeu.co", organization[1], url.searchParams.get("ticket") ?? "") : null;
    if (organization) {
      if (!access) return new Response("unauthorized", { status: 401 });
      ({ member, name, expires_at } = access);
    } else {
      const credential = url.searchParams.get("c") ?? "";
      if (!isId(member) || !isCredential(credential)) return new Response("unauthorized", { status: 401 });
      const enrolled = await this.ctx.storage.get<Credential>(`credential:${member}`);
      if (!enrolled || !HASH.test(enrolled.hash) || !sameHash(await sha256(credential), enrolled.hash)) return new Response("unauthorized", { status: 401 });
    }

    const state = await this.load();
    if (access) {
      for (const [id, ws] of this.bySock) {
        if (!access.members.some(m => m.id === state.socks.get(id)?.member)) {
          ws.close(1008, "membership revoked");
          this.bySock.delete(id);
        }
      }
      this.apply(reduce(state, { k: "roster", members: access.members, now: Date.now() }));
    }
    if (state.socks.size >= SOCKETS_MAX) return new Response("full", { status: 429 });
    if ([...state.socks.values()].filter((sock) => sock.member === member).length >= SOCKETS_PER_MEMBER_MAX) {
      return new Response("too many sockets", { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const sock = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [`m:${member}`]);
    server.serializeAttachment({ auth: PROTO, sock, member, attached: null, expires_at } satisfies Attachment);
    this.bySock.set(sock, server);
    if (expires_at) {
      const alarm = await this.ctx.storage.getAlarm();
      if (!alarm || expires_at < alarm) await this.ctx.storage.setAlarm(expires_at);
    }
    this.apply(reduce(state, { k: "open", sock, member, name, now: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const state = await this.load();
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.auth !== PROTO || !this.liveSocket(att.sock)) return;
    if ((typeof message === "string" && message.length > TEXT_FRAME_MAX) || (typeof message !== "string" && message.byteLength > BINARY_FRAME_MAX)) {
      ws.close(1009, "message too big");
      return;
    }
    const now = Date.now();
    const bytes = typeof message === "string" ? new TextEncoder().encode(message).length : message.byteLength;
    if ((typeof message === "string" && bytes > TEXT_FRAME_MAX) || (typeof message !== "string" && bytes > BINARY_FRAME_MAX)) {
      ws.close(1009, "message too big");
      return;
    }
    let rate = this.rates.get(att.sock);
    if (!rate || now - rate.since >= RATE_WINDOW_MS) {
      rate = { since: now, frames: 0, bytes: 0 };
      this.rates.set(att.sock, rate);
    }
    rate.frames += 1;
    rate.bytes += bytes;
    if (rate.frames > FRAMES_PER_WINDOW_MAX || rate.bytes > BYTES_PER_WINDOW_MAX) {
      ws.close(1008, "rate limit");
      return;
    }
    if (typeof message === "string") {
      let frame: unknown;
      try {
        frame = JSON.parse(message);
      } catch {
        ws.send(JSON.stringify({ t: "error", code: "bad" }));
        return;
      }
      if (att.expires_at !== undefined && frame && typeof frame === "object" && (frame as { t?: string }).t === "me") return;
      this.apply(reduce(state, { k: "text", sock: att.sock, frame, now: Date.now(), rand: crypto.randomUUID().slice(0, 8) }));
    } else {
      // Forward live output without awaiting so each socket preserves transcript order.
      this.apply(reduce(state, { k: "binary", sock: att.sock, data: new Uint8Array(message) }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.gone(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.gone(ws);
  }

  async alarm() {
    await this.load();
    let next: number | undefined;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.expires_at === undefined) continue;
      if (att.expires_at <= Date.now()) {
        await this.gone(ws);
        ws.close(1008, "reauthenticate");
      } else {
        next = Math.min(next ?? att.expires_at, att.expires_at);
      }
    }
    if (next) await this.ctx.storage.setAlarm(next);
  }

  private liveSocket(id: string): WebSocket | undefined {
    const ws = this.bySock.get(id);
    const att = ws?.deserializeAttachment() as Attachment | null;
    // ponytail: 60-second leases bound revocation; renewable leases can avoid reconnect snapshots if traffic warrants it.
    if (att?.expires_at !== undefined && att.expires_at <= Date.now()) {
      ws?.close(1008, "reauthenticate");
      return undefined;
    }
    return ws;
  }

  private async gone(ws: WebSocket) {
    const state = await this.load();
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.auth !== PROTO) return;
    this.bySock.delete(att.sock);
    this.rates.delete(att.sock);
    this.apply(reduce(state, { k: "close", sock: att.sock, now: Date.now() }));
  }

  private apply(effects: Effect[]) {
    for (const fx of effects) {
      switch (fx.e) {
        case "send":
          this.liveSocket(fx.sock)?.send(JSON.stringify(fx.frame));
          break;
        case "sendBinary":
          this.liveSocket(fx.sock)?.send(fx.data);
          break;
        case "attachment":
          this.bySock.get(fx.sock)?.serializeAttachment({
            ...(this.bySock.get(fx.sock)?.deserializeAttachment() as Attachment),
            auth: PROTO, sock: fx.sock, member: fx.member, attached: fx.attached,
          } satisfies Attachment);
          break;
        case "put":
          // Platform output gating delays messages until storage writes commit; input gating preserves
          // event order.
          void this.ctx.storage.put(fx.key, fx.value);
          break;
        case "del":
          void this.ctx.storage.delete(fx.key);
          break;
      }
    }
  }
}
