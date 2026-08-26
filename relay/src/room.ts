/// Um Durable Object por time: a tubulação entre os WebSockets da plataforma
/// e o `reduce` de `logic.ts`. Nada é decidido aqui — só convertido.
///
/// Hibernação: entre uma mensagem e outra o objeto pode ser descarregado, e
/// com ele a memória. Por isso o estado é reconstruído do storage na primeira
/// mensagem depois de acordar, e o que é de cada socket (membro, aba que olha)
/// mora no attachment do próprio socket, que a plataforma guarda.

import { DurableObject } from "cloudflare:workers";
import { hydrate, reduce, type Effect, type Sock, type State } from "./logic";
import { PROTO, type Up } from "./protocol";

export type Env = { TEAM: DurableObjectNamespace<TeamRoom> };

type Attachment = { sock: string; member: string; attached: Sock["attached"] };

export async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class TeamRoom extends DurableObject<Env> {
  private state: State | null = null;
  private bySock = new Map<string, WebSocket>();

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
    this.bySock.clear();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      socks.push({ id: att.sock, member: att.member, attached: att.attached });
      this.bySock.set(att.sock, ws);
    }
    this.state = hydrate([...rows].filter(([k]) => k !== "meta"), socks);
    return this.state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Nasce com o segredo — chamado uma vez pelo Worker, ao criar o time.
    if (req.method === "POST" && url.pathname.endsWith("/init")) {
      if (await this.ctx.storage.get("meta")) return new Response("exists", { status: 409 });
      const { secret_hash } = (await req.json()) as { secret_hash: string };
      await this.ctx.storage.put("meta", { secret_hash, created_at: Date.now() });
      return new Response("ok");
    }

    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (url.searchParams.get("p") !== String(PROTO)) return new Response("protocol", { status: 426 });

    // Autenticação antes de aceitar: nunca existe socket sem membro. O segredo
    // vai na query porque o WebSocket do navegador não manda header.
    const meta = (await this.ctx.storage.get("meta")) as { secret_hash: string } | undefined;
    const secret = url.searchParams.get("s") ?? "";
    const member = url.searchParams.get("m") ?? "";
    if (!meta || !secret || !member || !/^[A-Za-z0-9_-]{8,64}$/.test(member)) return new Response("unauthorized", { status: 401 });
    if ((await sha256(secret)) !== meta.secret_hash) return new Response("unauthorized", { status: 401 });

    const state = await this.load();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const sock = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [`m:${member}`]);
    server.serializeAttachment({ sock, member, attached: null } satisfies Attachment);
    this.bySock.set(sock, server);
    this.apply(reduce(state, { k: "open", sock, member, name: url.searchParams.get("n") ?? "", now: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const state = await this.load();
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (typeof message === "string") {
      let frame: Up;
      try {
        frame = JSON.parse(message);
      } catch {
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
    if (!att) return;
    this.bySock.delete(att.sock);
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
          this.bySock.get(fx.sock)?.serializeAttachment({ sock: fx.sock, member: fx.member, attached: fx.attached } satisfies Attachment);
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
