import type { Note } from "../relay/src/protocol";
import { NOTE_QUOTE_MAX, NOTE_TEXT_MAX } from "../relay/src/protocol";
import { avatar, icon } from "./icons";
import { t, tn } from "./i18n";
import * as menu from "./menu";
import * as team from "./team";
import { h, template } from "./util";

/// Comments are persistent collaboration threads beside the transcript; they remain until someone resolves them.

export type Target = { tab: string; anchor: string | null; quote: string | null };

type Ctx = {
  workspace: () => string | null;
  tab: () => string | null;
  open: () => void;
  focus: (anchor: string) => void;
  say: (text: string, isError?: boolean) => void;
};

type Draft = Target & { text: string };
type Selected = { workspace: string; tab: string; id: string };

let ctx: Ctx;
let filter: "open" | "resolved" = "open";
let selected: Selected | null = null;
let revealSelected = false;
let redrawPending = false;
const drafts = new Map<string, Draft>();
const replies = new Map<string, string>();
const sending = new Set<string>();

const draftKey = (ws: string, tab: string) => `${ws}\0${tab}`;
const isRoot = (note: Note) => !note.parent;
const isResolved = (note: Note) => note.resolved === true;

export function repliesOf(items: Note[], root: string): Note[] {
  return items.filter((note) => note.parent === root).sort((a, b) => a.ts - b.ts);
}

/// Legacy notes without a tab remain available across conversations. New comments belong to their originating tab.
export function rootsOf(items: Note[], tab: string | null): Note[] {
  const activity = (root: Note) => Math.max(root.ts, ...repliesOf(items, root.id).map((note) => note.ts));
  return items
    .filter((note) => isRoot(note) && (!note.tab || note.tab === tab))
    .sort((a, b) => activity(b) - activity(a));
}

export function init(context: Ctx) {
  ctx = context;
}

export function compose(target?: Partial<Target>) {
  const ws = ctx.workspace();
  const tab = target?.tab ?? ctx.tab();
  if (!ws || !tab) return;
  const key = draftKey(ws, tab);
  const old = drafts.get(key);
  drafts.set(key, {
    tab,
    anchor: target?.anchor ?? old?.anchor ?? null,
    quote: (target?.quote ?? old?.quote ?? null)?.slice(0, NOTE_QUOTE_MAX) ?? null,
    text: old?.text ?? "",
  });
  selected = null;
  ctx.open();
  render();
  document.querySelector<HTMLTextAreaElement>("#comments .commentdraft textarea")?.focus();
}

export function openThread(id: string) {
  const workspace = ctx.workspace();
  const tab = ctx.tab();
  if (!workspace || !tab) return;
  selected = { workspace, tab, id };
  revealSelected = true;
  ctx.open();
  render();
}

/// External redraws must preserve the input node while the user types; each keystroke updates the draft.
export function draw() {
  const root = document.getElementById("comments");
  if (!root || (document.activeElement instanceof HTMLTextAreaElement && root.contains(document.activeElement))) {
    redrawPending = true;
    paintCount();
    return;
  }
  redrawPending = false;
  render();
}

function drawAfterBlur() {
  setTimeout(() => {
    const root = document.getElementById("comments");
    if (!redrawPending || (document.activeElement instanceof HTMLTextAreaElement && root?.contains(document.activeElement))) return;
    redrawPending = false;
    render();
  });
}

function state() {
  const ws = ctx.workspace();
  const tab = ctx.tab();
  const items = ws ? team.notesOf(ws) : [];
  return { ws, tab, items, roots: rootsOf(items, tab) };
}

function paintCount() {
  if (!ctx) return;
  const count = state().roots.filter((note) => !isResolved(note)).length;
  const badge = document.getElementById("commentcount");
  if (badge) badge.textContent = count ? String(count) : "";
}

