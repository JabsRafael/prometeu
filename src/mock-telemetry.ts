import { type TelemetryCursor, type TelemetryEvent, type TelemetryFilter, type TelemetryPage, type TelemetrySummary, type TelemetryMeasurement } from "./telemetry";

const KEY = "mock:telemetry";
const health = () => ({ failures: 0, lastFailureAt: null, unavailable: false });
/** Fixed local facts exercise settings independently of native adapters. Clearing persists an empty array. */
function events(): TelemetryEvent[] {
  const saved = localStorage.getItem(KEY);
  if (saved !== null) return JSON.parse(saved) as TelemetryEvent[];
  const at = Date.now() - 60_000;
  const measurement: TelemetryMeasurement = { usageScope: "mainAgent", complete: true, selectedModel: "example-model", observedModels: null, usageByModel: null,
    usage: { inputTokens: 10000, outputTokens: 2000, cacheReadTokens: 8000, cacheWriteTokens: null, reasoningTokens: 500,
      contextUsed: null, contextWindow: null, peakContext: null, modelCalls: null, compactions: null, cacheRebuilds: null, costUsd: null } };
  const scope = { schemaVersion: 1, category: "work" as const, workspaceId: "00000000-0000-4000-8000-000000000001", projectId: null,
    conversationId: "00000000-0000-4000-8000-000000000002", turnId: "00000000-0000-4000-8000-000000000003", provider: "codex" };
  const result: TelemetryEvent[] = [
    { ...scope, id: crypto.randomUUID(), occurrenceKey: crypto.randomUUID(), sequence: 1, occurredAt: at, recordedAt: at,
      type: "turn.started", payload: { measurement } },
    { ...scope, id: crypto.randomUUID(), occurrenceKey: crypto.randomUUID(), sequence: 2, occurredAt: at + 30_000, recordedAt: at + 30_000,
      type: "turn.completed", payload: { outcome: "ok", elapsedMs: 30_000, providerDurationMs: null, measurement } },
  ];
  localStorage.setItem(KEY, JSON.stringify(result)); return result;
}
const inPeriod = (at: number, filter: TelemetryFilter) => at >= (filter.from ?? 0) && at < (filter.to ?? Number.MAX_SAFE_INTEGER);
function selected(filter: TelemetryFilter): TelemetryEvent[] {
  if ((filter.from ?? 0) >= (filter.to ?? Number.MAX_SAFE_INTEGER)) throw new Error("err.telemetry.filter");
  const all = events();
  const related = new Set(all.filter(e => e.type === "pull_request.associated" && e.payload.repositoryId === filter.repositoryId && e.payload.pullRequest === filter.pullRequest).map(e => e.workspaceId));
  return all.filter(e => (!filter.workspaceId || e.workspaceId === filter.workspaceId) && (!filter.repositoryId || related.has(e.workspaceId)));
}
export function summary(filter: TelemetryFilter): TelemetrySummary {
  const all = selected(filter); const period = all.filter(e => inPeriod(e.occurredAt, filter));
  const turns = new Set(all.filter(e => e.type === "turn.started" && inPeriod(e.occurredAt, filter)).map(e => e.turnId));
  const ends = all.filter(e => e.type === "turn.completed" && turns.has(e.turnId));
  const usage = ends.flatMap(e => e.type === "turn.completed" ? [e.payload.measurement.usage] : []);
  const sum = (values: (number | null)[]) => values.some(v => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
  return { firstRecordedAt: period[0]?.occurredAt ?? null, lastRecordedAt: period[period.length - 1]?.occurredAt ?? null, events: period.length,
    turns: turns.size, completedTurns: ends.length, partialTurns: 0, measuredTurns: usage.filter(u => u.inputTokens !== null && u.outputTokens !== null).length,
    inputTokens: sum(usage.map(u => u.inputTokens)), outputTokens: sum(usage.map(u => u.outputTokens)), costUsd: sum(usage.map(u => u.costUsd)),
    incompleteExecutions: 0, completeExecutions: 0, clockAnomalies: 0, executionSumMs: null, activeAgentMs: null,
    respondedWaits: 0, cancelledWaits: 0, incompleteWaits: 0, humanWaitMs: null,
    workspaceIds: [...new Set(selected({ ...filter, workspaceId: undefined }).flatMap(e => e.workspaceId ? [e.workspaceId] : []))], health: health() };
}
export function page(filter: TelemetryFilter, cursor?: TelemetryCursor): TelemetryPage {
  const records = selected(filter).filter(e => inPeriod(e.occurredAt, filter) && (!cursor || e.occurredAt > cursor.occurredAt || (e.occurredAt === cursor.occurredAt && e.sequence > cursor.sequence)));
  const events = records.slice(0, 500); const last = events[events.length - 1];
  return { events, next: records.length > 500 && last ? { occurredAt: last.occurredAt, sequence: last.sequence } : null, health: health() };
}
export function exportData(filter: TelemetryFilter): string {
  return [JSON.stringify({ exportVersion: 1, filter, health: health(), summary: summary(filter) }), ...selected(filter).filter(e => inPeriod(e.occurredAt, filter)).map(e => JSON.stringify(e))].join("\n") + "\n";
}
export function clear(): void { localStorage.setItem(KEY, "[]"); }
