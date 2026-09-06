import * as actions from "./actions";
import { descriptor, descriptors, effortsOf, modelLabelOf, modelsOf } from "./agents";
import { fromBack, t, type Key } from "./i18n";
import * as mcp from "./mcp";
import * as menu from "./menu";
import { icon } from "./icons";
import * as plugins from "./plugins";
import { h } from "./util";
import * as ui from "./ui";
import type { ProviderId } from "./types";

let scope = "";
const button = (key: Key, run: () => void) => ui.button(t(key), run);
const field = (key: Key, control: HTMLElement) => ui.field(t(key), control);
const checkbox = (key: Key, checked: boolean) => ui.checkbox(t(key), checked);
const { input, select } = ui;
function more(name: string, items: menu.Item[]) {
  const b = button("actions.more", () => {
    const box = b.getBoundingClientRect();
    menu.openAt({ x: box.right, y: box.bottom + 4 }, items);
  });
  b.className = "ico action-more";
  b.innerHTML = icon("ellipsis", 16);
  b.setAttribute("aria-label", `${t("actions.more")} · ${name}`);
  return b;
}
function section(title: Key, count: number, controls: HTMLElement[]) {
  const root = h("section", "action-section");
  const header = h("div", "action-section-head");
  const heading = h("h2", "", t(title)); heading.append(h("span", "action-count", String(count)));
  const tools = h("div", "action-toolbar"); tools.append(...controls);
  header.append(heading, tools); root.append(header);
  return root;
}
function card(title: string, description: string, glyph: Parameters<typeof icon>[0], edit: () => void, options: menu.Item[]) {
  const root = h("article", "action-card");
  const mark = h("span", "action-mark"); mark.innerHTML = icon(glyph, 19);
  const text = h("div", "action-card-copy");
  const heading = h("div", "action-card-title"); heading.append(h("b", "", title));
  text.append(heading, h("p", "action-description", description));
  const editButton = button("actions.edit", edit); editButton.className = "ghost sm action-edit";
  root.append(mark, text, editButton, more(title, options));
  return { root, heading, text };
}

export function settingsRows(redraw: () => void, say: (text: string, bad?: boolean) => void): HTMLElement[] {
  const catalog = actions.catalog();
  const commit = (next: actions.Catalog) => { void actions.save(next).then(redraw).catch(e => say(fromBack(e), true)); };
  const root = h("div", "actions-page");
  root.append(h("p", "actions-intro", t("actions.intro")));
  const create = button("actions.newCommand", () => commandEditor(null, redraw));
  create.className = "outline md";
  const commands = section("actions.commands", catalog.commands.length, [create]);
  const commandList = h("div", "action-list");
  for (const action of catalog.commands) {
    const profile = catalog.profiles.find(p => p.id === action.profile);
    const builtin = action.profile === "prometeu-code-review";
    const item = card(action.kind === "agent" ? profile?.name ?? action.name : action.name,
      action.description || t(builtin ? "actions.reviewDescription" : action.kind === "agent" ? "actions.agentDescription" : "actions.promptDescription"),
      action.kind === "agent" ? "sparkles" : "terminal", () => commandEditor(action, redraw), [{
        label: t("actions.remove"), run: () => {
          const next = structuredClone(catalog); next.commands = next.commands.filter(c => c.name !== action.name);
          if (next.pr_action === action.name) next.pr_action = null;
          commit(next);
        },
      }]);
    item.root.classList.add("action-command");
    item.heading.append(h("code", "action-shortcut", `/${action.name}`));
    item.text.append(h("span", "action-caption", t(action.kind === "agent" ? "actions.agent" : "actions.prompt")));
    commandList.append(item.root);
  }
  if (!catalog.commands.length) commandList.append(h("p", "action-empty", t("actions.noCommands")));
  commands.append(commandList);

  const scopeSelect = select(scope, [["", t("actions.global")], ...actions.projects().map(p => [p.id, p.name] as [string, string])]);
  scopeSelect.onchange = () => { scope = scopeSelect.value; redraw(); };
  const scopeField = field("actions.scope", scopeSelect.control); scopeField.classList.add("action-scope");
  const newAgent = button("actions.newProfile", () => profileEditor(null, "", redraw));
  const templates = more(t("actions.profiles"), [{ label: t("actions.deliveryName"), run: () => delivery(redraw, say) }]);
  const profiles = section("actions.profiles", catalog.profiles.length, [scopeField, newAgent, templates]);
  const profileList = h("div", "action-list");
  for (const base of catalog.profiles) {
    const overridden = scope && catalog.overrides[scope]?.[base.id];
    const profile = overridden || base;
    const model = profile.choice.model ? modelLabelOf(profile.choice.model, profile.choice.agent) : t("actions.default");
    const item = card(profile.name, `${descriptor(profile.choice.agent).label} · ${model}`,
      "eye", () => profileEditor(profile, scope, redraw), [{
        label: t(scope ? "actions.reset" : "actions.remove"), disabled: !!scope && !overridden,
        run: () => {
          const next = structuredClone(catalog);
          if (scope) delete next.overrides[scope]?.[base.id];
          else {
            if (next.commands.some(c => c.profile === base.id)) { say(t("err.actions.used"), true); return; }
            next.profiles = next.profiles.filter(p => p.id !== base.id);
            for (const overrides of Object.values(next.overrides)) delete overrides[base.id];
          }
          commit(next);
        },
      }]);
    item.root.classList.add("action-profile");
    if (overridden) item.heading.append(h("span", "action-badge", t("actions.override")));
    else if (base.id === "prometeu-code-review") item.heading.append(h("span", "action-badge", t("actions.included")));
    if (profile.watch) item.text.append(h("span", "action-caption", t("actions.watchEnabled")));
    profileList.append(item.root);
  }
  if (!catalog.profiles.length) profileList.append(h("p", "action-empty", t("actions.noProfiles")));
  profiles.append(profileList);

  const pr = select(catalog.pr_action ?? "", [["", t("actions.prLegacy")], ...catalog.commands.filter(c => c.kind === "agent").map(c => [c.name, `/${c.name}`] as [string, string])]);
  pr.onchange = () => commit({ ...catalog, pr_action: pr.value || null });
  const shortcut = ui.disclosure(t("actions.prButton"));
  shortcut.classList.add("action-pr");
  const summary = shortcut.querySelector("summary")!;
  summary.append(h("span", "action-caption", catalog.pr_action ? `/${catalog.pr_action}` : t("actions.prLegacy")));
  shortcut.append(field("actions.prAction", pr.control));
  root.append(commands, profiles, shortcut);
  return [root];
}

