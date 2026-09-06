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

type AgentCatalog = { providers: AgentDescriptor[] };

/// Aliases estáveis do Claude Code. O catálogo vivo substitui esta lista no
/// seletor, mas ela continua dando nome a boards antigos e mantém o launcher
/// utilizável se o control request não responder.
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

/// Estado explícito de bootstrap/falha: preserva a compatibilidade de abrir o
/// Claude, mas não anuncia feature opcional antes de o backend confirmá-la.
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

/// Recarrega na abertura e na troca de conta. O catálogo mais lento do Claude
/// chega atrás, sem substituir a resposta de uma seleção mais recente.
export async function loadAgents() {
  const current = ++generation;
  try {
    const discovered = await invoke<AgentCatalog>("agents");
    if (current !== generation) return;
    if (discovered.providers.length) catalog = discovered.providers;
  } catch {
    if (current !== generation) return;
    catalog = BOOTSTRAP;
  }

  if (descriptor("claude").installed) {
    void invoke<AgentModel[]>("claude_models")
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

/// Modelos oferecidos agora. Apenas o catálogo do Claude tem fallback de
/// aliases; Codex sem cache instalado continua instalado, mas sem modelo para
/// oferecer até o próprio CLI publicar um.
export function modelsOf(id: ProviderId): readonly AgentModel[] {
  const models = descriptor(id).models;
  return models.length || id !== "claude" ? models : CLAUDE_FALLBACK_MODELS;
}

/// Resolve escolhas vindas de um catálogo, como o seletor global de modelo.
/// Depois de persistida, a identidade do provider viaja junto com o modelo e
/// não deve ser redescoberta por este helper.
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

/// Rótulos de aliases antigos são parte da apresentação persistida do app e
/// têm precedência sobre o displayName vivo, que pode mudar entre versões do
/// CLI. Modelos novos continuam usando o label descoberto.
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

/// A UI usa `ultracode` como id canônico do último degrau. O catálogo do Codex
/// o chama `ultra`; no Claude ele é o xhigh com a orquestração do app por cima.
/// Essa tradução é metadado do provider e fica na fronteira do catálogo.
export function effortsOf(provider: ProviderId, model: string): readonly string[] {
  const efforts = modelOf(model, provider)?.efforts ?? [];
  if (!efforts.length) return [];
  if (provider === "codex") return efforts.map((effort) => (effort === "ultra" ? "ultracode" : effort));
  return efforts.includes("xhigh") ? [...new Set([...efforts, "ultracode"])] : efforts;
}

export const usesNativeUltraLabel = (provider: ProviderId): boolean => provider === "codex";
