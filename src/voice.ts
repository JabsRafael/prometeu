/// <reference types="vite/client" />
import { current } from "./i18n";

/// Browser speech recognition, when the webview offers it. Recognition runs on the platform's speech service; nothing crosses Prometeu's own boundaries, so no IPC is involved.

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

const engine = (): (new () => Recognition) | undefined => {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

/// Under `tauri dev` the binary is not launched by LaunchServices, so macOS ignores its usage descriptions and TCC aborts the process on the first recognition request. Hide the feature there; `npm run app:bundle` exercises the real path.
const devTauri = () => import.meta.env.DEV && "__TAURI_INTERNALS__" in globalThis;

export const available = () => !!engine() && !devTauri();

/// Dictation language preference, stored locally like the interface language. Null follows the interface language. Tags are what Apple speech and Web Speech accept; names come from Intl in the language itself.
export const TAGS = ["pt-BR", "pt-PT", "en-US", "en-GB", "es-ES", "es-MX", "fr-FR", "de-DE", "it-IT", "ja-JP", "zh-CN"] as const;
const STORE = "prometeu.voice.lang";

export const nameOf = (tag: string) => new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;

export function chosen(): string | null {
  try { return localStorage.getItem(STORE); } catch { return null; }
}

export function choose(tag: string | null) {
  try { tag ? localStorage.setItem(STORE, tag) : localStorage.removeItem(STORE); } catch { /* Preference simply does not persist. */ }
}

export const lang = () => chosen() ?? current();

/// Start dictation in the chosen language. `onText` receives the text newly settled since the previous call plus the current interim tail, so the caller appends the former and previews the latter. `onEnd` fires once when recognition stops for any reason. Returns a function that stops it; `discard` drops whatever is still unsettled instead of waiting for it.
export function listen(onText: (settled: string, interim: string) => void, onEnd: (error?: string) => void): (discard?: boolean) => void {
  const Ctor = engine();
  if (!Ctor) { onEnd("unavailable"); return () => {}; }
  const r = new Ctor();
  r.lang = lang();
  r.interimResults = true;
  r.continuous = true;
  let error: string | undefined;
  let active = true;
  let stopping = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (!active) return;
    active = false;
    r.onend = null;
    r.onresult = null;
    r.onerror = null;
    if (fallback) clearTimeout(fallback);
    onEnd(error);
  };
  r.onresult = (e) => {
    let settled = "";
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const piece = e.results[i][0].transcript;
      if (e.results[i].isFinal) settled += piece;
      else interim += piece;
    }
    onText(settled, interim);
  };
  // "aborted" is the user pressing stop; "no-speech" is silence. Neither deserves an error.
  r.onerror = (e) => { if (e.error !== "aborted" && e.error !== "no-speech") error = e.error; };
  r.onend = finish;
  r.start();
  return (discard = false) => {
    if (!active) return;
    if (discard) { try { r.abort(); } finally { finish(); } return; }
    if (stopping) return;
    stopping = true;
    r.stop();
    // Some webviews never emit `end` after `stop`; allow final results briefly, then force cleanup.
    if (active) fallback = setTimeout(() => { try { r.abort(); } finally { finish(); } }, 1_000);
  };
}

/// Speech segments arrive without a separating space; add one only where neither side has it.
export const join = (a: string, b: string) => (a && b && !/\s$/.test(a) && !/^\s/.test(b) ? `${a} ${b}` : a + b);
