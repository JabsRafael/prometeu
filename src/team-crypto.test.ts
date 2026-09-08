import { describe, expect, it } from "vitest";
import {
  decodeBase64Url, encodeBase64Url, fingerprint, generateIdentity, open, seal,
  signIdentity, validateIdentity, validatePublicKey, verifyIdentity,
} from "./team-crypto";

const content = new TextEncoder().encode("private conversation: Olá 🔐");
const context = ["organization", "workspace", "tab", "sender", "recipient", "message-id"];

describe("criptografia ponta a ponta do time", () => {
  it("preserva identidade e autentica conteúdo entre dispositivos", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const restored = await validateIdentity(JSON.parse(JSON.stringify(alice)));
    expect(restored).toEqual(alice);
    const box = await seal(restored, bob.publicKey, context, content);
    expect(await open(bob, alice.publicKey, context, box)).toEqual(content);
    expect(await seal(alice, bob.publicKey, context, content)).not.toEqual(box);
    expect(await fingerprint(restored.publicKey)).toMatch(/^[a-f0-9]{4}( [a-f0-9]{4}){15}$/);
    expect(await fingerprint(restored.publicKey)).toBe(await fingerprint(alice.publicKey));
    expect(await fingerprint(bob.publicKey)).not.toBe(await fingerprint(alice.publicKey));
  });

  it("recusa remetente, destinatário e contexto substituídos", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const mallory = await generateIdentity();
    const box = await seal(alice, bob.publicKey, context, content);
    await expect(open(bob, mallory.publicKey, context, box)).rejects.toThrow();
    await expect(open(mallory, alice.publicKey, context, box)).rejects.toThrow();
    for (let i = 0; i < context.length; i++) {
      const changed = context.map((part, index) => index === i ? "changed" : part);
      await expect(open(bob, alice.publicKey, changed, box)).rejects.toThrow();
    }
    const ambiguous = await seal(alice, bob.publicKey, ["a", "b:c"], content);
    await expect(open(bob, alice.publicKey, ["a:b", "c"], ambiguous)).rejects.toThrow();
  });

  it("recusa adulteração de ciphertext e encapsulamento", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const box = await seal(alice, bob.publicKey, context, content);
    for (const field of ["enc", "ct"] as const) {
      const bytes = decodeBase64Url(box[field], 1024);
      bytes[bytes.length - 1] ^= 1;
      await expect(open(bob, alice.publicKey, context, { ...box, [field]: encodeBase64Url(bytes) })).rejects.toThrow();
    }
    await expect(open(bob, alice.publicKey, context, { ...box, ct: "AA" })).rejects.toThrow();
  });

  it("recusa chaves inválidas e identidades inconsistentes sem regenerar", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    for (const value of [null, {}, { ...alice, privateKey: {} }, { ...alice, publicKey: bob.publicKey },
      { ...alice, privateKey: { ...alice.privateKey, d: bob.privateKey.d } },
      { ...alice, privateKey: { ...alice.privateKey, crv: "P-384" } }]) {
      await expect(validateIdentity(value)).rejects.toThrow();
    }
    for (const value of ["", "bad key", "AA", "A".repeat(88), encodeBase64Url(new Uint8Array(65).fill(4))]) {
      await expect(validatePublicKey(value)).rejects.toThrow();
    }
  });

  it("valida base64url canônico e limites antes de importar", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(decodeBase64Url(encodeBase64Url(bytes), 256)).toEqual(bytes);
    expect(decodeBase64Url("", 0)).toEqual(new Uint8Array());
    for (const value of ["AA=", "AB", "A", "AA+", "AA/", "AA\n"]) {
      expect(() => decodeBase64Url(value, 32)).toThrow();
    }
    expect(() => decodeBase64Url(encodeBase64Url(bytes), 255)).toThrow();
    expect(() => decodeBase64Url("AA", -1)).toThrow();
  });

  it("prova posse vinculada ao membro, organização e desafio", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const statement = ["organization", "member", "challenge"];
    const signature = await signIdentity(alice, statement);
    expect(await verifyIdentity(alice.publicKey, statement, signature)).toBe(true);
    expect(await verifyIdentity(bob.publicKey, statement, signature)).toBe(false);
    expect(await verifyIdentity(alice.publicKey, ["other", ...statement.slice(1)], signature)).toBe(false);
    expect(await verifyIdentity(alice.publicKey, statement, "AA")).toBe(false);
    expect(await verifyIdentity("invalid", statement, signature)).toBe(false);
  });
});
