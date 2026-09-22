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

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); use("en"); });

it("reports absence instead of throwing when the webview lacks recognition", () => {
  expect(available()).toBe(false);
  const end = vi.fn();
  listen(vi.fn(), end);
  expect(end).toHaveBeenCalledWith("unavailable");
});

it("hands the caller newly settled text plus the interim tail, then ends once on stop", () => {
  vi.stubGlobal("webkitSpeechRecognition", Fake);
  expect(available()).toBe(true);
  use("en");
  const text = vi.fn();
  const end = vi.fn();
  const stop = listen(text, end);
  const r = Fake.last;
  expect(r.start).toHaveBeenCalled();
  expect(r.lang).toBe("en");
  expect(r.continuous && r.interimResults).toBe(true);

  r.onresult!(result(0, ["hello ", true], ["wor", false]));
  expect(text).toHaveBeenLastCalledWith("hello ", "wor");
  // The results list is cumulative; resultIndex points at the first entry that changed.
  r.onresult!(result(1, ["hello ", true], ["world", true]));
  expect(text).toHaveBeenLastCalledWith("world", "");

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

it("forces cleanup when the engine never ends after stop", () => {
  class Uncooperative extends Fake {
    stop = vi.fn();
    abort = vi.fn();
  }
  vi.useFakeTimers();
  vi.stubGlobal("webkitSpeechRecognition", Uncooperative);
  const end = vi.fn();
  const stop = listen(vi.fn(), end);

  stop();
  expect(end).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_000);

  expect(Fake.last.abort).toHaveBeenCalled();
  expect(end).toHaveBeenCalledTimes(1);
});

it("joins segments with a single space", () => {
  expect(join("Hello there", "let us go")).toBe("Hello there let us go");
  expect(join("Hello ", "there")).toBe("Hello there");
  expect(join("", "Hello")).toBe("Hello");
  expect(join("Hello", "")).toBe("Hello");
});

it("surfaces real errors when recognition ends", () => {
  vi.stubGlobal("webkitSpeechRecognition", Fake);
  const end = vi.fn();
  listen(vi.fn(), end);
  Fake.last.onerror!({ error: "not-allowed" });
  Fake.last.onend!();
  expect(end).toHaveBeenCalledWith("not-allowed");
});
