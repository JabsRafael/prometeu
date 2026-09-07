import { invoke } from "./ipc";
import { fromBack, t } from "./i18n";
import { h } from "./util";
import * as ui from "./ui";
import * as catalog from "./catalog";
import * as plugins from "./plugins";

export type Skill = { id: string; description: string; content: string };
let hub: Skill[] = [];
let say = (_text: string, _bad?: boolean) => {};
const watchers = new Set<() => void>();
export const onChange = (fn: () => void) => { watchers.add(fn); return () => watchers.delete(fn); };
export const packageIds = () => new Set(hub.map(s => `skill-${s.id}`));
export function init(report: typeof say) { say = report; void refresh().catch(e => say(fromBack(e), true)); }
export async function refresh() { hub = await invoke<Skill[]>("skill_hub"); for (const fn of watchers) fn(); }
async function changed() { await refresh(); await plugins.refresh(); await catalog.load(); }

function row(id: string, description: string, controls: HTMLElement[]) {
  const row = h("div", "setrow");
  const text = h("div", "txt"); text.append(h("b", "", id), h("span", "", description));
  const act = h("div", "act"); act.append(...controls); row.append(text, act); return row;
}
export function settingsRows(): HTMLElement[] {
  const rows = [row(t("skill.title"), t("skill.intro"), [ui.button(t("skill.add"), () => editor(null), "outline")])];
  for (const skill of hub) {
    rows.push(row(skill.id, `${skill.description} · ${catalog.tag("skills", skill.id)}`, [
      ui.button(t("actions.edit"), () => editor(skill), "ghost"),
      ...catalog.controls("skills", skill.id),
      ui.button(t("skill.remove"), () => {
        void invoke("skill_remove", { id: skill.id }).then(changed).catch(e => say(fromBack(e), true));
      }, "ghost"),
    ]));
  }
  for (const skill of catalog.current().skills.filter(s => !s.installed)) {
    const install = ui.button(t("catalog.install"), () => {
      install.disabled = true;
      void invoke("catalog_install_skill", { id: skill.id }).then(changed).catch(e => { install.disabled = false; say(fromBack(e), true); });
    }, "outline");
    rows.push(row(skill.id, `${skill.description} · ${t("catalog.notInstalled")}`, [install]));
  }
  return rows;
}
function editor(skill: Skill | null) {
  const revision = skill ? catalog.current().revision : null;
  const id = ui.input(skill?.id ?? ""); id.required = true; id.maxLength = 56;
  id.pattern = "[a-z0-9][a-z0-9-]{0,55}"; id.readOnly = !!skill;
  const description = ui.input(skill?.description ?? ""); description.required = true; description.maxLength = 2000;
  const content = ui.input(skill?.content ?? "", true); content.required = true; content.rows = 14; content.maxLength = 65536;
  const dialog = ui.formDialog({ title: t(skill ? "skill.edit" : "skill.add"), save: t("actions.save"), cancel: t("actions.cancel"), error: fromBack,
    submit: async () => {
      await invoke("skill_save", { revision, skill: { id: id.value.trim(), description: description.value.trim(), content: content.value } }); await changed();
    } });
  dialog.body.append(ui.field(t("skill.name"), id), ui.field(t("skill.description"), description),
    ui.field(t("skill.content"), content, t("skill.contentHint")),
    h("p", "ui-hint", t(skill && catalog.shared("skills", skill.id) ? "catalog.liveHint" : "catalog.privateHint")));
  dialog.open();
}
