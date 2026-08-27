/// A porta de entrada do relay: criar um time e encaminhar cada conexão ao
/// Durable Object daquele time. Só isso — o resto mora em `room.ts`.

import { sha256, TeamRoom, type Env } from "./room";

export { TeamRoom };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function token(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/teams") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method !== "POST") return new Response("method", { status: 405, headers: CORS });
      const team = token(12);
      const secret = token(24);
      const stub = env.TEAM.get(env.TEAM.idFromName(team));
      const init = await stub.fetch("https://team/init", {
        method: "POST",
        body: JSON.stringify({ secret_hash: await sha256(secret) }),
      });
      if (!init.ok) return new Response("init", { status: 500, headers: CORS });
      return Response.json({ team, secret }, { headers: CORS });
    }

    const m = /^\/team\/([A-Za-z0-9_-]{8,64})$/.exec(url.pathname);
    if (m) {
      const stub = env.TEAM.get(env.TEAM.idFromName(m[1]));
      return stub.fetch(req);
    }

    return new Response("prometheus-relay", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
