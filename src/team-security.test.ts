import { describe, expect, it, vi } from "vitest";
import { generateIdentity } from "./team-crypto";
import { TeamSecurity } from "./team-security";

function storage(initial: unknown = null) {
  let value = initial;
  let fail = false;
  let writes = 0;
  return {
    read: async () => structuredClone(value),
    write: async (next: unknown) => {
      if (fail) throw new Error("Storage unavailable");
      value = structuredClone(next);
      writes++;
    },
    fail: (next: boolean) => { fail = next; },
    writes: () => writes,
  };
}

describe("identidades e confiança inicial do time", () => {
  it("persiste replay antes do uso e bloqueia relógio regressivo e falha de escrita", async () => {
    const disk = storage();
    const security = await TeamSecurity.load("team", disk.read, disk.write);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      disk.fail(true);
      await expect(security.consume("message", 1_060_000)).rejects.toThrow("Storage unavailable");
      disk.fail(false);
      await security.consume("message", 1_060_000);
      const reopened = await TeamSecurity.load("team", disk.read, disk.write);
      await expect(reopened.consume("message", 1_060_000)).rejects.toThrow("Expired or repeated input");
      await expect(reopened.consume("too-late", 999_999)).rejects.toThrow();
      await expect(reopened.consume("too-early", 1_120_001)).rejects.toThrow();
      now.mockReturnValue(999_999);
      await expect(reopened.consume("rollback", 1_060_000)).rejects.toThrow();
      now.mockReturnValue(1_070_000);
      await reopened.consume("next", 1_080_000);
      expect(JSON.stringify(await disk.read())).not.toContain('"message"');
    } finally { now.mockRestore(); }
  });

  it("conserva sequência e dono de shares e não avança revisão se gravação falhar", async () => {
    const disk = storage();
    const security = await TeamSecurity.load("team", disk.read, disk.write);
    const bob = await generateIdentity();
    expect(await security.nextRevision()).toBe(1);
    await security.observeShare("ws", "bob", bob.publicKey, 2, "revision-two");
    const reopened = await TeamSecurity.load("team", disk.read, disk.write);
    expect(await reopened.nextRevision()).toBe(2);
    await reopened.observeShare("ws", "bob", bob.publicKey, 2, "revision-two");
    await expect(reopened.observeShare("ws", "bob", bob.publicKey, 1, "old")).rejects.toThrow();
    await expect(reopened.observeShare("ws", "bob", bob.publicKey, 2, "forged")).rejects.toThrow();
    await expect(reopened.observeShare("ws", "eve", bob.publicKey, 3, "replacement")).rejects.toThrow();
    disk.fail(true);
    await expect(reopened.observeShare("ws", "bob", bob.publicKey, 3, "next")).rejects.toThrow("Storage unavailable");
    disk.fail(false);
    await reopened.observeShare("ws", "bob", bob.publicKey, 2, "revision-two");
    await reopened.observeShare("ws", "bob", bob.publicKey, 3, "next");
    await expect(reopened.observeShare("ws", "bob", bob.publicKey, 2, "revision-two")).rejects.toThrow();
  });

  it("persiste identidade e vínculos antes de expor e conserva outras organizações", async () => {
    const disk = storage();
    const bob = await generateIdentity();
    const alpha = await TeamSecurity.load("alpha", disk.read, disk.write);
    expect(disk.writes()).toBe(1);
    await alpha.observe([{ id: "bob", key: bob.publicKey }], "alice");
    expect(alpha.key("bob")).toBe(bob.publicKey);
    const beta = await TeamSecurity.load("beta", disk.read, disk.write);
    expect(beta.identity).not.toEqual(alpha.identity);
    const reopened = await TeamSecurity.load("alpha", disk.read, disk.write);
    expect(reopened.identity).toEqual(alpha.identity);
    expect(reopened.key("bob")).toBeUndefined();
    await reopened.observe([{ id: "bob", key: bob.publicKey }], "alice");
    expect(reopened.key("bob")).toBe(bob.publicKey);
    expect((await TeamSecurity.load("beta", disk.read, disk.write)).identity).toEqual(beta.identity);
  });

  it("adota chave nova do colega e só a usa depois de persistir", async () => {
    const disk = storage();
    const security = await TeamSecurity.load("team", disk.read, disk.write);
    const old = await generateIdentity();
    const next = await generateIdentity();
    await security.observe([{ id: "bob", key: old.publicKey }], "alice");
    disk.fail(true);
    await expect(security.observe([{ id: "bob", key: next.publicKey }], "alice")).rejects.toThrow("Storage unavailable");
    expect(security.key("bob")).toBeUndefined();
    disk.fail(false);
    await security.observe([{ id: "bob", key: next.publicKey }], "alice");
    expect(security.key("bob")).toBe(next.publicKey);
    const reopened = await TeamSecurity.load("team", disk.read, disk.write);
    await reopened.observe([{ id: "bob", key: next.publicKey }], "alice");
    expect(reopened.key("bob")).toBe(next.publicKey);
    // Adoption follows the directory in both directions: a key seen again replaces the pin again.
    await reopened.observe([{ id: "bob", key: old.publicKey }], "alice");
    expect(reopened.key("bob")).toBe(old.publicKey);
  });

  it("bloqueia chave ausente sem apagar vínculo e recusa troca da própria identidade", async () => {
    const disk = storage();
    const security = await TeamSecurity.load("team", disk.read, disk.write);
    const bob = await generateIdentity();
    await security.observe([{ id: "bob", key: bob.publicKey }, { id: "alice", key: security.identity.publicKey }], "alice");
    expect(security.key("alice")).toBe(security.identity.publicKey);
    await security.observe([{ id: "bob" }], "alice");
    expect(security.key("bob")).toBeUndefined();
    expect(security.key("alice")).toBeUndefined();
    await security.observe([], "alice");
    expect(security.key("bob")).toBeUndefined();
    await security.observe([{ id: "bob", key: bob.publicKey }], "alice");
    expect(security.key("bob")).toBe(bob.publicKey);
    await expect(security.observe([{ id: "alice", key: bob.publicKey }], "alice")).rejects.toThrow("Own identity key changed");
    expect(security.key("alice")).toBeUndefined();
  });

  it("não expõe primeira chave quando persistência falha", async () => {
    const disk = storage();
    disk.fail(true);
    await expect(TeamSecurity.load("team", disk.read, disk.write)).rejects.toThrow("Storage unavailable");
    disk.fail(false);
    const security = await TeamSecurity.load("team", disk.read, disk.write);
    const bob = await generateIdentity();
    disk.fail(true);
    await expect(security.observe([{ id: "bob", key: bob.publicKey }], "alice")).rejects.toThrow("Storage unavailable");
    expect(security.key("bob")).toBeUndefined();
    disk.fail(false);
    await security.observe([{ id: "bob", key: bob.publicKey }], "alice");
    expect(security.key("bob")).toBe(bob.publicKey);
  });

  it("recusa armazenamento corrompido sem regenerar identidade", async () => {
    const identity = await generateIdentity();
    const invalid = [false, [], {}, { version: 2, scopes: {} }, { version: 1, scopes: [] },
      { version: 1, scopes: { team: null } },
      { version: 1, scopes: { team: { identity: {}, peers: {} } } },
      { version: 1, scopes: { team: { identity, peers: { bob: "bad" } } } },
      { version: 1, scopes: { team: { identity, peers: Object.fromEntries([["__proto__", identity.publicKey]]) } } },
      { version: 1, scopes: { team: { identity, peers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`peer${i}`, identity.publicKey])) } } },
    ];
    for (const value of invalid) {
      const disk = storage(value);
      await expect(TeamSecurity.load("team", disk.read, disk.write)).rejects.toThrow();
      expect(disk.writes()).toBe(0);
    }
  });

  it("serializa observações simultâneas sem perder vínculos", async () => {
    const disk = storage();
    const security = await TeamSecurity.load("team", disk.read, disk.write);
    const bob = await generateIdentity();
    const carol = await generateIdentity();
    await Promise.all([
      security.observe([{ id: "bob", key: bob.publicKey }], "alice"),
      security.observe([{ id: "carol", key: carol.publicKey }], "alice"),
    ]);
    const reopened = await TeamSecurity.load("team", disk.read, disk.write);
    const impostor = await generateIdentity();
    await reopened.observe([{ id: "bob", key: impostor.publicKey }, { id: "carol", key: carol.publicKey }], "alice");
    expect(reopened.key("bob")).toBe(impostor.publicKey);
    expect(reopened.key("carol")).toBe(carol.publicKey);
  });

  it("recusa diretório inválido sem expor vínculo observado", async () => {
    const disk = storage();
    const security = await TeamSecurity.load("team", disk.read, disk.write);
    const bob = await generateIdentity();
    const next = await generateIdentity();
    await security.observe([{ id: "bob", key: bob.publicKey }], "alice");
    await expect(security.observe([{ id: "bob", key: "bad" }], "alice")).rejects.toThrow();
    expect(security.key("bob")).toBeUndefined();
    await expect(security.observe([{ id: "bob" }, { id: "bob" }], "alice")).rejects.toThrow();
    await security.observe([{ id: "bob", key: next.publicKey }], "alice");
    expect(security.key("bob")).toBe(next.publicKey);
    await security.observe([], "alice");
    expect(security.key("bob")).toBeUndefined();
  });
});
