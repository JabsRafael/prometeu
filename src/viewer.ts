import { invoke } from "./ipc";
import { fromBack, t } from "./i18n";
import { highlight } from "./highlight";
import { md } from "./markdown";
import { decode, parse } from "./csv";
import { fileIcon, icon } from "./icons";
import { button } from "./ui";
import { $ } from "./util";

/// The file editor layers highlighted code over a transparent textarea.
/// Native text input keeps editing and undo behavior without another editor dependency.

/// The original disk text is the optimistic save guard.
/// If the agent changes the file during editing, the backend rejects the write.
let shown: { id: string; path: string; text: string } | null = null;
let request = 0;

/// Drafts survive file navigation and shield user edits from board refreshes.
/// Returning to the original text resumes disk updates unless a save is pending.
type Draft = { was: string; text: string };
const drafts = new Map<string, Draft>();
const saving = new Set<string>();
const key = (id: string, path: string) => `${id}\n${path}`;

let fail: (m: string) => void = () => {};
/// Notify Changes when a local edit modifies disk without an agent event.
let saved: (id: string) => void = () => {};
let frame = 0;
let reading = false;

const box = () => $("vtext") as HTMLTextAreaElement;
const here = () => (shown ? key(shown.id, shown.path) : "");
const draft = () => drafts.get(here());

export function init(onError: (m: string) => void, onSaved: (id: string) => void) {
  fail = onError;
  saved = onSaved;
  const source = button(t("viewer.edit"), () => view(false), "ghost");
  source.id = "vsource";
  const preview = button(t("viewer.preview"), () => view(true), "ghost");
  preview.id = "vpreview";
  $("vview").setAttribute("aria-label", t("viewer.mode"));
  $("vview").append(source, preview);
  $("vcopy").innerHTML = icon("copy");
  $("vcopy").addEventListener("click", () => {
    if (!shown) return;
    navigator.clipboard.writeText(shown.path).catch((e) => fail(fromBack(e)));
  });
  $("vsave").innerHTML = icon("check");
  $("vsave").addEventListener("click", () => void save());
  $("vcancel").innerHTML = icon("x");
  $("vcancel").addEventListener("click", () => void revert());

  const text = box();
  text.addEventListener("input", typed);
  // Only .vcode scrolls; native textarea scrolling would misalign the two layers.
  text.addEventListener("scroll", () => {
    text.scrollTop = 0;
    text.scrollLeft = 0;
  });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void revert();
      return;
    }
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
      return;
    }
    // insertText indents without replacing the browser undo history.
    if (e.key === "Tab") {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
      typed();
    }
  });
}

/// Board events refresh open files; preserve scrolling when the content is unchanged.
export async function show(id: string, path: string) {
  const kind = /\.pdf$/i.test(path) ? "pdf" : /\.csv$/i.test(path) ? "csv" : null;
  if (kind) return showBlob(id, path, kind);
  const k = key(id, path);
  const same = shown?.id === id && shown.path === path;
  const currentRequest = ++request;
  // An unsaved draft owns the displayed text.
  if (same && drafts.has(k)) return;

  let text = "";
  let error = "";
  try {
    text = await invoke("read_file", { id, rel: path });
  } catch (e) {
    error = fromBack(e);
  }
  if (currentRequest !== request) return;
  // The user may start typing while the disk read is pending.
  if (shown?.id === id && shown.path === path && drafts.has(k)) return;
  if (same && shown!.text === text && !error) return;
  shown = { id, path, text };
  crumb(path);
  blob(false);
  if (!same) reading = false;
  $("vview").hidden = !!error || !/\.(md|markdown)$/i.test(path);

  // Unreadable, binary, or oversized files display an error instead of an editable buffer.
  const ta = box();
  ta.hidden = !!error;
  if (error) {
    drafts.delete(k);
    $("vgutter").textContent = "";
    $("vpre").innerHTML = `<span class="h-c"></span>`;
    $("vpre").children[0].textContent = error;
    chrome();
    return;
  }

  // Restore the draft and the disk baseline from when editing began.
  const pending = drafts.get(k);
  if (pending) shown = { id, path, text: pending.was };
  const value = pending ? pending.text : text;

  // Preserve the selection when refreshing the same file.
  const at = same ? [ta.selectionStart, ta.selectionEnd] : [0, 0];
  ta.value = value;
  if (same) ta.setSelectionRange(Math.min(at[0], value.length), Math.min(at[1], value.length));
  paint();
  chrome();
  view(reading);
  if (!same) {
    $("vcode").scrollTo(0, 0);
    $("vread").scrollTo(0, 0);
  }
}

function view(next: boolean) {
  reading = next;
  $("vcode").hidden = next;
  $("vread").hidden = !next;
  $("vsource").setAttribute("aria-pressed", String(!next));
  $("vpreview").setAttribute("aria-pressed", String(next));
  if (next) $("vread").innerHTML = md(box().value);
}

function crumb(path: string) {
  const cut = path.lastIndexOf("/");
  const el = $("vcrumb");
  el.innerHTML = `${fileIcon(path.slice(cut + 1), 14)}<span class="dir"></span><span class="nm"></span>`;
  el.children[1].textContent = cut === -1 ? "" : path.slice(0, cut + 1);
  el.children[2].textContent = path.slice(cut + 1);
}

