import { avatar, icon } from "./icons";
import { t, tn } from "./i18n";
import * as menu from "./menu";
import * as team from "./team";
import { h, template } from "./util";
import type { Note } from "../relay/src/protocol";

/// As notas de uma sessão: o que alguém do time precisa que você veja, e o que
/// você quer perguntar a alguém sem interromper o agente.
///
/// A nota não é uma mensagem para o agente — é um recado entre pessoas *sobre*
/// a sessão. Ela mora dentro da conversa, na hora em que foi escrita, entre a
/// fala e a resposta a que se refere: é assim que "isso aqui está certo?" quer
/// dizer alguma coisa amanhã. O agente não a vê; o time, sim.
///
/// A âncora é a **citação**: o trecho que estava selecionado na conversa
/// quando a nota foi escrita.
///
/// Quem desenha a conversa é o `chat.ts`; aqui mora o que é só da nota — o
/// card, o rascunho, as menções.

/// O que está sendo escrito, por workspace: trocar de aba, receber nota nova ou
/// o quadro redesenhar não pode apagar o que a pessoa digitou.
export type Draft = { text: string; quote: string | null };
const drafts = new Map<string, Draft>();

export const draftOf = (ws: string): Draft => {
  let d = drafts.get(ws);
  if (!d) {
    d = { text: "", quote: null };
    drafts.set(ws, d);
  }
  return d;
};

export const dropDraft = (ws: string) => void drafts.delete(ws);

/// O card de uma nota, como aparece dentro da conversa.
export function card(note: Note, lit = false): HTMLElement {
  const me = team.status();
  const mine = note.author === me.you;
  const name = mine ? t("notes.byYou") : team.nameOf(note.author);
  const el = template(
    "div",
    "note" + (note.mentions.includes(me.you ?? "") ? " forme" : "") + (lit ? " lit" : ""),
    `<div class="who">${avatar(name)}<b></b><span class="when"></span></div>`,
  );
  el.dataset.note = note.id;
  el.querySelector("b")!.textContent = name;
  el.querySelector(".when")!.textContent = when(note.ts);
  if (note.quote) {
    const q = h("pre", "quote");
    q.textContent = note.quote;
    el.append(q);
  }
  const body = h("div", "body");
  // O @nome de quem está no time fica aceso; o resto é texto como veio.
  body.append(...mark(note.text));
  el.append(body);
  return el;
}

/// `@Alguém` do time vira destaque; o resto é o texto que a pessoa escreveu.
function mark(text: string): Node[] {
  const names = team
    .status()
    .members.map((m) => m.name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!names.length) return [document.createTextNode(text)];
  const out: Node[] = [];
  let rest = text;
  while (rest) {
    const at = rest.indexOf("@");
    if (at === -1) break;
    const found = names.find((n) => rest.startsWith(`@${n}`, at));
    if (!found) {
      out.push(document.createTextNode(rest.slice(0, at + 1)));
      rest = rest.slice(at + 1);
      continue;
    }
    if (at) out.push(document.createTextNode(rest.slice(0, at)));
    const tag = h("span", "at");
    tag.textContent = `@${found}`;
    out.push(tag);
    rest = rest.slice(at + 1 + found.length);
  }
  if (rest) out.push(document.createTextNode(rest));
  return out;
}

/// O chip "citando N linhas" em cima do campo, com o botão de tirar.
export function quoteChip(quote: string, drop: () => void): HTMLElement {
  const chip = template("div", "quoted", `${icon("message-square", 12)}<span></span>`);
  chip.children[1].textContent = tn(quote.split("\n").length, "notes.quote");
  const x = template("button", "ico sm", icon("x", 12));
  x.title = t("notes.quote.drop");
  x.addEventListener("click", drop);
  chip.append(x);
  return chip;
}

/// Quem foi marcado: os nomes do time que aparecem com @ no texto. O relay
/// descarta quem não existe, mas o id é daqui — o texto tem nome, não id.
export function mentionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of team.status().members) {
    if (m.name && text.includes(`@${m.name}`)) out.push(m.id);
  }
  return out;
}

/// A menção que está sendo escrita: do "@" que começa palavra até o cursor,
/// sem espaço no meio. "@ti" é uma; "gustavo@x" e "@Thiago já" não são.
export function typing(text: string, cut: number): { from: number; query: string } | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text.slice(0, cut));
  if (!m) return null;
  return { from: cut - m[1].length - 1, query: m[1] };
}

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/// Quem o que foi digitado pode ser: "th" acha Thiago Souza, e "so" também —
/// cada palavra do nome vale, sem ligar para acento nem maiúscula.
export function matches<T extends { name: string }>(query: string, people: T[]): T[] {
  const q = fold(query);
  return people.filter((p) => fold(p.name).split(/\s+/).some((w) => w.startsWith(q)));
}

/// A lista aberta por aqui, se é daqui: o primeiro da lista é o que Enter e
/// Tab escolhem, e é este menu — não outro — que fechar.
let picking: { first: () => void } | null = null;

/// A lista do time, para escolher quem marcar em vez de adivinhar o nome.
/// Abre no botão, ou enquanto se escreve "@…": a lista encolhe a cada letra, e
/// o nome escolhido entra no lugar do que foi digitado.
export function pickMention(area: HTMLTextAreaElement, onChange: () => void) {
  const me = team.status();
  const others = me.members.filter((m) => m.id !== me.you);
  const at = typing(area.value, area.selectionStart);
  const list = at ? matches(at.query, others) : others;
  if (!list.length) return dropMention();
  const box = area.getBoundingClientRect();
  const put = (name: string) => {
    picking = null;
    // O "@ti" que a pessoa digitou é o começo desta menção, não texto a mais:
    // o nome entra no lugar dele. Sem nada digitado, entra onde está o cursor.
    const cut = area.selectionStart;
    const from = typing(area.value, cut)?.from ?? cut;
    area.value = `${area.value.slice(0, from)}@${name} ${area.value.slice(cut)}`;
    onChange();
    area.focus();
    area.selectionStart = area.selectionEnd = from + name.length + 2;
  };
  menu.openAt(
    { x: box.left, y: box.top - 4 },
    list.map((m) => ({
      label: m.name,
      glyph: avatar(m.name),
      hint: m.online ? undefined : t("team.offline"),
      run: () => put(m.name),
    })),
  );
  picking = { first: () => put(list[0].name) };
}

/// A cada letra na caixa: a lista acompanha o "@…" — e some quando ele some.
export function typedMention(area: HTMLTextAreaElement, onChange: () => void) {
  if (typing(area.value, area.selectionStart)) pickMention(area, onChange);
  else dropMention();
}

/// Enter ou Tab com a lista aberta escolhem o primeiro nome em vez de mandar a
/// nota. Diz se havia lista para escolher.
export function acceptMention(): boolean {
  if (!picking || !menu.isOpen()) return false;
  menu.close();
  picking.first();
  return true;
}

function dropMention() {
  if (picking && menu.isOpen()) menu.close();
  picking = null;
}

/// Hora do dia, ou o dia se foi antes de hoje: a nota de agora é a que
/// importa, e "14:32" lê mais rápido que uma data inteira.
export function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}
