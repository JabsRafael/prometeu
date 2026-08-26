import { Term } from "./term";
import { $ } from "./util";

/// A conversa: o terminal onde o `claude` de verdade está rodando. Pergunta,
/// plano e permissão são da TUI do Claude Code, e ficam lá dentro — o app não
/// desenha card nenhum por cima.

const term = new Term({ fontSize: 13, foreground: "#eae8e6", scrollback: 8000 });

export function initTerminal() {
  term.open($("term"));
  window.addEventListener("resize", () => term.refit());
}

export async function attach(id: string) {
  await term.attach(id);
  term.focus();
}

export function detach() {
  term.detach();
}

export const currentSession = () => term.current();
export const focus = () => term.focus();
export const dims = () => term.dims();
