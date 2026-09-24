import { invoke } from "./ipc";
import type { Skill } from "./skills";

/// A skill shipped inside an installed plugin, as discovered by the backend.
export type PluginSkill = { plugin: string; name: string; description: string };

/// One "Start with" option. `id` is the wire form `<package>/<skill>` the backend validates.
export type KickoffEntry = { id: string; name: string; description: string; plugin: string | null };

/// The last "Start with" choice is a per-installation launcher preference, like the remembered
/// worktree switch; an empty string records an explicit "none". See ADR 0057.
export const KICKOFF_KEY = "prometeu:kickoff";

let discovered: PluginSkill[] = [];

/// Reload the skills installed plugins ship. Standalone skills come from the skill hub.
export async function refresh() {
  discovered = await invoke("plugin_skills");
  return discovered;
}
export const pluginSkills = () => discovered;

/// Merge standalone hub skills and plugin-provided skills into one catalog, standalone first,
/// each group sorted by name. Standalone skills ride the hub as `skill-<id>`.
export function catalog(standalone: Skill[], shipped: PluginSkill[]): KickoffEntry[] {
  const own = [...standalone]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(s => ({ id: `skill-${s.id}/${s.id}`, name: s.id, description: s.description, plugin: null }));
  const bundled = [...shipped]
    .sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name))
    .map(s => ({ id: `${s.plugin}/${s.name}`, name: s.name, description: s.description, plugin: s.plugin }));
  const seen = new Set<string>();
  return [...own, ...bundled].filter(entry => !seen.has(entry.id) && !!seen.add(entry.id));
}

/// Read the remembered choice, keeping it only while the catalog still offers it. Storage may be
/// unavailable; the launcher then starts without a kickoff.
export function storedKickoff(entries: KickoffEntry[]): string {
  try {
    const saved = localStorage.getItem(KICKOFF_KEY) ?? "";
    return entries.some(entry => entry.id === saved) ? saved : "";
  } catch {
    return "";
  }
}

export function rememberKickoff(id: string) {
  try {
    localStorage.setItem(KICKOFF_KEY, id);
  } catch {
    // The preference is a convenience; the launch still carries the explicit choice.
  }
}