function render() {
  if (!ctx) return;
  const host = document.getElementById("comments");
  if (!host) return;
  const { ws, tab, items, roots } = state();
  paintCount();
  host.replaceChildren();
  if (!ws || !tab) return;

  if (selected && (selected.workspace !== ws || selected.tab !== tab)) {
    selected = null;
    revealSelected = false;
  }

  const selectedId = selected?.id;
  const current = selectedId ? roots.find((note) => note.id === selectedId) : null;
  if (current) {
    if (revealSelected && current.anchor) ctx.focus(current.anchor);
    revealSelected = false;
    return host.append(threadDetail(ws, current, items));
  }
  // Preserve the destination while notesOf waits for the relay.
  if (selected) {
    host.append(h("div", "commentempty", t("notes.loading")));
    return;
  }

  const bar = template(
    "div",
    "commentbar",
    `<div class="commentfilters"><button data-filter="open"></button><button data-filter="resolved"></button></div><span class="spacer"></span><button class="outline sm newcomment"></button>`,
  );
  const open = roots.filter((note) => !isResolved(note)).length;
  const resolved = roots.length - open;
  const openButton = bar.querySelector<HTMLButtonElement>("[data-filter=open]")!;
  const resolvedButton = bar.querySelector<HTMLButtonElement>("[data-filter=resolved]")!;
  openButton.textContent = `${t("notes.open")} ${open}`;
  resolvedButton.textContent = `${t("notes.resolved")} ${resolved}`;
  openButton.classList.toggle("on", filter === "open");
  resolvedButton.classList.toggle("on", filter === "resolved");
  openButton.onclick = () => {
    filter = "open";
    render();
  };
  resolvedButton.onclick = () => {
    filter = "resolved";
    render();
  };
  const create = bar.querySelector<HTMLButtonElement>(".newcomment")!;
  create.innerHTML = `${icon("plus", 12)}<span></span>`;
  create.querySelector("span")!.textContent = t("notes.new");
  create.onclick = () => compose();
  host.append(bar);

  const draft = drafts.get(draftKey(ws, tab));
  if (draft) host.append(draftCard(ws, draft));

  const visible = roots.filter((note) => isResolved(note) === (filter === "resolved"));
  const list = h("div", "commentlist");
  if (!visible.length) list.append(h("div", "commentempty", t(filter === "open" ? "notes.empty.open" : "notes.empty.resolved")));
  for (const note of visible) list.append(threadCard(note, items));
  host.append(list);
}

function draftCard(ws: string, draft: Draft): HTMLElement {
  const card = template(
    "div",
    "commentdraft",
    `<div class="drafthead"><span class="draftcontext"></span><button class="ico sm close"></button></div><div class="draftquote"></div><textarea rows="3" spellcheck="true"></textarea><div class="draftactions"><button class="ico sm mention"></button><span class="spacer"></span><button class="pri md submit"></button></div>`,
  );
  card.querySelector(".draftcontext")!.textContent = draft.anchor ? t("notes.new.context") : t("notes.new.general");
  const close = card.querySelector<HTMLButtonElement>(".close")!;
  close.innerHTML = icon("x", 13);
  close.title = t("notes.cancel");
  close.onclick = () => {
    drafts.delete(draftKey(ws, draft.tab));
    render();
  };
  const quote = card.querySelector<HTMLElement>(".draftquote")!;
  quote.hidden = !draft.quote;
  if (draft.quote) {
    quote.append(
      quoteChip(draft.quote, () => {
        draft.quote = null;
        draft.anchor = null;
        render();
      }),
      h("pre", "commentquote draftquote-text", draft.quote),
    );
  }
  const area = card.querySelector<HTMLTextAreaElement>("textarea")!;
  area.maxLength = NOTE_TEXT_MAX;
  area.placeholder = t("notes.write");
  area.value = draft.text;
  area.oninput = () => {
    draft.text = area.value;
    typedMention(area, () => (draft.text = area.value));
  };
  area.onblur = drawAfterBlur;
  const submit = async () => {
    const text = area.value.trim();
    const key = draftKey(ws, draft.tab);
    if (!text || sending.has(key)) return;
    sending.add(key);
    try {
      const sent = await team.addNote(ws, draft.tab, draft.anchor, text, mentionsIn(text), draft.quote);
      if (!sent) return ctx.say(t("err.team.down"), true);
      if (drafts.get(key) === draft && draft.text.trim() === text) drafts.delete(key);
      render();
    } finally { sending.delete(key); }
  };
  area.onkeydown = (event) => commentKey(event, submit);
  const mention = card.querySelector<HTMLButtonElement>(".mention")!;
  mention.innerHTML = icon("at-sign", 13);
  mention.title = t("notes.mention");
  mention.onclick = () => pickMention(area, () => (draft.text = area.value));
  const send = card.querySelector<HTMLButtonElement>(".submit")!;
  send.textContent = t("notes.send");
  send.onclick = submit;
  return card;
}

