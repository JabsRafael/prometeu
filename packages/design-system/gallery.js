import { avatar, button, input, field, checkbox, toggle, radio, select, password, card, badge, notice, disclosure, menuButton, formDialog, confirmDialog, searchablePicker } from "./dist/index.js";

const examples = document.querySelector("#examples");
const output = notice("Interact with the components to see their states.");
const row = (...children) => {
  const root = document.createElement("div"); root.className = "ui-actions";
  root.append(...children); return root;
};
const disabled = button("Unavailable"); disabled.disabled = true;
const pending = button("Saving…", undefined, "pri"); pending.disabled = true; pending.setAttribute("aria-busy", "true");
examples.append(card("03 / Actions",
  row(button("Save", () => { output.textContent = "Changes saved."; }, "pri"), button("Cancel"), button("Edit", undefined, "ghost")),
  row(button("Delete account", async () => {
    output.textContent = await confirmDialog({ title: "Delete account?", message: "Demo: no data will be deleted.", accept: "Delete", cancel: "Cancel" }) ? "Deletion confirmed in the demo." : "Deletion cancelled.";
  }, "danger"), disabled, pending)));

const name = input(); name.name = "name"; name.autocomplete = "name"; name.required = true;
const email = input("invalid-email"); email.type = "email"; email.setAttribute("aria-invalid", "true");
const invalid = field("Email", email, "Enter a valid email."); invalid.querySelector(".ui-hint").classList.add("ui-error");
const project = select("cloud", [["cloud", "Prometeu Cloud"], ["desktop", "Prometeu Desktop"]]);
project.onchange = () => { output.textContent = `Selected project: ${project.value}.`; };
const unavailable = input("Unavailable"); unavailable.disabled = true;
const secret = password("", { show: "Show password", hide: "Hide password" });
examples.append(card("04 / Form", field("Name", name), invalid, field("Project", project.control),
  field("Password", secret.root), field("Disabled field", unavailable), checkbox("Keep settings for this project.", true).label));
examples.append(card("Notifications", toggle("Receive notifications", true).label,
  row(radio("Banner", "notification-style", "banner", true).label, radio("Notch", "notification-style", "notch", false).label)));

const details = document.createElement("p"); details.className = "ui-hint";
details.textContent = "Native disclosure: opens with Enter or Space.";
examples.append(card("05 / Feedback", output, notice("Could not save. Your data remains in the form.", "error"),
  notice("Check the code before authorizing your Mac.", "warning"), row(badge("Desktop"), badge("This session", true)),
  disclosure("Additional information", details)));

examples.append(card("06 / Menus and dialogs", menuButton("Project actions", () => [
  { label: "Rename", run: () => { output.textContent = "Rename selected."; } },
  { label: "Unavailable", disabled: true },
  { label: "Export", sub: [{ label: "Copy", run: () => { output.textContent = "Copy selected."; } }] },
  "sep",
  { label: "Delete", danger: true, run: () => { output.textContent = "Delete selected."; } },
]), button("Edit profile", () => {
  const name = input(); name.required = true;
  const simulate = checkbox("Simulate a save error", false);
  const project = select("cloud", [["cloud", "Prometeu Cloud"], ["desktop", "Prometeu Desktop"]]);
  const dialog = formDialog({
    title: "Edit profile", save: "Save", cancel: "Cancel", error: cause => cause.message,
    submit: async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
      if (simulate.control.checked) throw new Error("Could not save. Try again.");
      output.textContent = `Profile saved: ${name.value}.`;
    },
  });
  dialog.body.append(field("Profile name", name), field("Project", project.control), simulate.label);
  dialog.open();
})));

