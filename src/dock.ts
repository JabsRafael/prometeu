import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

/// Segundo terminal do workspace: um shell no worktree, ou o script de run do
/// repositório. Não é sessão de agente — sem hook, sem card, sem quadro.
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

/// Abre (ou reabre) o dock de um workspace. Reabrir não reinicia nada: o
/// processo continua vivo e a rolagem guardada redesenha a tela.
export async function open(workspace: string, kind: "terminal" | "run") {
  key = await invoke<string>("open_dock", {
    id: workspace,
    kind,
    cols: term.cols || 80,
    rows: term.rows || 12,
  });
  term.reset();
  const buf = await invoke<number[]>("pty_buffer", { session: key });
  term.write(decoder.decode(new Uint8Array(buf)));
  refit();
}

export function detach() {
  key = null;
  term.reset();
}

/// Mata o processo do dock. Só no botão explícito — trocar de aba não derruba
/// servidor de dev.
export function kill(workspace: string, kind: "terminal" | "run") {
  invoke("close_dock", { id: workspace, kind });
  if (key === `${workspace}:${kind}`) detach();
}

export function focus() {
  term.focus();
}
