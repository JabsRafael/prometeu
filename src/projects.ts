import { open } from "@tauri-apps/plugin-dialog";
import * as catalog from "./catalog";
import { invoke } from "./ipc";
import { fromBack, t } from "./i18n";
import { button, checkbox, formDialog } from "./ui";
import { h } from "./util";

export type CatalogProject = {
  id: string; source: string; note: string; revision: number | null;
  organization: string | null; organization_name: string | null; local_path: string | null;
};

export function settingsRows(say: (text: string, bad?: boolean) => void): HTMLElement[] {
  const add = button(t("projects.add"), () => openProjects(say));
  add.id = "projects-add";
  return [h("p", "ui-hint", t("projects.hint")), add];
}

export function openProjects(say: (text: string, bad?: boolean) => void) {
  let directory: string | null = null;
  let running = false;
  const choices: { item: CatalogProject; control: HTMLInputElement; status: HTMLElement }[] = [];
  const dialog = formDialog({
    title: t("projects.title"), save: t("projects.add"), cancel: t("actions.cancel"), error: fromBack,
    submit: async () => {
      if (!directory || !choices.some(choice => choice.control.checked)) throw t("projects.choose");
      running = true;
      for (const control of dialog.body.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) control.disabled = true;
      let failed = false;
      try {
        for (const choice of choices.filter(choice => choice.control.checked)) {
          choice.status.classList.remove("bad");
          choice.status.textContent = t("projects.cloning", { name: choice.item.id });
          try {
            const project = await install(choice.item, directory, false);
            choice.control.checked = false;
            choice.status.textContent = project.path;
          } catch (error) {
            failed = true;
            choice.status.classList.add("bad");
            choice.status.textContent = fromBack(error);
          }
        }
        await catalog.load();
        if (failed) throw t("projects.failed");
        say(t("projects.done"));
      } finally {
        running = false;
        for (const control of dialog.body.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) control.disabled = false;
      }
    },
  });
  const local = button(t("projects.local"), async () => {
    try {
      const path = await open({ directory: true, title: t("say.pickRepo") });
      if (typeof path !== "string") return;
      await invoke("add_project", { path });
      dialog.close();
    } catch (error) { say(fromBack(error), true); }
  }, "outline");
  const destination = button(t("projects.destination"), async () => {
    try {
      const path = await open({ directory: true, title: t("projects.destination") });
      if (typeof path === "string") { directory = path; destination.textContent = path; update(); }
    } catch (error) { say(fromBack(error), true); }
  }, "outline");
  destination.hidden = true;
  const list = h("div", "ui-stack");
  dialog.body.append(local, h("p", "ui-hint", t("projects.hint")), destination, list);
  dialog.save.disabled = true;
  function update() { dialog.save.disabled = running || !directory || !choices.some(choice => choice.control.checked); }
  dialog.open();
  void catalog.load().then(() => {
    if (!dialog.root.isConnected) return;
    const items = (catalog.current().projects ?? []).filter(item => !item.local_path);
    destination.hidden = !items.length;
    for (const item of items) {
      const row = h("div", "setrow");
      const text = h("div", "txt");
      const choice = checkbox(`${item.id} · ${item.organization_name ?? t("catalog.cloud")}`, false);
      choice.control.addEventListener("change", update);
      const status = h("div", "ui-hint", item.local_path ?? item.note);
      status.setAttribute("role", "status");
      status.style.whiteSpace = "pre-wrap";
      status.style.overflowWrap = "anywhere";
      text.append(choice.label, h("span", "", item.source), status);
      const link = button(t("projects.link"), async () => {
        try {
          const path = await open({ directory: true, title: t("say.pickRepo") });
          if (typeof path !== "string") return;
          link.disabled = true;
          status.classList.remove("bad");
          const project = await install(item, path, true);
          status.textContent = project.path;
          choice.control.checked = false;
          update();
        } catch (error) { status.classList.add("bad"); status.textContent = fromBack(error); }
        finally { link.disabled = false; }
      }, "ghost");
      row.append(text, link); list.append(row);
      choices.push({ item, control: choice.control, status });
    }
    if (!choices.length) list.append(h("p", "ui-hint", t("projects.empty")));
  }).catch(error => { list.textContent = fromBack(error); });
}

function install(item: CatalogProject, directory: string, existing: boolean) {
  return invoke("catalog_install_project", { id: item.id, organization: item.organization, revision: item.revision, directory, existing });
}
