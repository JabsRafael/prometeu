import { describe, expect, it } from "vitest";
import { smallJson } from "./http";

function streamed(chunks: Uint8Array[], length?: string) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulled++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request("https://relay.test/enroll", {
    method: "POST", body, duplex: "half",
    headers: length === undefined ? {} : { "Content-Length": length },
  } as RequestInit);
  return { request, pulled: () => pulled, cancelled: () => cancelled };
}

describe("bounded JSON request bodies", () => {
  it.each([undefined, "1"])("cancels oversized streams without trusting Content-Length %s", async length => {
    const stream = streamed(Array.from({ length: 100 }, () => new Uint8Array(512)), length);
    expect((await smallJson(stream.request, 1024)).error?.status).toBe(413);
    expect(stream.pulled()).toBe(3);
    expect(stream.cancelled()).toBe(true);
  });

  it("rejects a declared oversized body without reading it", async () => {
    const stream = streamed([new Uint8Array(2048)], "2048");
    expect((await smallJson(stream.request, 1024)).error?.status).toBe(413);
    expect(stream.pulled()).toBe(0);
    expect(stream.cancelled()).toBe(true);
  });

  it("counts bytes and decodes UTF-8 split across chunks at the exact limit", async () => {
    const bytes = new TextEncoder().encode('{"name":"é"}');
    const chunks = Array.from(bytes, byte => new Uint8Array([byte]));
    expect(await smallJson(streamed(chunks).request, bytes.length)).toEqual({ value: { name: "é" }, raw: '{"name":"é"}' });
    expect((await smallJson(streamed(chunks).request, bytes.length - 1)).error?.status).toBe(413);
    expect((await smallJson(streamed([new TextEncoder().encode("{")]).request, 1024)).error?.status).toBe(400);
  });
});
