import { invoke } from "./ipc";
import { Term } from "./term";
import { isTerm, type DockKind } from "./types";

/// Os terminais do workspace que não são conversa: o `setup` que preparou o
/// worktree, o `run` que sobe o projeto, e os shells que você abriu. Um pty por
/// tipo, e dois xterms desenhando: os scripts ficam no painel da direita, de
/// canto, e o shell ocupa uma aba do centro. São dois porque valem ao mesmo
/// tempo — ver o run subir enquanto se digita no shell é o caso comum. É o
/// único terminal do app: a conversa com o agente não é um (ver `chat.ts`).
const SKIN = { fontSize: 12, foreground: "#a4a09d", scrollback: 4000 };
const scripts = new Term(SKIN);
const shells = new Term(SKIN);

/// Onde cada tipo desenha. `setup` e `run` no painel; terminal, no centro.
const view = (kind: DockKind) => (isTerm(kind) ? shells : scripts);
export type Where = "scripts" | "shell";
const at = (where: Where) => (where === "scripts" ? scripts : shells);

export function init(scriptsEl: HTMLElement, shellEl: HTMLElement) {
  const sink = (key: string, data: string) => {
    invoke("pty_write", { session: key, data });
  };
  scripts.open(scriptsEl, sink);
  shells.open(shellEl, sink);
}

/// O tamanho com que um pty nasce. O do painel é o que importa fora daqui: é
/// com ele que o `setup` de um worktree novo começa, antes de haver tela.
const size = (where: Where) => {
  const { cols, rows } = at(where).dims();
  return { cols: cols || 80, rows: rows || 12 };
};
export const dims = () => size("scripts");

/// Abre (ou reabre) um dock. Reabrir não reinicia nada: o processo continua
/// vivo e a rolagem guardada redesenha a tela. `name` escolhe qual
/// `[scripts.run.<nome>]` subir, e só é lido quando não há um de pé.
export async function open(workspace: string, kind: DockKind, name?: string) {
  const key = await invoke<string>("open_dock", {
    id: workspace,
    kind,
    name: name ?? null,
    ...size(isTerm(kind) ? "shell" : "scripts"),
  });
  await view(kind).attach(key);
}

/// Só a rolagem de um processo que já morreu: o `✗ saiu com código` do setup
/// de ontem. Não reinicia nada, e não aceita tecla — não há para quem mandar.
export const show = (workspace: string, kind: DockKind) => view(kind).show(`${workspace}:${kind}`);

/// Trocar de workspace larga os dois: o que está na tela é do worktree aberto.
export function detach() {
  scripts.detach();
  shells.detach();
}

export const focus = (where: Where) => at(where).focus();

/// A chave do pty aberto, para quem precisa escrever nele de fora.
export const currentKey = (where: Where) => at(where).current();

/// Mata o processo do dock. Só no botão explícito — trocar de aba não derruba
/// servidor de dev. Espera o back: quem sobe outro no lugar logo em seguida
/// não pode chegar antes e anexar ao que está morrendo.
export async function kill(workspace: string, kind: DockKind) {
  const term = view(kind);
  if (term.current() === `${workspace}:${kind}`) term.detach();
  await invoke("close_dock", { id: workspace, kind });
}
