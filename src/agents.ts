import { invoke } from "./ipc";
import type { ProviderId } from "./types";

export type AgentModel = {
  id: string;
  label: string;
  efforts: string[];
};

export type AgentCapabilities = {
  initialPlanMode: boolean;
  workspaceMcpSelection: boolean;
  workspacePluginSelection: boolean;
  resume: boolean;
  compact: boolean;
  contextReport: boolean;
  approvals: boolean;
  userQuestions: boolean;
  attachments: boolean;
};

export type AgentDescriptor = {
  id: ProviderId;
  label: string;
  installed: boolean;
  models: AgentModel[];
  capabilities: AgentCapabilities;
};

/// Historical labels only. These aliases never advertise availability.
const CLAUDE_LEGACY_MODELS: AgentModel[] = [
  { id: "fable", label: "Fable", efforts: [] },
  { id: "fable[1m]", label: "Fable · 1M", efforts: [] },
  { id: "opus", label: "Opus", efforts: [] },
  { id: "opus[1m]", label: "Opus · 1M", efforts: [] },
  { id: "sonnet", label: "Sonnet", efforts: [] },
  { id: "sonnet[1m]", label: "Sonnet · 1M", efforts: [] },
  { id: "haiku", label: "Haiku", efforts: [] },
];

const NO_CAPABILITIES: AgentCapabilities = {
  initialPlanMode: false,
  workspaceMcpSelection: false,
  workspacePluginSelection: false,
  resume: false,
  compact: false,
  contextReport: false,
  approvals: false,
  userQuestions: false,
  attachments: false,
};

/// Explicit bootstrap and failure states allow Claude startup without advertising unconfirmed optional capabilities.
const BOOTSTRAP: AgentDescriptor[] = [
  {
    id: "claude",
    label: "Claude",
    installed: true,
    models: [],
    capabilities: NO_CAPABILITIES,
  },
  {
    id: "codex",
    label: "Codex",
    installed: false,
    models: [],
    capabilities: NO_CAPABILITIES,
  },
];

let catalog = BOOTSTRAP;
let generation = 0;

export type CatalogState = "loading" | "ready" | "empty" | "error";
const states: Record<ProviderId, CatalogState> = { claude: "loading", codex: "loading" };
const listeners = new Set<() => void>();
let refreshing = false;
let refreshedAt = 0;
export const catalogState = (provider: ProviderId): CatalogState => states[provider];
export function onAgentsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const changed = () => listeners.forEach(listener => listener());

/// Account changes invalidate immediately. Focus/timer refreshes coalesce and run at most every five minutes.
export async function loadAgents(refresh = false) {
  if (refresh && (refreshing || Date.now() - refreshedAt < 300_000)) return;
  const current = ++generation;
  refreshing = true;
  refreshedAt = Date.now();
  catalog = catalog.map(provider => ({ ...provider, models: [] }));
  states.claude = states.codex = "loading";
  changed();
  try {
    const discovered = await invoke("agents");
    if (current !== generation) return;
    catalog = (discovered.providers.length ? discovered.providers : BOOTSTRAP).map(provider => ({ ...provider, models: [] }));
    for (const provider of catalog) if (!provider.installed) states[provider.id] = "empty";
    changed();
    await Promise.all(installed().map(async ({ id }) => {
      try {
        const models = await invoke("agent_models", { provider: id });
        if (current !== generation) return;
        catalog = catalog.map(provider => provider.id === id ? { ...provider, models } : provider);
        states[id] = models.length ? "ready" : "empty";
      } catch {
        if (current !== generation) return;
        catalog = catalog.map(provider => provider.id === id ? { ...provider, models: [] } : provider);
        states[id] = "error";
      }
      changed();
    }));
  } catch {
    if (current !== generation) return;
    catalog = BOOTSTRAP;
    states.claude = states.codex = "error";
    changed();
  } finally {
    if (current === generation) {
      refreshing = false;
    }
  }
}

export const descriptors = (): readonly AgentDescriptor[] => catalog;

export const installed = (): AgentDescriptor[] => catalog.filter((provider) => provider.installed);

export function descriptor(id: ProviderId): AgentDescriptor {
  return catalog.find((provider) => provider.id === id) ?? BOOTSTRAP.find((provider) => provider.id === id)!;
}

export const capabilitiesOf = (id: ProviderId): AgentCapabilities => descriptor(id).capabilities;

export function modelsOf(id: ProviderId): readonly AgentModel[] {
  return descriptor(id).models;
}

/// Resolve provider identity only when selecting from a catalog. Persisted selections already carry their provider.
export function providerOfModel(model: string): ProviderId {
  return catalog.find((provider) => provider.models.some((candidate) => candidate.id === model))?.id ?? "claude";
}

export function modelOf(model: string, provider?: ProviderId): AgentModel | undefined {
  if (provider) return modelsOf(provider).find((candidate) => candidate.id === model);
  return catalog.flatMap((item) => item.models).find((candidate) => candidate.id === model);
}

/// Live labels take precedence. Old transcripts remain readable without making retired models selectable.
export function modelLabelOf(model: string, provider?: ProviderId): string {
  const live = modelOf(model, provider);
  if (live) return live.label;
  const legacy = provider === undefined || provider === "claude"
    ? CLAUDE_LEGACY_MODELS.find(candidate => candidate.id === model) : undefined;
  return legacy?.label ?? model;
}

export function isKnownModel(provider: ProviderId, model: string): boolean {
  return modelsOf(provider).some((candidate) => candidate.id === model);
}

/// The UI canonicalizes the top effort as ultracode. Codex calls it ultra; Claude uses xhigh plus application orchestration. Keep this provider metadata at the catalog boundary.
export function effortsOf(provider: ProviderId, model: string): readonly string[] {
  const efforts = modelOf(model, provider)?.efforts ?? [];
  if (!efforts.length) return [];
  if (provider === "codex") return efforts.map((effort) => (effort === "ultra" ? "ultracode" : effort));
  return efforts.includes("xhigh") ? [...new Set([...efforts, "ultracode"])] : efforts;
}

export const usesNativeUltraLabel = (provider: ProviderId): boolean => provider === "codex";
