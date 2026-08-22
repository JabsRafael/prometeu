import { invoke } from "@tauri-apps/api/core";
import { Term } from "./term";

/// Segundo terminal do workspace: um shell no worktree, ou o script de run do
/// repositório. Não é sessão de agente — sem hook, sem card, sem quadro.
const term = new Term({ fontSize: 12, foreground: "#a4a09d", scrollback: 4000 });

export function init(el: HTMLElement) {
  term.open(el);
}

/// Abre (ou reabre) o dock de um workspace. Reabrir não reinicia nada: o
/// processo continua vivo e a rolagem guardada redesenha a tela.
export async function open(workspace: string, kind: "terminal" | "run") {
  const { cols, rows } = term.dims();
  const key = await invoke<string>("open_dock", {
    id: workspace,
    kind,
    cols: cols || 80,
    rows: rows || 12,
  });
  await term.attach(key);
}

export const detach = () => term.detach();
export const focus = () => term.focus();

/// A chave do pty aberto no dock, para quem precisa escrever nele de fora.
export const currentKey = () => term.current();

/// Mata o processo do dock. Só no botão explícito — trocar de aba não derruba
/// servidor de dev.
export function kill(workspace: string, kind: "terminal" | "run") {
  invoke("close_dock", { id: workspace, kind });
  if (term.current() === `${workspace}:${kind}`) term.detach();
}
