import * as menu from "./menu";
import type { Command } from "./timeline";

/// Os comandos de barra da caixa: a lista que abre ao escrever "/" no começo
/// da fala, e encolhe a cada letra. Quem sabe quais existem é o agente — o
/// back pergunta ao subir o processo (`initialize`, ver `chat.rs`), e a
/// `Timeline` guarda a resposta. Aqui só se desenha a lista e se completa o
/// nome.

/// O comando que está sendo escrito: a barra no começo da caixa até o cursor,
/// sem espaço no meio. "/com" é um; "/compact já" não é mais (já está
/// escrito), e "/Users/x" é um caminho.
export function typing(text: string, cut: number): { query: string } | null {
  const m = /^\/([^\s/]*)$/.exec(text.slice(0, cut));
  return m ? { query: m[1] } : null;
}

/// O que o que foi digitado pode ser: primeiro os que começam assim, depois os
/// que têm uma parte começando assim — "commit" acha `caveman:caveman-commit`.
/// Cada grupo em ordem alfabética, para a lista ser a mesma toda vez.
export function matches<T extends { name: string }>(query: string, list: T[]): T[] {
  const q = query.toLowerCase();
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  const starts = sorted.filter((c) => c.name.toLowerCase().startsWith(q));
  const inside = sorted.filter((c) => !starts.includes(c) && c.name.toLowerCase().split(/[:-]/).some((w) => w.startsWith(q)));
  return [...starts, ...inside];
}

/// A descrição, curta o bastante para a ponta da linha: a primeira frase, e
/// não mais que isso. A de uma skill costuma ser um parágrafo.
export function brief(description: string, max = 72): string {
  const first = description.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  const one = first.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/// A lista aberta por aqui, se é daqui: o primeiro da lista é o que Enter e
/// Tab escolhem — a não ser que o nome já esteja inteiro, e aí Enter manda.
let picking: { first: () => void; exact: boolean } | null = null;

/// A cada letra na caixa: a lista acompanha o "/…" — e some quando ele some.
export function typed(area: HTMLTextAreaElement, all: Command[], onChange: () => void) {
  const at = typing(area.value, area.selectionStart);
  const list = at ? matches(at.query, all) : [];
  if (!at || !list.length) return dismiss();
  const put = (name: string) => {
    picking = null;
    // O "/com" que a pessoa digitou é o começo deste comando, não texto a
    // mais: o nome entra no lugar dele, com o espaço para o que vem depois.
    const cut = area.selectionStart;
    area.value = `/${name} ${area.value.slice(cut)}`;
    onChange();
    area.focus();
    area.selectionStart = area.selectionEnd = name.length + 2;
  };
  const box = area.getBoundingClientRect();
  menu.openAt(
    { x: box.left, y: box.top - 4, above: true },
    list.map((c) => ({ label: `/${c.name}`, hint: brief(c.description), run: () => put(c.name) })),
    "cmds",
  );
  picking = { first: () => put(list[0].name), exact: list.some((c) => c.name.toLowerCase() === at.query.toLowerCase()) };
}

/// Enter ou Tab com a lista aberta completam o primeiro nome em vez de mandar
/// a fala. Diz se foi isso que aconteceu. Com o nome já inteiro na caixa,
/// Enter fecha a lista e deixa a fala ir — Tab ainda completa, para ganhar o
/// espaço.
export function accept(tab: boolean): boolean {
  if (!picking || !menu.isOpen()) return false;
  menu.close();
  if (!tab && picking.exact) {
    picking = null;
    return false;
  }
  picking.first();
  return true;
}

/// Fecha a lista, se é a daqui que está aberta.
export function dismiss() {
  if (picking && menu.isOpen()) menu.close();
  picking = null;
}
