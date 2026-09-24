import type { EvaluationPort, EvaluationStatus } from "./evaluation";
import { invoke } from "./ipc";

/// Desktop shell of the optional TypeSafe integration: its IPC-backed evaluation port and the
/// configuration status shared by Settings and the launcher. The key is sent once to the backend
/// and never read back.

export const port: EvaluationPort = { evaluate: request => invoke("context_evaluate", { request }) };

const DISABLED: EvaluationStatus = { configured: false, enabled: false, problem: null };
let status: EvaluationStatus = DISABLED;
/// Bumped on every configuration change; consumers bind pending work to it.
let epoch = 0;
const listeners = new Set<() => void>();

export const current = () => status;
export const currentEpoch = () => epoch;
export const available = () => status.configured && status.enabled;

export function onChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(next: EvaluationStatus) {
  epoch++;
  status = next;
  for (const listener of [...listeners]) listener();
  return status;
}

/// A missing or older backend keeps the integration disabled.
export async function refresh() {
  try { return publish(await invoke("typesafe_status")); }
  catch { return publish(DISABLED); }
}

export async function saveKey(key: string) { return publish(await invoke("typesafe_save_key", { key })); }
export async function removeKey() { return publish(await invoke("typesafe_remove_key")); }
export async function setEnabled(enabled: boolean) { return publish(await invoke("typesafe_set_enabled", { enabled })); }