/// PDF and CSV use #vfile. Release the previous PDF URL, which retains the entire file.
let pdfUrl = "";
function blob(on: boolean) {
  // The tab already names the file, and these formats have no save controls.
  $("vbar").hidden = on;
  $("vcode").hidden = on;
  $("vread").hidden = true;
  $("vfile").hidden = !on;
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = "";
  // Clear the iframe when switching from PDF to CSV.
  $("vfile").replaceChildren();
}

/// WebKit renders PDF in an iframe; CSV uses a table.
/// Read bytes only when the disk stamp changes to avoid large reads on every board event.
async function showBlob(id: string, path: string, kind: "pdf" | "csv") {
  const same = shown?.id === id && shown.path === path;
  const currentRequest = ++request;
  let stamp = "";
  let bytes: ArrayBuffer | null = null;
  let error = "";
  try {
    stamp = await invoke("file_stamp", { id, rel: path });
    if (currentRequest !== request) return;
    if (same && shown!.text === stamp) return;
    bytes = await invoke("read_bytes", { id, rel: path });
  } catch (e) {
    error = fromBack(e);
  }
  if (currentRequest !== request) return;
  shown = { id, path, text: stamp };
  crumb(path);
  reading = false;
  $("vview").hidden = true;
  chrome();
  $("vgutter").textContent = "";
  $("vpre").innerHTML = "";
  box().hidden = true;
  blob(!error);
  if (error) {
    $("vpre").innerHTML = `<span class="h-c"></span>`;
    $("vpre").children[0].textContent = error;
    return;
  }
  const into = $("vfile");
  into.className = `vfile ${kind}`;
  if (kind === "pdf") {
    pdfUrl = URL.createObjectURL(new Blob([bytes!], { type: "application/pdf" }));
    const frame = document.createElement("iframe");
    frame.src = pdfUrl;
    into.append(frame);
    return;
  }
  table(into, parse(decode(bytes!)));
}

/// Append CSV rows in batches to avoid rendering a large file into the DOM at once.
function table(into: HTMLElement, rows: string[][]) {
  const [head, ...body] = rows;
  const t = document.createElement("table");
  const thead = t.createTHead().insertRow();
  for (const h of head ?? []) thead.append(Object.assign(document.createElement("th"), { textContent: h }));
  const tbody = t.createTBody();
  const end = document.createElement("div");
  into.append(t, end);
  let at = 0;
  const more = () => {
    // Keep the viewport at the bottom after each batch while the user remains there.
    // Require positive scrollTop so an empty container does not load every batch immediately.
    const bottom = into.scrollTop > 0 && into.scrollTop + into.clientHeight >= into.scrollHeight - 1;
    const stop = Math.min(body.length, at + 500);
    for (; at < stop; at++) {
      const tr = tbody.insertRow();
      for (let c = 0; c < head.length; c++) tr.insertCell().textContent = body[at][c] ?? "";
    }
    if (at >= body.length) return watch.disconnect();
    if (bottom) {
      into.scrollTop = into.scrollHeight;
      requestAnimationFrame(more);
    }
  };
  const watch = new IntersectionObserver((hits) => hits[0].isIntersecting && more(), { root: into });
  more();
  watch.observe(end);
}

function typed() {
  if (!shown) return;
  const value = box().value;
  const k = here();
  const was = drafts.get(k)?.was ?? shown.text;
  // Reverting to the baseline resumes disk updates, except while a save can still change that baseline.
  if (value === was && !saving.has(k)) drafts.delete(k);
  else drafts.set(k, { was, text: value });
  chrome();
  soon();
}

/// Highlighting scans the whole file; coalesce typing into one pass per animation frame.
function soon() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(paint);
}

function paint() {
  cancelAnimationFrame(frame);
  const text = box().value;
  // Include the trailing empty line because it remains editable.
  const rows: string[] = [];
  for (let i = 1; i <= text.split("\n").length; i++) rows.push(String(i));
  $("vgutter").textContent = rows.join("\n");
  $("vpre").innerHTML = highlight(text, shown?.path ?? "");
}

/// Show save and discard controls only for unsaved drafts.
function chrome() {
  const dirty = !!draft();
  $("vsave").hidden = !dirty;
  $("vcancel").hidden = !dirty;
  ($("vsave") as HTMLButtonElement).disabled = saving.has(here());
  ($("vcancel") as HTMLButtonElement).disabled = saving.has(here());
  $("vcrumb").classList.toggle("dirty", dirty);
}

/// Discard the draft and reload the current disk contents.
async function revert() {
  if (!shown || !draft() || saving.has(here())) return;
  const { id, path, text } = shown;
  drafts.delete(here());
  box().value = text;
  paint();
  chrome();
  await show(id, path);
}

async function save() {
  if (!shown || !draft() || saving.has(here())) return;
  const { id, path, text: was } = shown;
  const k = here();
  const text = box().value;
  saving.add(k);
  chrome();
  try {
    await invoke("write_file", { id, rel: path, text, was });
    // Only the submitted version becomes clean; newer edits use the saved text as their baseline.
    const pending = drafts.get(k);
    if (pending && pending.text !== text) drafts.set(k, { was: text, text: pending.text });
    else drafts.delete(k);
    if (here() === k) shown = { id, path, text };
    saved(id);
  } catch (e) {
    fail(fromBack(e));
  } finally {
    saving.delete(k);
    const pending = drafts.get(k);
    if (pending?.text === pending?.was) drafts.delete(k);
    chrome();
  }
}
