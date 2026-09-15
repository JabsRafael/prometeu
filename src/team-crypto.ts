import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";

export type Identity = { privateKey: JsonWebKey; publicKey: string };
export type Sealed = { enc: string; ct: string };

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const encoder = new TextEncoder();
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Reject oversized and noncanonical encodings before importing network input. */
export function decodeBase64Url(value: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 0
    || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("Invalid base64url");
  }
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length > maxBytes || encodeBase64Url(bytes) !== value) throw new Error("Invalid base64url");
  return bytes;
}

function publicBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64Url(value, 65);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("Invalid identity public key");
  return bytes;
}

async function importPublicKey(value: string): Promise<CryptoKey> {
  return suite.kem.deserializePublicKey(publicBytes(value));
}

export async function validatePublicKey(publicKey: string): Promise<void> {
  await importPublicKey(publicKey);
}

export async function generateIdentity(): Promise<Identity> {
  const keys = await suite.kem.generateKeyPair();
  return {
    privateKey: await crypto.subtle.exportKey("jwk", keys.privateKey) as JsonWebKey,
    publicKey: encodeBase64Url(new Uint8Array(await suite.kem.serializePublicKey(keys.publicKey))),
  };
}

/** Invalid persisted identities must block sharing, never silently regenerate. */
export async function validateIdentity(value: unknown): Promise<Identity> {
  if (!value || typeof value !== "object") throw new Error("Invalid identity");
  const candidate = value as Partial<Identity>;
  const key = candidate.privateKey;
  if (typeof candidate.publicKey !== "string" || !key || typeof key !== "object"
    || key.kty !== "EC" || key.crv !== "P-256"
    || typeof key.d !== "string" || typeof key.x !== "string" || typeof key.y !== "string"
    || [key.d, key.x, key.y].some((coordinate) => decodeBase64Url(coordinate, 32).length !== 32)) {
    throw new Error("Invalid identity");
  }
  const privateKey = await suite.kem.importKey("jwk", key, false);
  const identity = {
    privateKey: await crypto.subtle.exportKey("jwk", privateKey) as JsonWebKey,
    publicKey: candidate.publicKey,
  };
  // A successful authenticated roundtrip proves the advertised public key matches
  // the private scalar, including runtimes that accept inconsistent JWK fields.
  const context = ["identity-validation"];
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const box = await seal(identity, identity.publicKey, context, challenge);
  const recovered = await open(identity, identity.publicKey, context, box);
  if (recovered.length !== challenge.length || recovered.some((byte, i) => byte !== challenge[i])) {
    throw new Error("Identity key mismatch");
  }
  return identity;
}

function info(context: readonly string[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(JSON.stringify(["prometeu-e2ee-v4", ...context])));
}

// HPKE Auth authenticates the sender. Static recipient keys do not provide
// forward secrecy: a stolen recipient private key exposes recorded ciphertext.
export async function seal(identity: Identity, recipientPublic: string, context: readonly string[], bytes: Uint8Array): Promise<Sealed> {
  if (bytes.byteLength > MAX_CONTENT_BYTES) throw new Error("Encrypted content too large");
  const result = await suite.seal({
    recipientPublicKey: await importPublicKey(recipientPublic),
    senderKey: await suite.kem.importKey("jwk", identity.privateKey, false),
    info: info(context),
  }, bytes);
  return { enc: encodeBase64Url(new Uint8Array(result.enc)), ct: encodeBase64Url(new Uint8Array(result.ct)) };
}

export async function open(identity: Identity, senderPublic: string, context: readonly string[], box: Sealed): Promise<Uint8Array> {
  const enc = publicBytes(box.enc);
  const ct = decodeBase64Url(box.ct, MAX_CONTENT_BYTES + 16);
  if (ct.length < 16) throw new Error("Invalid encrypted content");
  return new Uint8Array(await suite.open({
    recipientKey: await suite.kem.importKey("jwk", identity.privateKey, false),
    senderPublicKey: await importPublicKey(senderPublic),
    enc,
    info: info(context),
  }, ct));
}

function identityStatement(context: readonly string[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(JSON.stringify(["prometeu-identity-v4", ...context])));
}

export async function signIdentity(identity: Identity, context: readonly string[]): Promise<string> {
  const privateKey = await crypto.subtle.importKey("jwk", { ...identity.privateKey, key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, identityStatement(context),
  )));
}

export async function verifyIdentity(publicKey: string, context: readonly string[], signature: string): Promise<boolean> {
  try {
    const bytes = decodeBase64Url(signature, 64);
    if (bytes.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", publicBytes(publicKey),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes, identityStatement(context));
  } catch {
    return false;
  }
}
