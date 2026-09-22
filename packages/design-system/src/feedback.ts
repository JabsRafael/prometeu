import { h } from "./dom.js";
import { button, field, input } from "./ui.js";

export type Feedback = { kind: "problem" | "idea" | "other"; description: string; image?: File };
export type FeedbackLabels = Record<"trigger" | "title" | "kind" | "problem" | "idea" | "other" | "description" | "attach" | "capture" | "remove" | "send" | "close" | "privacy" | "publicReport" | "publicReportHint" | "invalidImage" | "empty" | "success", string>;

/** Portable feedback composition. The host owns delivery, capture and translated copy. */
export function feedbackWidget(options: {
  labels: FeedbackLabels;
  submit: (feedback: Feedback) => Promise<void>;
  capture?: () => Promise<File | undefined>;
  error: (error: unknown) => string;
  publicIssue?: string;
  /** Checked on every open: while it answers, the panel offers that action instead of the form. */
  blocked?: () => { message: string; label: string; run: () => void } | undefined;
}) {
  const labels = options.labels;
  const root = h("div", "ui-feedback");
  if (typeof root.showPopover === "function") root.popover = "manual";
  const panel = h("section", "ui-feedback-panel");
  panel.hidden = true;
  panel.id = `feedback-${crypto.randomUUID()}`;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", labels.title);
  const form = document.createElement("form");
  const heading = h("div", "ui-feedback-heading");
  let busy = false;
  const close = () => { if (!busy) { cancelAttachment(); panel.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.focus(); } };
  heading.append(h("b", "", labels.title), button(labels.close, close, "ghost"));
  const publicReport = h("div", "ui-feedback-public");
  publicReport.hidden = !options.publicIssue;
  if (options.publicIssue) {
    const link = h("a", "ui-button outline md", labels.publicReport) as HTMLAnchorElement;
    link.href = options.publicIssue; link.target = "_blank"; link.rel = "noopener noreferrer";
    const hint = h("p", "ui-hint", labels.publicReportHint);
    hint.id = `feedback-public-${crypto.randomUUID()}`; link.setAttribute("aria-describedby", hint.id);
    publicReport.append(hint, link);
  }
  let kind: Feedback["kind"] = "problem";
  const kinds = h("div", "ui-feedback-kinds");
  kinds.setAttribute("role", "group"); kinds.setAttribute("aria-label", labels.kind);
  for (const value of ["problem", "idea", "other"] as const) {
    const choice = button(labels[value], () => {
      kind = value;
      for (const control of kinds.children) control.setAttribute("aria-pressed", String(control === choice));
    });
    choice.setAttribute("aria-pressed", String(value === kind)); kinds.append(choice);
  }
  const description = input("", true);
  description.required = true;
  description.maxLength = 4000;
  description.oninput = () => description.setCustomValidity("");
  const upload = input();
  upload.type = "file";
  upload.accept = "image/png,image/jpeg,image/webp";
  const preview = document.createElement("img");
  preview.alt = labels.attach;
  preview.hidden = true;
  let attached: File | undefined;
  let objectUrl: string | undefined;
  const status = h("p", "ui-hint");
  status.setAttribute("role", "status");
  const error = h("p", "ui-hint ui-error");
  error.setAttribute("role", "alert");
  const setImage = (file?: File) => {
    if (file && (!/^image\/(png|jpeg|webp)$/.test(file.type) || !file.size || file.size > 5 * 1024 * 1024)) throw new Error(labels.invalidImage);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    attached = file;
    objectUrl = file ? URL.createObjectURL(file) : undefined;
    if (objectUrl) preview.src = objectUrl;
    else preview.removeAttribute("src");
    preview.hidden = remove.hidden = !file;
  };
  let attachmentRevision = 0;
  let loading = false;
  const setLoading = (value: boolean) => {
    loading = value;
    send.disabled = busy || loading;
    form.setAttribute("aria-busy", String(busy || loading));
  };
  const cancelAttachment = () => { attachmentRevision++; setLoading(false); };
  const attach = async (file?: File | Promise<File>) => {
    const revision = ++attachmentRevision;
    setLoading(true);
    error.textContent = "";
    try {
      const image = await file;
      if (revision === attachmentRevision) setImage(image);
    } catch (cause) {
      if (revision === attachmentRevision) error.textContent = options.error(cause);
    } finally {
      if (revision === attachmentRevision) { upload.value = ""; setLoading(false); }
    }
  };
  const remove = button(labels.remove, () => { void attach(); });
  remove.hidden = true;
  upload.onchange = () => attach(upload.files?.[0]);
  panel.ondragover = event => {
    if (busy || form.hidden || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    panel.classList.add("ui-feedback-dropping");
  };
  panel.ondragleave = event => {
    if (!event.relatedTarget || !panel.contains(event.relatedTarget as Node)) panel.classList.remove("ui-feedback-dropping");
  };
  panel.ondrop = event => {
    panel.classList.remove("ui-feedback-dropping");
    if (busy || form.hidden || !event.dataTransfer?.files.length) return;
    event.preventDefault(); attach(event.dataTransfer.files[0]);
  };
  const attachments = h("div", "ui-feedback-attachments");
  attachments.append(field(labels.attach, upload), preview, remove);
  const setBusy = (value: boolean) => {
    busy = value;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("button, input, textarea, select")) control.disabled = value;
    setLoading(loading);
  };
  if (options.capture) {
    attachments.append(button(labels.capture, async () => {
      cancelAttachment();
      setBusy(true); error.textContent = "";
      root.classList.add("ui-feedback-capturing");
      try {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const file = await options.capture!();
        if (file) { setImage(file); upload.value = ""; }
      } catch (cause) { error.textContent = options.error(cause); }
      finally { root.classList.remove("ui-feedback-capturing"); setBusy(false); }
    }));
  }
  const send = button(labels.send, () => {}, "pri");
  send.type = "submit";
  form.append(kinds, field(labels.description, description), attachments,
    h("p", "ui-hint", labels.privacy), error, status, send);
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || loading) return;
    if (!description.value.trim()) { description.setCustomValidity(labels.empty); description.reportValidity(); return; }
    setBusy(true); error.textContent = ""; status.textContent = "";
    try {
      await options.submit({ kind, description: description.value.trim(), image: attached });
      description.value = ""; upload.value = ""; setImage(); status.textContent = labels.success;

    } catch (cause) { error.textContent = options.error(cause); }
    finally { setBusy(false); }
  };
  const notice = h("div", "ui-feedback-notice");
  notice.hidden = true;
  panel.append(heading, publicReport, notice, form);
  const trigger = button(labels.trigger, () => {
    if (!panel.hidden) return close();
    const stop = options.blocked?.();
    notice.replaceChildren();
    notice.hidden = !stop;
    form.hidden = !!stop;
    if (stop) notice.append(h("p", "ui-hint", stop.message), button(stop.label, stop.run, "pri"));
    panel.hidden = false; status.textContent = "";
    trigger.setAttribute("aria-expanded", "true");
    (stop ? notice.querySelector("button")! : description).focus();
  }, "pri");
  trigger.classList.add("ui-feedback-trigger");
  trigger.setAttribute("aria-controls", panel.id);
  trigger.setAttribute("aria-expanded", "false");
  root.append(panel, trigger);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault(); event.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  // A modal makes body siblings inert. Move into the newest modal, then re-enter the top layer.
  const place = () => {
    const dialogs = document.querySelectorAll("dialog[open]");
    const parent = dialogs[dialogs.length - 1] ?? document.body;
    if (root.parentElement !== parent) { root.hidePopover?.(); parent.append(root); root.showPopover?.(); }
  };
  const observer = new MutationObserver(place);
  document.body.append(root); root.showPopover?.(); place();
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
  return {
    root, trigger, attach,
    canAttach: () => !panel.hidden && !form.hidden && !busy,
    destroy() { cancelAttachment(); observer.disconnect(); document.removeEventListener("keydown", onKey, true); if (objectUrl) URL.revokeObjectURL(objectUrl); trigger.remove(); root.remove(); },
  };
}
