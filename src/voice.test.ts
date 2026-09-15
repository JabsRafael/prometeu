import { afterEach, expect, it, vi } from "vitest";
import { use } from "./i18n";
import { available, choose, join, lang, listen } from "./voice";

class Fake {
  static last: Fake;
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn(() => { this.onerror?.({ error: "aborted" }); this.onend?.(); });
  constructor() { Fake.last = this; }
}

const result = (index: number, ...parts: [string, boolean][]) => ({
  resultIndex: index,
  results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })),
});

afterEach(() => { vi.unstubAllGlobals(); use("pt-BR"); });

it("reports absence instead of throwing when the webview lacks recognition", () => {
  expect(available()).toBe(false);
  const end = vi.fn();
  listen(vi.fn(), end);
  expect(end).toHaveBeenCalledWith("unavailable");
});

it("hands the caller newly settled text plus the interim tail, then ends once on stop", () => {
  vi.stubGlobal("webkitSpeechRecognition", Fake);
  expect(available()).toBe(true);
  use("pt-BR");
  const text = vi.fn();
  const end = vi.fn();
  const stop = listen(text, end);
  const r = Fake.last;
  expect(r.start).toHaveBeenCalled();
  expect(r.lang).toBe("pt-BR");
  expect(r.continuous && r.interimResults).toBe(true);

  r.onresult!(result(0, ["olá ", true], ["mun", false]));
  expect(text).toHaveBeenLastCalledWith("olá ", "mun");
  // The results list is cumulative; resultIndex points at the first entry that changed.
  r.onresult!(result(1, ["olá ", true], ["mundo", true]));
  expect(text).toHaveBeenLastCalledWith("mundo", "");

  r.onerror!({ error: "no-speech" });
  stop();
  expect(r.stop).toHaveBeenCalled();
  expect(end).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledWith(undefined);
});

it("dictates in the chosen language and falls back to the interface language", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  vi.stubGlobal("webkitSpeechRecognition", Fake);
  use("en");
  expect(lang()).toBe("en");
  choose("es-ES");
  listen(vi.fn(), vi.fn());
  expect(Fake.last.lang).toBe("es-ES");
  choose(null);
  expect(lang()).toBe("en");
});

it("discards the unsettled tail on request without reporting an error", () => {
  vi.stubGlobal("webkitSpeechRecognition", Fake);
  const end = vi.fn();
  const stop = listen(vi.fn(), end);
  stop(true);
  expect(Fake.last.abort).toHaveBeenCalled();
  expect(end).toHaveBeenCalledWith(undefined);
});

it("joins segments with a single space", () => {
  expect(join("Oi tudo bem", "vamos lá")).toBe("Oi tudo bem vamos lá");
  expect(join("Oi ", "tudo")).toBe("Oi tudo");
  expect(join("", "Oi")).toBe("Oi");
  expect(join("Oi", "")).toBe("Oi");
});

it("surfaces real errors when recognition ends", () => {
  vi.stubGlobal("webkitSpeechRecognition", Fake);
  const end = vi.fn();
  listen(vi.fn(), end);
  Fake.last.onerror!({ error: "not-allowed" });
  Fake.last.onend!();
  expect(end).toHaveBeenCalledWith("not-allowed");
});