function sheet(title: string, build: (body: HTMLElement) => () => actions.Catalog, redraw: () => void) {
  const dialog = ui.formDialog({
    title, save: t("actions.save"), cancel: t("actions.cancel"), error: fromBack,
    submit: async () => { await actions.save(get()); redraw(); },
  });
  const get = build(dialog.body);
  dialog.open();
}

function selection(key: Key, values: string[] | null, available: string[]) {
  const root = h("div", "action-tool-picker");
  const inherit = checkbox("actions.inherit", values === null);
  const list = document.createElement("fieldset");
  list.className = "action-tool-list"; list.setAttribute("aria-label", t(key));
  const choices = [...new Set([...available, ...(values ?? [])])].map(id => {
    const { label, control: checked } = ui.checkbox(id, !!values?.includes(id));
    list.append(label);
    return { id, checked };
  });
  if (!choices.length) list.append(h("span", "action-caption", t("actions.noTools")));
  list.disabled = inherit.control.checked;
  inherit.control.onchange = () => { list.disabled = inherit.control.checked; };
  root.append(h("b", "action-tool-title", t(key)), inherit.label, list);
  return { root, get: () => inherit.control.checked ? null : choices.filter(c => c.checked.checked).map(c => c.id) };
}

function profileEditor(old: actions.Profile | null, project: string, redraw: () => void) {
  const profile: actions.Profile = structuredClone(old ?? {
    id: crypto.randomUUID(), name: "", prompt: "", choice: { agent: "claude", model: "", effort: "" },
    mcp: null, plugins: null, skills: [], permission: "ask", watch: null,
  });
  sheet(t("actions.profileEditor"), body => {
    const name = input(profile.name); name.required = true;
    const prompt = input(profile.prompt, true); prompt.required = true;
    const provider = select(profile.choice.agent, descriptors().map(d => [d.id, `${d.label}${d.installed ? "" : ` · ${t("actions.uninstalled")}`}`]));
    const model = select("", []);
    const effort = select("", []);
    const renderEffort = (value = "") => {
      const options: [string, string][] = [["", t("actions.default")], ...effortsOf(provider.value as ProviderId, model.value).map(e => [e, e] as [string, string])];
      if (value && !options.some(([id]) => id === value)) options.push([value, value]);
      effort.setOptions(options, value);
    };
    const renderModels = (value = "") => {
      const options: [string, string][] = [["", t("actions.default")], ...modelsOf(provider.value as ProviderId).map(m => [m.id, m.label] as [string, string])];
      if (value && !options.some(([id]) => id === value)) options.push([value, value]);
      model.setOptions(options, value); renderEffort();
    };
    renderModels(profile.choice.model); renderEffort(profile.choice.effort);
    provider.onchange = () => renderModels(); model.onchange = () => renderEffort();
    const servers = selection("actions.mcp", profile.mcp, mcp.list().map(s => s.id));
    const packages = selection("actions.plugins", profile.plugins, plugins.list().map(p => p.id));
    const skills = input(profile.skills.join(", "));
    const permission = select(profile.permission, [["ask", t("actions.ask")], ["auto", t("actions.auto")]]);
    const watching = checkbox("actions.watch", !!profile.watch);
    const watchBody = h("div", "actionwatch"); watchBody.hidden = !watching.control.checked;
    watching.control.onchange = () => { watchBody.hidden = !watching.control.checked; };
    const interval = input(String(profile.watch?.interval_seconds ?? 60)) as HTMLInputElement;
    interval.type = "number"; interval.min = "30"; interval.max = "86400"; interval.required = true;
    const limit = input(String(profile.watch?.max_turns ?? 10)) as HTMLInputElement;
    limit.type = "number"; limit.min = "1"; limit.max = "100"; limit.required = true;
    const comments = checkbox("actions.comments", profile.watch?.comments ?? true);
    const ci = checkbox("actions.ci", profile.watch?.ci ?? true);
    watchBody.append(field("actions.interval", interval), comments.label, ci.label, field("actions.limit", limit), h("p", "ui-hint", t("actions.watchHint")));
    const models = h("div", "ui-columns");
    models.append(field("actions.provider", provider.control), field("actions.model", model.control), field("actions.effort", effort.control));
    const tools = ui.disclosure(t("actions.tools"));
    tools.toggleAttribute("open", !!profile.mcp?.length || !!profile.plugins?.length || !!profile.skills.length);
    tools.append(servers.root, packages.root,
      field("actions.skills", skills), h("p", "ui-hint", t("actions.skillsHint")));
    body.append(field("actions.name", name), field("actions.instructions", prompt), models, tools,
      field("actions.permission", permission.control), watching.label, watchBody, h("p", "ui-hint", t("actions.snapshotHint")));
    return () => {
      const next = structuredClone(actions.catalog());
      const result: actions.Profile = { ...profile, name: name.value.trim(), prompt: prompt.value.trim(),
        choice: { agent: provider.value as ProviderId, model: model.value, effort: effort.value },
        mcp: servers.get(), plugins: packages.get(), skills: skills.value.split(",").map(s => s.trim()).filter(Boolean),
        permission: permission.value as actions.Profile["permission"],
        watch: watching.control.checked ? { interval_seconds: Number(interval.value), max_turns: Number(limit.value), comments: comments.control.checked, ci: ci.control.checked } : null,
      };
      if (project) { (next.overrides[project] ??= {})[result.id] = result; }
      else { next.profiles = [...next.profiles.filter(p => p.id !== result.id), result]; }
      return next;
    };
  }, redraw);
}

