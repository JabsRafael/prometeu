import { avatar, icon } from "./icons";
import { fromBack, t, tn } from "./i18n";
import * as menu from "./menu";
import * as session from "./session";
import * as team from "./team";
import { $, h } from "./util";

/// As notas de uma sessão: o que alguém do time precisa que você veja, e o que
/// você quer perguntar a alguém sem interromper o agente.
///
/// A nota não é uma mensagem para o agente — é um recado entre pessoas *sobre*
/// a sessão. Por isso mora no painel do lado, e não no terminal: o terminal é
/// do agente, e o que se escreve nele ele lê.
///
/// A âncora é a **citação**: o trecho que estava selecionado no terminal
/// quando a nota foi escrita. É o que faz "isso aqui está certo?" querer dizer
/// alguma coisa amanhã, sem o app ter que entender o que o agente escreveu.

type Ctx = {
  /// O workspace na tela, como a tela o chama (o de um colega vem prefixado).
  workspace: () => string | null;
  say: (text: string, isError?: boolean) => void;
};

let ctx: Ctx;
/// O que está sendo escrito, por workspace: trocar de aba, receber nota nova ou
/// o quadro redesenhar não pode apagar o que a pessoa digitou.
const drafts = new Map<string, { text: string; quote: string | null; mentions: string[] }>();
/// A nota a destacar no próximo desenho — de onde a caixa "Para mim" leva.
let highlight: string | null = null;

export function init(context: Ctx) {
  ctx = context;
  team.onChange(() => {
    if (!$("notes").hidden) draw();
    paintCount();
  });
  // A seleção no terminal é a citação: o botão só existe quando há uma.
  session.onSelection(() => {
    if (!$("notes").hidden) drawQuoteButton();
  });
}

const draftOf = (ws: string) => {
  let d = drafts.get(ws);
  if (!d) {
    d = { text: "", quote: null, mentions: [] };
    drafts.set(ws, d);
  }
  return d;
};

/// Abre o painel já citando o que está selecionado no terminal — o ⌘⇧M, e o
/// botão que aparece quando há seleção.
export function quoteSelection() {
  const ws = ctx.workspace();
  const sel = session.selection().trim();
  if (!ws || !sel) return false;
  draftOf(ws).quote = sel;
  draw();
  ($("notes").querySelector("textarea") as HTMLTextAreaElement | null)?.focus();
  return true;
}

/// Quantas notas deste workspace, na aba do painel.
export function paintCount() {
  const ws = ctx.workspace();
  const n = ws ? team.notesOf(ws).length : 0;
  $("notecount").textContent = n ? String(n) : "";
}

export function draw() {
  const ws = ctx.workspace();
  const box = $("notes");
  box.replaceChildren();
  if (!ws) return;
  const me = team.status();
  if (!me.config) {
    box.append(h("div", "nohint", t("notes.emptyNoTeam")));
    return;
  }

  const list = team.notesOf(ws);
  const feed = h("div", "notefeed");
  if (!list.length) feed.append(h("div", "nohint", t("notes.empty")));
  for (const note of list) {
    const mine = note.author === me.you;
    const name = mine ? t("notes.byYou") : team.nameOf(note.author);
    const el = h(
      "div",
      "note" + (note.mentions.includes(me.you ?? "") ? " forme" : "") + (note.id === highlight ? " lit" : ""),
      `<div class="who">${avatar(name)}<b></b><span class="when"></span></div>`,
    );
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
    feed.append(el);
  }
  box.append(feed, composer(ws));
  // A seleção pode ter acontecido antes de o painel abrir — o botão não pode
  // depender de ela mudar depois disso.
  drawQuoteButton();
  if (highlight) {
    box.querySelector(".note.lit")?.scrollIntoView({ block: "center" });
    highlight = null;
  } else {
    feed.scrollTop = feed.scrollHeight;
  }
  paintCount();
}

/// Leva até uma nota: acende ela no próximo desenho.
export function focusNote(id: string) {
  highlight = id;
  draw();
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

function composer(ws: string): HTMLElement {
  const draft = draftOf(ws);
  const box = h("div", "notenew");

  if (draft.quote) {
    const chip = h("div", "quoted", `${icon("message-square", 12)}<span></span>`);
    chip.children[1].textContent = tn(draft.quote.split("\n").length, "notes.quote");
    const drop = h("button", "ico sm", icon("x", 12));
    drop.title = t("notes.quote.drop");
    drop.addEventListener("click", () => {
      draft.quote = null;
      draw();
    });
    chip.append(drop);
    box.append(chip);
  }

  const area = document.createElement("textarea");
  area.placeholder = t("notes.write");
  area.value = draft.text;
  area.rows = 3;
  area.addEventListener("input", () => (draft.text = area.value));

  const send = () => {
    const text = area.value.trim();
    if (!text) return;
    try {
      team.addNote(ws, text, mentionsIn(text), draft.quote);
    } catch (e) {
      return ctx.say(fromBack(e), true);
    }
    drafts.delete(ws);
    draw();
  };

  // ⌘↵ envia; Enter simples quebra linha — uma nota costuma ter duas.
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
    // O @ abre a lista do time em vez de deixar você adivinhar o nome exato.
    if (e.key === "@") {
      e.preventDefault();
      pickMention(area, draft);
    }
  });
  box.append(area);

  const row = h("div", "row");
  const at = h("button", "ico sm", icon("at-sign", 13));
  at.title = t("notes.mention");
  at.addEventListener("click", () => pickMention(area, draft));
  const go = h("button", "pri md", t("notes.send"));
  go.addEventListener("click", send);
  row.append(at, h("span", "spacer"), go);
  box.append(row);
  return box;
}

/// Quem foi marcado: os nomes do time que aparecem com @ no texto. O relay
/// descarta quem não existe, mas o id é daqui — o texto tem nome, não id.
function mentionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of team.status().members) {
    if (m.name && text.includes(`@${m.name}`)) out.push(m.id);
  }
  return out;
}

function pickMention(area: HTMLTextAreaElement, draft: { text: string }) {
  const me = team.status();
  const others = me.members.filter((m) => m.id !== me.you);
  if (!others.length) return;
  const at = area.getBoundingClientRect();
  menu.openAt(
    { x: at.left, y: at.bottom + 4 },
    others.map((m) => ({
      label: m.name,
      glyph: avatar(m.name),
      hint: m.online ? undefined : t("team.offline"),
      run: () => {
        const cut = area.selectionStart;
        area.value = `${area.value.slice(0, cut)}@${m.name} ${area.value.slice(cut)}`;
        draft.text = area.value;
        area.focus();
        area.selectionStart = area.selectionEnd = cut + m.name.length + 2;
      },
    })),
  );
}

/// O botão "Comentar a seleção", que só existe quando há seleção no terminal.
function drawQuoteButton() {
  const row = $("notes").querySelector(".notenew .row");
  if (!row) return;
  row.querySelector(".quotesel")?.remove();
  const sel = session.selection().trim();
  if (!sel) return;
  const b = h("button", "outline md quotesel", `${icon("message-square", 12)}<span></span>`);
  b.children[1].textContent = t("notes.quoteSelection");
  b.title = t("notes.quoteSelection.title");
  b.addEventListener("click", () => quoteSelection());
  row.prepend(b);
}

/// Hora do dia, ou o dia se foi antes de hoje: a nota de agora é a que
/// importa, e "14:32" lê mais rápido que uma data inteira.
function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}
