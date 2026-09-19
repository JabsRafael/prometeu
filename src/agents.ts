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

export type AuthMethod = { id: string; kind: "browser" | "apiKey"; label: string };

export type AgentDescriptor = {
  authMethods: AuthMethod[];
  unavailableReason?: string | null;
  id: ProviderId;
  label: string;
  installed: boolean;
  models: AgentModel[];
  capabilities: AgentCapabilities;
};

/// Stable Claude Code aliases label older boards and keep the launcher usable if live catalog discovery fails.
const CLAUDE_FALLBACK_MODELS: AgentModel[] = [
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
    authMethods: [{ id: "browser", kind: "browser", label: "Claude" }],
    installed: true,
    models: [],
    capabilities: NO_CAPABILITIES,
  },
  {
    id: "codex",
    label: "Codex",
    authMethods: [{ id: "browser", kind: "browser", label: "Codex" }],
    installed: false,
    models: [],
    capabilities: NO_CAPABILITIES,
  },
  {
    id: "gemini", label: "Gemini", installed: false, models: [],
    authMethods: [{ id: "google", kind: "browser", label: "Google" }, { id: "apiKey", kind: "apiKey", label: "API key" }],
    capabilities: NO_CAPABILITIES,
  },
];

let catalog = BOOTSTRAP;
let generation = 0;

/// Reload on startup and account changes; late Claude catalog results must not replace a newer selection.
export async function loadAgents() {
  const current = ++generation;
  try {
    const discovered = await invoke("agents");
    if (current !== generation) return;
    if (discovered.providers.length) catalog = discovered.providers;
  } catch {
    if (current !== generation) return;
    catalog = BOOTSTRAP;
  }

  if (descriptor("claude").installed) {
    void invoke("claude_models")
      .then((models) => {
        if (current !== generation || !models.length) return;
        catalog = catalog.map((provider) =>
          provider.id === "claude" ? { ...provider, models } : provider,
        );
      })
      .catch(() => {});
  }
}

export const descriptors = (): readonly AgentDescriptor[] => catalog;

export const installed = (): AgentDescriptor[] => catalog.filter((provider) => provider.installed);

export function descriptor(id: ProviderId): AgentDescriptor {
  return catalog.find((provider) => provider.id === id) ?? BOOTSTRAP.find((provider) => provider.id === id)!;
}

export const capabilitiesOf = (id: ProviderId): AgentCapabilities => descriptor(id).capabilities;

/// Only Claude has fallback aliases. Installed Codex remains available without models until its CLI supplies a catalog.
export function modelsOf(id: ProviderId): readonly AgentModel[] {
  const models = descriptor(id).models;
  return models.length || id !== "claude" ? models : CLAUDE_FALLBACK_MODELS;
}

/// Resolve provider identity only when selecting from a catalog. Persisted selections already carry their provider.
export function providerOfModel(model: string): ProviderId {
  return catalog.find((provider) => provider.models.some((candidate) => candidate.id === model))?.id ?? "claude";
}

export function modelOf(model: string, provider?: ProviderId): AgentModel | undefined {
  if (provider) return modelsOf(provider).find((candidate) => candidate.id === model);
  return (
    CLAUDE_FALLBACK_MODELS.find((candidate) => candidate.id === model) ??
    catalog.flatMap((item) => item.models).find((candidate) => candidate.id === model)
  );
}

/// Stable alias labels take precedence over changing CLI display names; newly discovered models use their catalog label.
export function modelLabelOf(model: string, provider?: ProviderId): string {
  const legacy = CLAUDE_FALLBACK_MODELS.find((candidate) => candidate.id === model);
  if (legacy && (provider === undefined || provider === "claude")) return legacy.label;
  return modelOf(model, provider)?.label ?? model;
}

export function isKnownModel(provider: ProviderId, model: string): boolean {
  if (provider === "claude" && CLAUDE_FALLBACK_MODELS.some((candidate) => candidate.id === model)) {
    return true;
  }
  return descriptor(provider).models.some((candidate) => candidate.id === model);
}

/// The UI canonicalizes the top effort as ultracode. Codex calls it ultra; Claude uses xhigh plus application orchestration. Keep this provider metadata at the catalog boundary.
export function effortsOf(provider: ProviderId, model: string): readonly string[] {
  const efforts = modelOf(model, provider)?.efforts ?? [];
  if (!efforts.length) return [];
  if (provider === "codex") return efforts.map((effort) => (effort === "ultra" ? "ultracode" : effort));
  return efforts.includes("xhigh") ? [...new Set([...efforts, "ultracode"])] : efforts;
}

export const usesNativeUltraLabel = (provider: ProviderId): boolean => provider === "codex";
