import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { parseCreatedTeam, parseMembership, PROTO, type CreatedTeam } from "./protocol";

let worker: Unstable_DevWorker;
let created: CreatedTeam;

const socketResult = (url: string): Promise<{ open: boolean; first?: unknown }> =>
  new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      resolve({ open: false });
    }, 5_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      let first: unknown = event.data;
      try {
        first = JSON.parse(String(event.data));
      } catch {
        // O primeiro frame válido deste protocolo é JSON; manter o valor cru
        // deixa a asserção mostrar o que um runtime incompatível devolveu.
      }
      socket.close();
      resolve({ open: true, first });
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve({ open: false });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({ open: false });
    });
  });

describe("relay no runtime do Worker", () => {
  beforeAll(async () => {
    worker = await unstable_dev("relay/src/worker.ts", {
      config: "relay/wrangler.toml",
      local: true,
      persist: false,
      logLevel: "none",
      experimental: { disableExperimentalWarning: true },
    });
    const response = await worker.fetch("/teams", { method: "POST" });
    expect(response.status).toBe(200);
    const parsed = parseCreatedTeam(await response.json());
    expect(parsed).not.toBeNull();
    created = parsed!;
  }, 30_000);

  afterAll(async () => {
    await worker?.stop();
  });

  it("troca o convite por uma credencial individual", async () => {
    const denied = await worker.fetch(`/team/${created.team}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "segredo-errado-123456" }),
    });
    expect(denied.status).toBe(401);

    const response = await worker.fetch(`/team/${created.team}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: created.secret }),
    });
    expect(response.status).toBe(200);
    const membership = parseMembership(await response.json());
    expect(membership).not.toBeNull();
    expect(membership?.member).not.toBe(created.member);
    expect(membership?.credential).not.toBe(created.credential);
  });

  it("não aceita mais o segredo coletivo no WebSocket", async () => {
    const base = `ws://${worker.address}:${worker.port}`;
    const old = await socketResult(`${base}/team/${created.team}?s=${created.secret}&m=${created.member}&n=Alice&p=${PROTO}`);
    expect(old.open).toBe(false);
  });

  it("liga a credencial ao membro e entrega o welcome", async () => {
    const base = `ws://${worker.address}:${worker.port}`;
    const swapped = await socketResult(`${base}/team/${created.team}?c=${created.credential}&m=outro_membro&n=Eve&p=${PROTO}`);
    expect(swapped.open).toBe(false);

    const ok = await socketResult(`${base}/team/${created.team}?c=${created.credential}&m=${created.member}&n=Alice&p=${PROTO}`);
    expect(ok).toMatchObject({ open: true, first: { t: "welcome", you: created.member } });
  });
});


describe("organization sharing through Cloud authorization", () => {
  let cloud: Server;
  let relay: Unstable_DevWorker;
  const tickets = new Map<string, { organization: string; member: string; name: string; lifetime: number }>();
  const members = [{ id: "owner001", name: "Alice" }, { id: "guest001", name: "Bob" }];
  const sockets: WebSocket[] = [];
  const issue = (char: string, member: number, lifetime = 60_000) => {
    const ticket = char.repeat(43);
    tickets.set(ticket, { organization: "organization1", member: members[member].id, name: members[member].name, lifetime });
    return ticket;
  };
  beforeAll(async () => {
    cloud = createServer(async (request, response) => {
      expect(request.url).toBe("/api/relay/authorize");
      expect(request.headers.authorization).toBeUndefined();
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const access = tickets.get(input.ticket);
      response.setHeader("Content-Type", "application/json");
      if (!access || access.organization !== input.organization) {
        response.writeHead(401); response.end('{}'); return;
      }
      tickets.delete(input.ticket);
      response.end(JSON.stringify({ ...access, expires_at: Date.now() + access.lifetime, members }));
    });
    await new Promise<void>(resolve => cloud.listen(0, "127.0.0.1", resolve));
    const address = cloud.address() as { port: number };
    relay = await unstable_dev("relay/src/worker.ts", { config: "relay/wrangler.toml", local: true, persist: false, logLevel: "none",
      vars: { CLOUD_URL: `http://127.0.0.1:${address.port}` }, experimental: { disableExperimentalWarning: true } });
  }, 30_000);
  afterAll(async () => {
    sockets.forEach(socket => socket.close());
    await relay?.stop();
    await new Promise<void>(resolve => cloud?.close(() => resolve()));
  });
  const base = () => `ws://${relay.address}:${relay.port}`;
  async function connect(ticket: string, identity = "spoofed") {
    const socket = new WebSocket(`${base()}/organization/organization1?ticket=${ticket}&m=${identity}&n=Impersonated&p=${PROTO}`);
    sockets.push(socket);
    const frames: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("missing welcome")), 5_000);
      socket.addEventListener("message", event => {
        if (typeof event.data === "string") {
          const frame = JSON.parse(event.data); frames.push(frame);
          if (frame.t === "welcome") { clearTimeout(timer); resolve(); }
        }
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("socket rejected")); });
    });
    return { socket, frames };
  }
  it("isolates organizations and refuses anonymous or legacy enrollment", async () => {
    const ticket = issue("a", 0);
    expect((await socketResult(`${base()}/organization/organization2?ticket=${ticket}&p=${PROTO}`)).open).toBe(false);
    expect((await socketResult(`${base()}/organization/organization1?c=${ticket}&m=owner001&p=${PROTO}`)).open).toBe(false);
    expect((await relay.fetch("/organization/organization1/enroll", { method: "POST" })).status).toBe(404);
  });
  it("shares only with accepted members, ignores spoofed identity and expires active access", async () => {
    const owner = await connect(issue("b", 0));
    const guestTicket = issue("c", 1, 2_000);
    const guest = await connect(guestTicket, "owner001");
    expect(guest.frames[0]).toMatchObject({ t: "welcome", you: "guest001", members: expect.arrayContaining([{ id: "guest001", name: "Bob", online: true }]) });
    expect((await socketResult(`${base()}/organization/organization1?ticket=${guestTicket}&p=${PROTO}`)).open).toBe(false);
    guest.socket.send(JSON.stringify({ t: "me", name: "Alice" }));
    owner.socket.send(JSON.stringify({ t: "share", share: { id: "workspace1", title: "Shared work", repo_name: "repo", branch: "main", stage: "", issue: null,
      active: "tab1", tabs: [{ id: "tab1", title: "Chat", status: "pronta", note: null, tokens: null }], sizes: { tab1: [80, 24] }, audience: ["guest001"] } }));
    await expect.poll(() => guest.frames.some(frame => frame.t === "share")).toBe(true);
    guest.socket.send(JSON.stringify({ t: "attach", ws: "workspace1", tab: "tab1" }));
    await expect.poll(() => owner.frames.some(frame => frame.t === "watch" && frame.members.includes("guest001"))).toBe(true);
    guest.socket.send(JSON.stringify({ t: "write", ws: "workspace1", tab: "tab1", data: "Please check this" }));
    await expect.poll(() => owner.frames.some(frame => frame.t === "write" && frame.from === "guest001")).toBe(true);
    await expect.poll(() => guest.socket.readyState, { timeout: 5_000 }).toBe(WebSocket.CLOSED);
    const presence = owner.frames.filter(frame => frame.t === "presence").at(-1);
    expect(presence.members.find((member: { id: string }) => member.id === "guest001").name).toBe("Bob");
    expect((await socketResult(`${base()}/organization/organization1?ticket=${"d".repeat(43)}&p=${PROTO}`)).open).toBe(false);
  });
});