function commandEditor(old: actions.Action | null, redraw: () => void) {
  sheet(t("actions.commandEditor"), body => {
    const name = input(old?.name ?? ""); name.required = true;
    if (name instanceof HTMLInputElement) name.pattern = "[a-z0-9-]{1,64}";
    const description = input(old?.description ?? "");
    const kind = select(old?.kind ?? "prompt", [["prompt", t("actions.prompt")], ["agent", t("actions.agent")]]);
    const prompt = input(old?.prompt ?? "", true);
    const profile = select(old?.profile ?? "", [["", t("actions.chooseProfile")], ...actions.catalog().profiles.map(p => [p.id, p.name] as [string, string])]);
    const profileField = field("actions.profile", profile.control);
    const changed = () => { profileField.hidden = kind.value !== "agent"; profile.control.disabled = kind.value !== "agent"; prompt.required = kind.value === "prompt"; };
    kind.onchange = changed;
    profile.onchange = () => profile.control.removeAttribute("aria-invalid");
    changed();
    body.append(field("actions.commandName", name), field("actions.description", description), field("actions.kind", kind.control), profileField, field("actions.text", prompt), h("p", "ui-hint", t("actions.commandHint")));
    return () => {
      const next = structuredClone(actions.catalog());
      if (kind.value === "agent" && !profile.value) {
        profile.control.setAttribute("aria-invalid", "true");
        profile.control.focus();
        throw new Error(t("actions.chooseProfile"));
      }
      const result: actions.Action = { name: name.value.trim(), description: description.value.trim(), kind: kind.value as actions.Action["kind"], prompt: prompt.value, profile: kind.value === "agent" ? profile.value : null };
      if (next.commands.some(c => c.name === result.name && c.name !== old?.name)) {
        // Mantém a duplicata para a validação autoritativa recusar sem substituir outro comando.
        next.commands.push(result);
      } else { next.commands = [...next.commands.filter(c => c.name !== old?.name), result]; }
      if (old && next.pr_action === old.name) next.pr_action = result.kind === "agent" ? result.name : null;
      return next;
    };
  }, redraw);
}

function delivery(redraw: () => void, say: (text: string, bad?: boolean) => void) {
  const next = structuredClone(actions.catalog());
  if (next.commands.some(c => c.name === "entregar")) { say(t("err.actions.used"), true); return; }
  const id = crypto.randomUUID();
  next.profiles.push({ id, name: t("actions.deliveryName"), prompt: t("actions.deliveryPrompt"), choice: { agent: "claude", model: "", effort: "" }, mcp: null, plugins: null, skills: [], permission: "ask", watch: { interval_seconds: 60, comments: true, ci: true, max_turns: 10 } });
  next.commands.push({ name: "entregar", description: t("actions.deliveryName"), kind: "agent", profile: id, prompt: t("actions.deliveryStart") });
  void actions.save(next).then(redraw).catch(e => say(fromBack(e), true));
}
