import { describe, expect, it } from "vitest";
import { relayUrl } from "./team-transport";

describe("relay URL", () => {
  it("converts HTTPS to the requested transport", () => {
    expect(relayUrl("https://relay.example.com/", true, true)).toBe("wss://relay.example.com");
    expect(relayUrl("wss://relay.example.com", false, true)).toBe("https://relay.example.com");
  });

  it("allows HTTP only for local development", () => {
    expect(relayUrl("http://127.0.0.1:8787", true, true)).toBe("ws://127.0.0.1:8787");
    expect(() => relayUrl("http://relay.example.com", true, true)).toThrow();
  });

  it("rejects embedded credentials and queries", () => {
    expect(() => relayUrl("https://user:secret@relay.example.com", true, true)).toThrow();
    expect(() => relayUrl("https://relay.example.com?token=x", true, true)).toThrow();
  });
});