function threadCard(note: Note, items: Note[]): HTMLElement {
  const name = note.author === team.status().you ? t("notes.byYou") : team.nameOf(note.author);
  const card = template(
    "button",
    "commentcard" + (isResolved(note) ? " resolved" : ""),
    `<div class="commentwho"><span class="av"></span><b></b><time></time></div><pre class="commentquote"></pre><div class="commenttext"></div><div class="commentfoot"><span class="replycount"></span><span class="spacer"></span><span class="forme"></span></div>`,
  );
  card.querySelector(".av")!.innerHTML = avatar(name);
  card.querySelector("b")!.textContent = name;
  card.querySelector("time")!.textContent = when(note.ts);
  const quote = card.querySelector<HTMLElement>(".commentquote")!;
  quote.hidden = !note.quote;
  quote.textContent = note.quote ?? "";
  card.querySelector(".commenttext")!.append(...mark(note.text));
  const count = repliesOf(items, note.id).length;
  card.querySelector(".replycount")!.textContent = count ? tn(count, "notes.replies") : t("notes.noReplies");
  const mine = team.inboxItems().some((item) => item.ws === note.ws && item.id === note.id);
  card.querySelector(".forme")!.textContent = mine ? t("notes.you") : "";
  card.onclick = () => openThread(note.id);
  return card;
}

function threadDetail(ws: string, root: Note, items: Note[]): HTMLElement {
  const panel = h("div", "commentthread");
  const head = template("div", "threadhead", `<button class="ico sm back"></button><b></b><span class="spacer"></span><span class="threadstate"></span>`);
  const back = head.querySelector<HTMLButtonElement>(".back")!;
  back.innerHTML = icon("arrow-left", 14);
  back.title = t("notes.back");
  back.onclick = () => {
    selected = null;
    render();
  };
  head.querySelector("b")!.textContent = t("notes.thread");
  head.querySelector(".threadstate")!.textContent = t(isResolved(root) ? "notes.state.resolved" : "notes.state.open");
  panel.append(head);

  if (root.quote || root.anchor) {
    const context = h("button", "threadcontext") as HTMLButtonElement;
    context.textContent = root.quote ?? t("notes.context.open");
    context.title = root.anchor ? t("notes.context.open") : "";
    context.disabled = !root.anchor;
    if (root.anchor) context.onclick = () => ctx.focus(root.anchor!);
    panel.append(context);
  }

  const messages = h("div", "threadmessages");
  for (const note of [root, ...repliesOf(items, root.id)]) messages.append(message(note));
  panel.append(messages);

  if (!team.supportsThreads()) {
    panel.append(h("div", "commentcompat", t("notes.updateRelay")));
    return panel;
  }
  if (isResolved(root)) return panel;

  const answer = template(
    "div",
    "replybox",
    `<textarea rows="2" spellcheck="true"></textarea><div><button class="ico sm mention"></button><button class="ghost md resolve"></button><span class="spacer"></span><button class="pri md submit"></button></div>`,
  );
  const area = answer.querySelector<HTMLTextAreaElement>("textarea")!;
  area.maxLength = NOTE_TEXT_MAX;
  area.placeholder = t("notes.reply.write");
  area.value = replies.get(root.id) ?? "";
  area.oninput = () => {
    replies.set(root.id, area.value);
    typedMention(area, () => replies.set(root.id, area.value));
  };
  area.onblur = drawAfterBlur;
  const submit = async () => {
    const text = area.value.trim();
    if (!text || sending.has(root.id)) return;
    sending.add(root.id);
    try {
      if (!(await team.replyNote(ws, root.id, text, mentionsIn(text)))) return ctx.say(t("err.team.down"), true);
      if (replies.get(root.id)?.trim() === text) replies.delete(root.id);
      render();
    } finally { sending.delete(root.id); }
  };
  area.onkeydown = (event) => commentKey(event, submit);
  const mention = answer.querySelector<HTMLButtonElement>(".mention")!;
  mention.innerHTML = icon("at-sign", 13);
  mention.title = t("notes.mention");
  mention.onclick = () => pickMention(area, () => replies.set(root.id, area.value));
  const resolve = answer.querySelector<HTMLButtonElement>(".resolve")!;
  resolve.innerHTML = `${icon("check", 12)}<span></span>`;
  resolve.querySelector("span")!.textContent = t("notes.resolve");
  resolve.onclick = async () => {
    if (!(await team.resolveNote(ws, root.id))) ctx.say(t("err.team.down"), true);
  };
  const send = answer.querySelector<HTMLButtonElement>(".submit")!;
  send.textContent = t("notes.reply.send");
  send.onclick = submit;
  panel.append(answer);
  return panel;
}

