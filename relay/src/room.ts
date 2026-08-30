/// Um Durable Object por time: a tubulação entre os WebSockets da plataforma
/// e o `reduce` de `logic.ts`. Nada é decidido aqui — só convertido.
///
/// Hibernação: entre uma mensagem e outra o objeto pode ser descarregado, e
/// com ele a memória. Por isso o estado é reconstruído do storage na primeira
/// mensagem depois de acordar, e o que é de cada socket (membro, aba que olha)
/// mora no attachment do próprio socket, que a plataforma guarda.

import { DurableObject } from "cloudflare:workers";
import { hydrate, reduce, type Effect, type Sock, type State } from "./logic";
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

export type Env = { TEAM: DurableObjectNamespace<TeamRoom> };

type Attachment = { auth: typeof PROTO; sock: string; member: string; attached: Sock["attached"] };
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

async function smallJson(req: Request, max: number): Promise<{ value?: unknown; error?: Response }> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > max) return { error: new Response("too big", { status: 413 }) };
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > max) return { error: new Response("too big", { status: 413 }) };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: new Response("bad", { status: 400 }) };
  }
}

export class TeamRoom extends DurableObject<Env> {
  private state: State | null = null;
  private bySock = new Map<string, WebSocket>();
  private rates = new Map<string, { since: number; frames: number; bytes: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Batimento sem acordar o objeto: o edge derruba socket parado em ~100 s.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /// O estado em memória, ou o que o storage e os sockets contam ao acordar.
  private async load(): Promise<State> {
    if (this.state) return this.state;
    const rows = await this.ctx.storage.list<unknown>();
    const socks: Sock[] = [];
    const perMember = new Map<string, number>();
    this.bySock.clear();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att || att.auth !== PROTO || !isId(att.sock) || !isId(att.member)) {
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

    // O Worker aponta cada IP para um objeto separado. A rota não é exposta
    // por ele; aqui a transação apenas fecha requisições simultâneas.
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

    // Nasce com o hash do convite — chamado uma vez pelo Worker. O segredo
    // em claro nunca é persistido.
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

    // Convite é matrícula, não identidade: cada troca cria um id e uma
    // credencial que só aquele cliente guardará. A transação fecha a corrida
    // de duas matrículas atingindo a cota ao mesmo tempo.
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

    // Autenticação antes de aceitar: a matrícula é atribuída pelo relay e a
    // credencial individual impede escolher o id de outra pessoa.
    const credential = url.searchParams.get("c") ?? "";
    const member = url.searchParams.get("m") ?? "";
    if (!isId(member) || !isCredential(credential)) return new Response("unauthorized", { status: 401 });
    const enrolled = await this.ctx.storage.get<Credential>(`credential:${member}`);
    if (!enrolled || !HASH.test(enrolled.hash) || !sameHash(await sha256(credential), enrolled.hash)) return new Response("unauthorized", { status: 401 });

    const state = await this.load();
    if (state.socks.size >= SOCKETS_MAX) return new Response("full", { status: 429 });
    if ([...state.socks.values()].filter((sock) => sock.member === member).length >= SOCKETS_PER_MEMBER_MAX) {
      return new Response("too many sockets", { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const sock = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [`m:${member}`]);
    server.serializeAttachment({ auth: PROTO, sock, member, attached: null } satisfies Attachment);
    this.bySock.set(sock, server);
    this.apply(reduce(state, { k: "open", sock, member, name: normalizeName(url.searchParams.get("n")), now: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const state = await this.load();
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.auth !== PROTO) return;
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
      this.apply(reduce(state, { k: "text", sock: att.sock, frame, now: Date.now(), rand: crypto.randomUUID().slice(0, 8) }));
    } else {
      // Caminho quente, sem `await` entre receber e repassar: a ordem por
      // socket é o que faz a rolagem do colega bater com a do dono.
      this.apply(reduce(state, { k: "binary", sock: att.sock, data: new Uint8Array(message) }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.gone(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.gone(ws);
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
          this.bySock.get(fx.sock)?.send(JSON.stringify(fx.frame));
          break;
        case "sendBinary":
          this.bySock.get(fx.sock)?.send(fx.data);
          break;
        case "attachment":
          this.bySock.get(fx.sock)?.serializeAttachment({ auth: PROTO, sock: fx.sock, member: fx.member, attached: fx.attached } satisfies Attachment);
          break;
        case "put":
          // Sem `await`: o portão de saída da plataforma segura qualquer
          // mensagem até a gravação confirmar, e a fila de entrada não deixa
          // outro evento passar na frente.
          void this.ctx.storage.put(fx.key, fx.value);
          break;
        case "del":
          void this.ctx.storage.delete(fx.key);
          break;
      }
    }
  }
}