// Navigation uses the same underlined tabs and sidebar links emitted by the Rails adapter.
const tabs = document.createElement("nav"); tabs.className = "ui-tabs"; tabs.setAttribute("aria-label", "Catalog");
const sidebar = document.createElement("nav"); sidebar.className = "ui-stack"; sidebar.style.gap = "2px"; sidebar.style.maxWidth = "220px";
for (const [list, labels, current] of [[tabs, ["MCPs", "Plugins", "Skills"], "MCPs"], [sidebar, ["Profile", "Security", "Sessions"], "Security"]]) {
  for (const label of labels) {
    const link = document.createElement("a"); link.href = "#"; link.textContent = label;
    if (list === sidebar) link.className = "ui-nav-link";
    if (label === current) link.setAttribute("aria-current", "page");
    link.addEventListener("click", event => { event.preventDefault(); output.textContent = `${label} selected.`; });
    list.append(link);
  }
}
const identity = row(avatar(), avatar(undefined, "person", "md"), avatar(undefined, "organization", "md"), avatar(undefined, "organization", "lg"));
const account = menuButton("Gustavo", () => [{ label: "Settings" }, "sep", { label: "Sign out", danger: true }]);
account.prepend(avatar());
examples.append(card("07 / Navigation", tabs, sidebar, identity, row(account)));

// Delivery stays local in the gallery; production hosts provide their own transport.
const { feedbackWidget } = await import("./dist/index.js");
feedbackWidget({
  labels: {
    trigger: "Feedback", title: "Leave your feedback", kind: "Type", problem: "Problem", idea: "Idea", other: "Other",
    description: "Description", attach: "Attach an image", capture: "Capture screen", remove: "Remove image",
    send: "Send private feedback", close: "Close", privacy: "Local demo: no data will be sent.",
    publicReport: "Report a bug publicly", publicReportHint: "Opens a public GitHub issue without sending data automatically.",
    invalidImage: "Use PNG, JPEG or WebP up to 5 MB.", empty: "Write your feedback.", success: "Feedback received in the demo.",
  },
  publicIssue: "https://github.com/prometeucorp/prometeu/issues/new",
  submit: async () => {}, error: cause => String(cause),
});


function pickerExample() {
  const selected = notice("No option selected");
  const starred = new Set();
  let picker;
  const items = () => Array.from({ length: 100 }, (_, n) => ({
    key: String(n), label: `Option ${String(n).padStart(3, "0")}`,
    detail: n === 0 ? "Accented description · Café · Codex" : `Detail ${n}`,
    group: n < 5 ? "Recent" : "All options", checked: n === 2, disabled: n === 98,
    secondary: { label: `${starred.has(n) ? "Unfavorite" : "Favorite"} Option ${String(n).padStart(3, "0")}`,
      pressed: starred.has(n), run: () => {
        if (starred.has(n)) starred.delete(n); else starred.add(n);
        picker.update(items());
      } },
  }));
  const trigger = button("Find option", () => {
    picker = searchablePicker(trigger, {
      label: "Available options", searchPlaceholder: "Search options", empty: "No options found",
      items: items(), select: key => { selected.textContent = `Selected: Option ${String(key).padStart(3, "0")}`; },
      refresh: { label: "Refresh options", run: () => picker.update(items(), "Catalog updated") },
      additional: { label: "Show additional options", checked: false,
        change: checked => picker.update(checked ? [...items(), { key: "extra", label: "Additional option" }] : items()) },
    });
  });
  return [trigger, selected];
}
/** The caller ranks each query itself, as an asynchronous file search would. */
function remotePickerExample() {
  const selected = notice("No file selected");
  const files = Array.from({ length: 100 }, (_, n) => `src/module-${String(n).padStart(3, "0")}/index.ts`);
  const results = query => files.filter(path => path.includes(query.toLowerCase())).slice(0, 20)
    .map(path => ({ key: path, label: path.split("/").pop(), detail: path.slice(0, path.lastIndexOf("/")) }));
  const trigger = button("Open file", () => {
    const picker = searchablePicker(trigger, {
      label: "Files", searchPlaceholder: "Search files by name", empty: "No files found", items: results(""),
      select: key => { selected.textContent = `Opened: ${key}`; },
      search: query => setTimeout(() => picker.update(results(query)), 150),
    });
  });
  return [trigger, selected];
}
examples.append(card("Remote search", ...remotePickerExample()));
examples.append(card("Search in large lists", ...pickerExample(), button("Search in dialog", () => {
  const dialog = formDialog({ title: "Search example", save: "Save", cancel: "Cancel", submit: async () => {}, error: String });
  dialog.body.append(...pickerExample()); dialog.open();
})));
