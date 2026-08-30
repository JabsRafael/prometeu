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
