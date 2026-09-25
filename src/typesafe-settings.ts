import { fromBack, t } from "./i18n";
import { icon } from "./icons";
import * as typesafe from "./typesafe";
import { button, field, notice, password, toggle } from "./ui";
import { h, template } from "./util";

/// Settings for the optional TypeSafe integration. The key field is write-only: after saving, the
/// screen shows only whether a key exists. Saving a key never enables review by itself.
let feedback = "";

export function typesafeRows(say: (text: string, isError?: boolean) => void, redraw: () => void): HTMLElement[] {
  const status = typesafe.current();
  const row = template("div", "setrow typesafe-heading", `<span class="glyph">${icon("sparkles", 18)}</span><div class="txt"><b>TypeSafe</b><span></span></div>`);
  row.querySelector(".txt span")!.textContent = t("typesafe.pitch");

  const key = password("", { show: t("typesafe.key.show"), hide: t("typesafe.key.hide") });
  key.control.placeholder = t("typesafe.key.placeholder");
  key.control.autocomplete = "off";
  key.control.spellcheck = false;
  key.control.dataset.focus = "typesafe-key";
  const busy = (controls: HTMLButtonElement[], on: boolean) => controls.forEach(control => { control.disabled = on; });
  const run = async (controls: HTMLButtonElement[], work: () => Promise<unknown>, done: string) => {
    busy(controls, true);
    try { await work(); feedback = done; redraw(); }
    catch (error) { feedback = ""; say(fromBack(error), true); busy(controls, false); }
  };
  const save = button(t(status.configured ? "typesafe.key.replace" : "typesafe.key.save"), () => {
    if (!key.control.value.trim()) { key.control.focus(); return; }
    const replacing = typesafe.current().configured;
    void run([save, remove], () => typesafe.saveKey(key.control.value), t(replacing ? "typesafe.key.replaced" : "typesafe.key.saved"));
  });
  save.dataset.focus = "typesafe-save";
  const remove = button(t("typesafe.key.remove"), () => void run([save, remove], typesafe.removeKey, t("typesafe.key.removed")), "ghost");
  remove.dataset.focus = "typesafe-remove";
  remove.hidden = !status.configured;
  key.control.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); save.click(); } });
  const keyRow = h("div", "typesafe-key");
  keyRow.append(key.root, save, remove);
  const keyField = field(t("typesafe.key"), keyRow, t(status.configured ? "typesafe.key.configured" : "typesafe.key.missing"));

  const enabled = toggle(t("typesafe.enabled"), status.enabled);
  enabled.control.dataset.focus = "typesafe-enabled";
  enabled.control.disabled = !status.configured;
  enabled.control.title = t(status.configured ? "typesafe.enabled.hint" : "typesafe.enabled.needKey");
  enabled.control.onchange = () => {
    const on = enabled.control.checked;
    enabled.control.disabled = true;
    typesafe.setEnabled(on).then(() => { feedback = ""; }).catch(error => {
      enabled.control.checked = !on;
      enabled.control.disabled = false;
      say(fromBack(error), true);
    });
  };

  row.append(enabled.label);
  const rows: HTMLElement[] = [row, keyField, h("p", "ui-hint typesafe-flow", t("typesafe.flow"))];
  if (status.problem) rows.push(notice(fromBack(status.problem), "warning"));
  if (feedback) {
    const saved = h("p", "ui-hint", feedback);
    saved.setAttribute("role", "status");
    rows.push(saved);
  }
  return rows;
}
