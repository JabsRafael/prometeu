import { ChatView, type Info } from "./chat";
import * as team from "./team";
import { $ } from "./util";

/// A conversa: o `claude` de verdade rodando atrás, e a tela desenhada a partir
/// do que ele escreve (`chat.ts`). Pergunta, plano e permissão chegam como
/// cards, e é aqui que se responde.

const view = new ChatView();

export function init(onError: (m: string) => void, info: () => Info) {
  view.open($("chatwrap"), { say: onError, info });
  team.setSink({
    live: (tab, bytes) => view.remoteWrite(tab, bytes),
    reset: (tab, bytes) => {
      if (tab === view.current()) view.attachRemote(tab, bytes);
    },
  });
}

/// Liga a tela numa conversa. `remote` é o id do workspace de um colega
/// quando a conversa é dele: aí as linhas vêm do relay, e não do back daqui.
export async function attach(id: string, remote?: string) {
  if (remote) {
    const r = await team.attach(remote, id);
    view.attachRemote(id, r.bytes);
  } else {
    await view.attach(id);
  }
  view.focus();
}

export function detach() {
  view.detach();
}

export const currentSession = () => view.current();
export const focus = () => view.focus();
export const refresh = () => view.refresh();
export const selection = () => view.selection();
export const insert = (text: string) => view.insert(text);
export const quoteSelection = () => view.quoteSelection();
export const focusNote = (id: string) => view.focusNote(id);
