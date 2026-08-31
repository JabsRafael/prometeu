import { icon, fileIcon } from "./icons";
import { invoke } from "./ipc";
import * as menu from "./menu";

/// O "@" da caixa de escrever: a lista dos arquivos e pastas do workspace, que
/// encolhe a cada letra. É como se aponta um arquivo para o agente — tanto o
/// Claude Code quanto o Codex leem "@app/models/user.rb" como o arquivo, e não
/// como texto. Quem sabe o que existe é o back (`find_paths`), que pergunta ao
/// git; aqui só se desenha a lista e se escreve o caminho escolhido.
///
/// Na nota o "@" é outro: ali ele marca um colega (ver `notes.ts`). São dois
/// modos da mesma caixa, e nunca os dois ao mesmo tempo.

export type PathEntry = { name: string; path: string; dir: boolean };

/// O caminho que está sendo escrito: do "@" que começa palavra até o cursor,
/// sem espaço no meio. "@app/mo" é um; "user@x" e "@app já" não são.
export function typing(text: string, cut: number): { from: number; query: string } | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text.slice(0, cut));
  if (!m) return null;
  return { from: cut - m[1].length - 1, query: m[1] };
}

/// A lista aberta por aqui, se é daqui: o primeiro da lista é o que Enter e
/// Tab escolhem.
let picking: { first: () => void } | null = null;
/// A última busca pedida. O back demora o que demorar, e a resposta de uma
/// letra velha não pode passar por cima da lista da letra nova.
let asked = 0;

/// A cada letra na caixa: a lista acompanha o "@…" — e some quando ele some.
/// `recent` são os arquivos que o agente acabou de mexer, do último para o
/// primeiro: entre dois que combinam igual, eles vêm na frente.
export async function typed(area: HTMLTextAreaElement, id: string, recent: string[], onChange: () => void) {
  const at = typing(area.value, area.selectionStart);
  if (!at) return dismiss();

  const mine = ++asked;
  let list: PathEntry[] = [];
  try {
    list = await invoke<PathEntry[]>("find_paths", { id, query: at.query, recent });
  } catch {
    list = [];
  }
  if (mine !== asked) return;
  // Enquanto o back respondia a caixa mudou: quem manda é o que está escrito
  // agora, e a lista de antes não fala dele.
  const now = typing(area.value, area.selectionStart);
  if (!now || now.query !== at.query) return;
  if (!list.length) return dismiss();

  const put = (entry: PathEntry) => {
    picking = null;
    // O "@app/mo" que a pessoa digitou é o começo deste caminho, não texto a
    // mais: o caminho inteiro entra no lugar dele. Pasta termina em barra e
    // sem espaço, e a lista reabre com o que tem dentro; arquivo ganha o
    // espaço do que vem depois.
    const cut = area.selectionStart;
    const from = typing(area.value, cut)?.from ?? cut;
    const tail = entry.dir ? "/" : " ";
    area.value = `${area.value.slice(0, from)}@${entry.path}${tail}${area.value.slice(cut)}`;
    onChange();
    area.focus();
    area.selectionStart = area.selectionEnd = from + entry.path.length + 1 + tail.length;
    if (entry.dir) void typed(area, id, recent, onChange);
  };

  const box = area.getBoundingClientRect();
  menu.openAt(
    { x: box.left, y: box.top - 4, above: true },
    list.map((entry) => ({
      label: entry.path,
      glyph: entry.dir ? icon("folder", 14) : fileIcon(entry.name),
      run: () => put(entry),
    })),
    "cmds",
  );
  picking = { first: () => put(list[0]) };
}

/// Enter ou Tab com a lista aberta escrevem o primeiro caminho em vez de
/// mandar a fala. Diz se foi isso que aconteceu.
export function accept(): boolean {
  if (!picking || !menu.isOpen()) return false;
  menu.close();
  picking.first();
  return true;
}

/// Fecha a lista, se é a daqui que está aberta.
export function dismiss() {
  if (picking && menu.isOpen()) menu.close();
  picking = null;
}
