import { listen } from "@tauri-apps/api/event";
import { invoke } from "./ipc";
import { fromBack, t } from "./i18n";
import { button, field, formDialog, input, confirmDialog } from "./ui";
import { h } from "./util";

export type Kind = "plugins" | "mcp" | "skills";
export type CatalogPlugin = { id: string; source: string; note: string; local_id: string; installed: boolean; source_changed: boolean };
export type CatalogSkill = { id: string; description: string; content: string; local_id: string; installed: boolean };
export type CatalogState = {
  connected: boolean;
  revision: number | null;
  plugins: CatalogPlugin[];
  mcp: string[];
  skills: CatalogSkill[];
  shared: Record<string, string>;
};
let state: CatalogState = { connected: false, revision: null, plugins: [], mcp: [], skills: [], shared: {} };
const watchers = new Set<() => void>();
let refreshHubs = async () => {};
export const current = () => state;
export const onChange = (fn: () => void) => { watchers.add(fn); return () => watchers.delete(fn); };
export const shared = (kind: Kind, id: string) => !!state.shared[`${kind}:${id}`];
export async function load() {
  state = await invoke("catalog_state");
  for (const fn of watchers) fn();
}
export async function refresh() { await refreshHubs(); await load(); }
export function init(refresh: () => Promise<void>) {
  refreshHubs = refresh;
  void load().catch(() => {});
  void listen("catalog", () => { void refreshHubs().then(load).catch(() => {}); }).catch(() => {});
}
export function tag(kind: Kind, id: string): string {
  return t(shared(kind, id) ? "catalog.cloud" : "catalog.local");
}
export function controls(kind: Kind, id: string): HTMLElement[] {
  const copy = button(t("catalog.copy"), () => {
    const name = input(`${id.slice(0, 45)}-local`); name.required = true;
    name.maxLength = kind === "skills" ? 56 : 128;
    if (kind === "skills") name.pattern = "[a-z0-9][a-z0-9-]{0,55}";
    const dialog = formDialog({ title: t("catalog.copy"), save: t("catalog.copy"), cancel: t("actions.cancel"), error: fromBack,
      submit: async () => { await invoke("catalog_copy", { kind, id, newId: name.value }); await refresh(); } });
    dialog.body.append(h("p", "ui-hint", t("catalog.copyHint")), field(t("catalog.copyName"), name)); dialog.open();
  }, "ghost");
  if (shared(kind, id)) return [copy];
  if (!state.connected) return [];
  const share = button(t("catalog.share"), () => {
    const dialog = formDialog({ title: t("catalog.share"), save: t("catalog.share"), cancel: t("actions.cancel"), error: fromBack,
      submit: async () => { await invoke("catalog_share", { kind, id }); await refresh(); } });
    dialog.body.append(h("p", "ui-hint", t("catalog.shareHint"))); dialog.open();
  }, "ghost");
  return [share];
}
export async function confirmRemoval(kind: Kind, id: string): Promise<boolean> {
  if (!shared(kind, id)) return true;
  return confirmDialog({ title: t("catalog.delete"), message: t("catalog.deleteHint"), accept: t("catalog.delete"), cancel: t("actions.cancel") });
}
