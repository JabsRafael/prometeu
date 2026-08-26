import { invoke } from "@tauri-apps/api/core";
import { Term } from "./term";
import type { DockKind } from "./types";

/// Os terminais do workspace que não são conversa: o `setup` que preparou o
/// worktree, o `run` que sobe o projeto, e um shell para você. Um pty por tipo,
/// e o mesmo xterm desenha o que estiver na frente.
const term = new Term({ fontSize: 12, foreground: "#a4a09d", scrollback: 4000 });

export function init(el: HTMLElement) {
  term.open(el, (key, data) => {
    invoke("pty_write", { session: key, data });
  });
}

/// Abre (ou reabre) um dock. Reabrir não reinicia nada: o processo continua
/// vivo e a rolagem guardada redesenha a tela. `name` escolhe qual
/// `[scripts.run.<nome>]` subir, e só é lido quando não há um de pé.
export async function open(workspace: string, kind: DockKind, name?: string) {
  const { cols, rows } = term.dims();
  const key = await invoke<string>("open_dock", {
    id: workspace,
    kind,
    name: name ?? null,
    cols: cols || 80,
    rows: rows || 12,
  });
  await term.attach(key);
}

/// Só a rolagem de um processo que já morreu: o `✗ saiu com código` do setup
/// de ontem. Não reinicia nada, e não aceita tecla — não há para quem mandar.
export const show = (workspace: string, kind: DockKind) => term.show(`${workspace}:${kind}`);

export const detach = () => term.detach();
export const focus = () => term.focus();

/// A chave do pty aberto no dock, para quem precisa escrever nele de fora.
export const currentKey = () => term.current();

/// Mata o processo do dock. Só no botão explícito — trocar de aba não derruba
/// servidor de dev. Espera o back: quem sobe outro no lugar logo em seguida
/// não pode chegar antes e anexar ao que está morrendo.
export async function kill(workspace: string, kind: DockKind) {
  if (term.current() === `${workspace}:${kind}`) term.detach();
  await invoke("close_dock", { id: workspace, kind });
}