function message(note: Note): HTMLElement {
  const name = note.author === team.status().you ? t("notes.byYou") : team.nameOf(note.author);
  const row = template("div", "commentmessage", `<span class="av"></span><div><div class="messagehead"><b></b><time></time></div><div class="messagebody"></div></div>`);
  row.querySelector(".av")!.innerHTML = avatar(name);
  row.querySelector("b")!.textContent = name;
  row.querySelector("time")!.textContent = when(note.ts);
  row.querySelector(".messagebody")!.append(...mark(note.text));
  return row;
}

function commentKey(event: KeyboardEvent, submit: () => void) {
  if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.isComposing && acceptMention()) {
    event.preventDefault();
  } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

function quoteChip(quote: string, drop: () => void): HTMLElement {
  const chip = template("div", "quoted", `${icon("message-square", 12)}<span></span>`);
  chip.children[1].textContent = tn(quote.split("\n").length, "notes.quote");
  const x = template("button", "ico sm", icon("x", 12));
  x.title = t("notes.quote.drop");
  x.addEventListener("click", drop);
  chip.append(x);
  return chip;
}

function mark(text: string): Node[] {
  const names = team.people().map((member) => member.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return [document.createTextNode(text)];
  const out: Node[] = [];
  let rest = text;
  while (rest) {
    const at = rest.indexOf("@");
    if (at === -1) break;
    const found = names.find((name) => rest.startsWith(`@${name}`, at));
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

export function mentionsIn(text: string): string[] {
  return team.people().filter((member) => member.name && text.includes(`@${member.name}`)).map((member) => member.id);
}

export function typing(text: string, cut: number): { from: number; query: string } | null {
  const match = /(?:^|\s)@(\S*)$/.exec(text.slice(0, cut));
  return match ? { from: cut - match[1].length - 1, query: match[1] } : null;
}

const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function matches<T extends { name: string }>(query: string, people: T[]): T[] {
  const folded = fold(query);
  return people.filter((person) => fold(person.name).split(/\s+/).some((word) => word.startsWith(folded)));
}

let picking: { first: () => void } | null = null;

export function pickMention(area: HTMLTextAreaElement, onChange: () => void) {
  const status = team.status();
  const others = team.people().filter((member) => member.id !== status.you);
  const at = typing(area.value, area.selectionStart);
  const list = at ? matches(at.query, others) : others;
  if (!list.length) return dropMention();
  const box = area.getBoundingClientRect();
  const put = (name: string) => {
    picking = null;
    const cut = area.selectionStart;
    const from = typing(area.value, cut)?.from ?? cut;
    area.value = `${area.value.slice(0, from)}@${name} ${area.value.slice(cut)}`;
    onChange();
    area.focus();
    area.selectionStart = area.selectionEnd = from + name.length + 2;
  };
  menu.openAt(
    { x: box.left, y: box.top - 4 },
    list.map((member) => ({
      label: member.name,
      glyph: avatar(member.name),
      hint: member.online ? undefined : t("team.offline"),
      run: () => put(member.name),
    })),
  );
  picking = { first: () => put(list[0].name) };
}

function typedMention(area: HTMLTextAreaElement, onChange: () => void) {
  if (typing(area.value, area.selectionStart)) pickMention(area, onChange);
  else dropMention();
}

function acceptMention(): boolean {
  if (!picking || !menu.isOpen()) return false;
  menu.close();
  picking.first();
  return true;
}

function dropMention() {
  if (picking && menu.isOpen()) menu.close();
  picking = null;
}

export function when(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}
