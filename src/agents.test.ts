import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capabilitiesOf, catalogState, effortsOf, installed, isKnownModel, loadAgents,
  modelLabelOf, modelOf, modelsOf, onAgentsChanged, providerOfModel,
  type AgentCapabilities, type AgentModel,
} from "./agents";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./ipc", () => ({ invoke: mocks.invoke }));

const common: AgentCapabilities = {
  initialPlanMode: false, workspaceMcpSelection: true, workspacePluginSelection: true,
  resume: true, compact: true, contextReport: true, approvals: true,
  userQuestions: true, attachments: true,
};
const providers = [
  { id: "claude", label: "Claude", installed: true, models: [], capabilities: { ...common, initialPlanMode: true } },
  { id: "codex", label: "Codex", installed: true, models: [], capabilities: common },
];
const catalogs: Record<string, AgentModel[]> = {
  claude: [{ id: "claude-novo", label: "Claude novo", efforts: ["high"] }],
  codex: [{ id: "gpt-teste", label: "GPT de teste", efforts: ["low", "high", "ultra"] }],
};
function discover(query = (provider: string): Promise<AgentModel[]> => Promise.resolve(catalogs[provider])) {
  mocks.invoke.mockImplementation((command: string, args?: { provider: string }) =>
    command === "agents" ? Promise.resolve({ providers }) : query(args!.provider));
}
afterEach(() => vi.useRealTimers());

describe("catálogo de agentes", () => {
  it("descarta catálogo atrasado da conta anterior", async () => {
    let previous!: (models: AgentModel[]) => void;
    let calls = 0;
    discover(provider => provider === "claude" && ++calls === 1
      ? new Promise(resolve => { previous = resolve; })
      : Promise.resolve(catalogs[provider]));
    const old = loadAgents();
    await Promise.resolve();
    await loadAgents();
    previous([{ id: "conta-anterior", label: "Conta anterior", efforts: [] }]);
    await old;
    expect(modelOf("claude-novo", "claude")?.label).toBe("Claude novo");
    expect(modelOf("conta-anterior", "claude")).toBeUndefined();
  });

  it("associa modelos e capabilities sem manter aliases aposentados selecionáveis", async () => {
    discover();
    await loadAgents();
    expect(installed().map(({ id }) => id)).toEqual(["claude", "codex"]);
    expect(providerOfModel("gpt-teste")).toBe("codex");
    expect(modelOf("gpt-teste", "codex")?.label).toBe("GPT de teste");
    expect(isKnownModel("claude", "opus[1m]")).toBe(false);
    expect(modelLabelOf("opus[1m]", "claude")).toBe("Opus · 1M");
    expect(modelLabelOf("opus[1m]", "codex")).toBe("opus[1m]");
    expect(effortsOf("codex", "gpt-teste")).toEqual(["low", "high", "ultracode"]);
    expect(capabilitiesOf("codex").workspacePluginSelection).toBe(true);
    expect(capabilitiesOf("claude").initialPlanMode).toBe(true);
  });

  it("prioriza rótulos vivos e remove modelos retirados numa atualização", async () => {
    discover(provider => Promise.resolve(provider === "claude"
      ? [{ id: "opus[1m]", label: "Rótulo vivo", efforts: ["high"] }] : []));
    await loadAgents();
    expect(modelLabelOf("opus[1m]")).toBe("Rótulo vivo");
    expect(modelLabelOf("opus[1m]", "claude")).toBe("Rótulo vivo");
    expect(isKnownModel("claude", "opus[1m]")).toBe(true);
    discover();
    await loadAgents();
    expect(isKnownModel("claude", "opus[1m]")).toBe(false);
  });

  it("distingue falha e catálogo vazio sem inventar modelos nem bloquear outro provider", async () => {
    discover();
    await loadAgents();
    discover(provider => provider === "claude" ? Promise.reject(new Error("timeout")) : Promise.resolve([]));
    const changed = vi.fn();
    const forget = onAgentsChanged(changed);
    const pending = loadAgents();
    expect(catalogState("claude")).toBe("loading");
    expect(modelsOf("claude")).toEqual([]);
    await pending;
    expect(catalogState("claude")).toBe("error");
    expect(catalogState("codex")).toBe("empty");
    expect(modelsOf("claude")).toEqual([]);
    expect(changed).toHaveBeenCalled();
    forget();
    discover();
    await loadAgents();
    expect(catalogState("claude")).toBe("ready");
  });

  it("coalesce foco e timer, mas troca de conta sempre atualiza", async () => {
    vi.useFakeTimers();
    discover();
    await loadAgents();
    mocks.invoke.mockClear();
    await loadAgents(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300_000);
    await Promise.all([loadAgents(true), loadAgents(true)]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "agent_models")).toHaveLength(2);
    await loadAgents();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "agent_models")).toHaveLength(4);
  });

  it("expõe falha da descoberta inicial sem ressuscitar fallback", async () => {
    mocks.invoke.mockRejectedValue(new Error("IPC unavailable"));
    await loadAgents();
    expect(catalogState("claude")).toBe("error");
    expect(modelsOf("claude")).toEqual([]);
    expect(capabilitiesOf("claude").initialPlanMode).toBe(false);
  });
});
