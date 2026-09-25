import { beforeEach, expect, test, vi } from "vitest";
import { telemetryPeriod } from "./telemetry";
import * as mock from "./mock-telemetry";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
test("local date filters use an exclusive next-day boundary", () => {
  const period = telemetryPeriod("2026-09-24", "2026-09-25");
  expect(new Date(period.from!).getDate()).toBe(24);
  expect(new Date(period.to!).getDate()).toBe(26);
  expect(new Date(period.to!).getHours()).toBe(0);
  expect(() => telemetryPeriod("2026-09-26", "2026-09-24")).toThrow("err.telemetry.filter");
  expect(telemetryPeriod("", "")).toEqual({});
});
test("mock summary uses the turn start cohort and export matches event filters", () => {
  const first = mock.page({}).events[0];
  const filter = { from: first.occurredAt, to: first.occurredAt + 1 };
  expect(mock.summary(filter)).toMatchObject({ turns: 1, inputTokens: 10000, outputTokens: 2000 });
  expect(mock.summary({ workspaceId: "missing" }).turns).toBe(0);
  const lines = mock.exportData(filter).trim().split("\n").map(line => JSON.parse(line));
  expect(lines[0].exportVersion).toBe(1); expect(lines).toHaveLength(2);
  expect(mock.page({}, { occurredAt: first.occurredAt, sequence: first.sequence }).events).toHaveLength(1);
});
test("mock clear removes retained history and does not regenerate fixture data", () => {
  expect(mock.summary({}).turns).toBe(1); mock.clear();
  expect(mock.summary({})).toMatchObject({ events: 0, turns: 0, inputTokens: null, outputTokens: null });
  expect(mock.page({}).events).toEqual([]);
  expect(mock.exportData({}).trim().split("\n")).toHaveLength(1);
});
