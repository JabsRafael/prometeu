import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { DockKind } from "./types";

/// Os terminais do workspace que não são conversa: o `setup` que preparou o
/// worktree, o `run` que sobe o projeto, e um shell para você. Um pty por tipo,
/// e o mesmo xterm desenha o que estiver na frente.
const term = new Terminal({
  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
  fontSize: 12,
  theme: {
    background: "#141110",
    foreground: "#a4a09d",
    cursor: "#d8c2b3",
    selectionBackground: "#373533",
  },
  scrollback: 4000,
});
const fit = new FitAddon();
const decoder = new TextDecoder("utf-8");
let key: string | null = null;
let host: HTMLElement;

export function init(el: HTMLElement) {
  host = el;
  term.loadAddon(fit);
  term.open(el);
  term.onData((data) => key && invoke("pty_write", { session: key, data }));
  new ResizeObserver(() => refit()).observe(el);

  listen<[string, number[]]>("pty", ({ payload: [session, bytes] }) => {
    if (session !== key) return;
    term.write(decoder.decode(new Uint8Array(bytes), { stream: true }));
  });
}

let pending = 0;
function refit() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    if (!host.clientHeight || !host.clientWidth) return;
    fit.fit();
    if (key) invoke("pty_resize", { session: key, cols: term.cols, rows: term.rows });
  });
}

/// Abre (ou reabre) um dock. Reabrir não reinicia nada: o processo continua
/// vivo e a rolagem guardada redesenha a tela. `name` escolhe qual
/// `[scripts.run.<nome>]` subir, e só é lido quando não há um de pé.
export async function open(workspace: string, kind: DockKind, name?: string) {
  key = await invoke<string>("open_dock", {
    id: workspace,
    kind,
    name: name ?? null,
    cols: term.cols || 80,
    rows: term.rows || 12,
  });
  term.reset();
  const buf = await invoke<number[]>("pty_buffer", { session: key });
  term.write(decoder.decode(new Uint8Array(buf)));
  refit();
}

/// Só a rolagem de um processo que já morreu: o `✗ saiu com código` do setup
/// de ontem. Não reinicia nada, e não aceita tecla — não há para quem mandar.
export async function show(workspace: string, kind: DockKind) {
  detach();
  const buf = await invoke<number[]>("pty_buffer", { session: `${workspace}:${kind}` });
  term.write(decoder.decode(new Uint8Array(buf)));
  refit();
}

export function detach() {
  key = null;
  term.reset();
}

/// Mata o processo do dock. Só no botão explícito — trocar de aba não derruba
/// servidor de dev. Espera o back: quem sobe outro no lugar logo em seguida
/// não pode chegar antes e anexar ao que está morrendo.
export async function kill(workspace: string, kind: DockKind) {
  if (key === `${workspace}:${kind}`) detach();
  await invoke("close_dock", { id: workspace, kind });
}

export function focus() {
  term.focus();
}

/// A chave do pty aberto no dock, para quem precisa escrever nele de fora.
export function currentKey() {
  return key;
}
