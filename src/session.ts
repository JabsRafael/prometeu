import { invoke } from "@tauri-apps/api/core";
import { fromBack } from "./i18n";
import * as team from "./team";
import { Term } from "./term";
import { $ } from "./util";

/// A conversa: o terminal onde o `claude` de verdade está rodando. Pergunta,
/// plano e permissão são da TUI do Claude Code, e ficam lá dentro — o app não
/// desenha card nenhum por cima.

const term = new Term({ fontSize: 13, foreground: "#eae8e6", scrollback: 8000 });

/// Onde reclamar de tecla que não chegou ao PTY — o erro nasce fora de qualquer
/// clique, então não há onde mostrá-lo senão na barra.
let fail: (m: string) => void = () => {};

export function initTerminal(onError: (m: string) => void) {
  fail = onError;
  // A tecla vai para o PTY daqui — ou, numa conversa de colega, para o dono.
  term.open($("term"), (key, data) => {
    if (key === team.attachedTab()) team.write(data);
    else invoke("pty_write", { session: key, data }).catch((e) => fail(fromBack(e)));
  });
  term.onResize((key, cols, rows) => team.resized(key, cols, rows));
  team.setSink({
    live: (tab, bytes) => term.remoteWrite(tab, bytes),
    size: (tab, cols, rows) => {
      if (tab === term.current()) term.setSize(cols, rows);
    },
    reset: (tab, bytes, cols, rows) => {
      if (tab === term.current()) term.attachRemote(tab, bytes, cols, rows);
    },
  });
  window.addEventListener("resize", () => term.refit());
}

/// Liga o terminal numa conversa. `remote` é o id do workspace de um colega
/// quando a conversa é dele: aí os bytes vêm do relay, e não de um PTY daqui.
export async function attach(id: string, remote?: string) {
  if (remote) {
    const r = await team.attach(remote, id);
    term.attachRemote(id, r.bytes, r.cols, r.rows);
  } else {
    await term.attach(id);
  }
  term.focus();
}

export function detach() {
  term.detach();
}

export const currentSession = () => term.current();
export const focus = () => term.focus();
export const dims = () => term.dims();
export const selection = () => term.selection();
export const onSelection = (cb: (has: boolean) => void) => term.onSelection(cb);
