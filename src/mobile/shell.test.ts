import { describe, expect, it, vi } from "vitest";
import { TeamSecurity } from "../team-security";
import { companionId, labelFor, membershipOf, pickOrganization, securityStore, socketUrl, ticketUrl, type Config } from "./shell";

function storage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
}

const config: Config = {
  origin: "https://cloud.test", user: { id: "user1", name: "Alice" }, csrf: "token",
  organizations: [{ id: "organization1", slug: "one", name: "One", member: "membership1" }],
};

describe("browser shell ports", () => {
  it("keeps one companion identity per browser and a private identity in the same storage", async () => {
    const disk = storage();
    const id = companionId(disk);
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(companionId(disk)).toBe(id);
    const store = securityStore(disk);
    const first = await TeamSecurity.load("scope", store.read, store.write);
    const again = await TeamSecurity.load("scope", store.read, store.write);
    expect(again.identity.publicKey).toBe(first.identity.publicKey);
  });

  it("builds the same room URL as the desktop and binds the encryption scope to the Cloud origin", async () => {
    expect(socketUrl("https://relay.test/", "organization1", "t".repeat(43)))
      .toBe(`wss://relay.test/organization/organization1?ticket=${"t".repeat(43)}&p=4`);
    expect(socketUrl("http://127.0.0.1:8787", "organization1", "x")).toBe("ws://127.0.0.1:8787/organization/organization1?ticket=x&p=4");
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/orgs/one/companion-ticket");
      expect((init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("token");
      expect(JSON.parse(init?.body as string)).toEqual({ companion: "c".repeat(22), label: "iPhone" });
      return new Response(JSON.stringify({ ticket: "t".repeat(43), relay: "https://relay.test" }), { status: 200 });
    });
    const url = await ticketUrl(config, config.organizations[0], "c".repeat(22), "iPhone", request as unknown as typeof fetch);
    expect(url).toContain("wss://relay.test/organization/organization1?ticket=");
    const denied = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(ticketUrl(config, config.organizations[0], "c".repeat(22), "iPhone", denied as unknown as typeof fetch)).rejects.toThrow("ticket 404");
    const membership = membershipOf(config, config.organizations[0], "c".repeat(22), async () => url);
    expect(membership).toMatchObject({ member: "c".repeat(22), legacy: false,
      scope: JSON.stringify(["organization", "https://cloud.test", "organization1"]) });
    expect(labelFor("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
    expect(labelFor("curl/8")).toBe("Browser");
  });

  it("selects the only organization or the remembered one", () => {
    const disk = storage();
    expect(pickOrganization(config, disk)?.id).toBe("organization1");
    const two = { ...config, organizations: [...config.organizations, { id: "organization2", slug: "two", name: "Two", member: "membership2" }] };
    expect(pickOrganization(two, disk)).toBeNull();
    disk.setItem("prometeu:mobile-organization", "organization2");
    expect(pickOrganization(two, disk)?.id).toBe("organization2");
  });
});
