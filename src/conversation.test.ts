import { describe, expect, it } from "vitest";
import { parseConversationEvent } from "./conversation";
import { LegacyConversationAdapter } from "./conversation-legacy";
import { Timeline } from "./timeline";

const line = (value: unknown) => JSON.stringify(value);

describe("ConversationEventV1", () => {
  it("descarta versão, tipo e campos obrigatórios inválidos sem derrubar o replay", () => {
    expect(parseConversationEvent({ v: 2, type: "user.message", at: 1, content: [] })).toBeNull();
    expect(parseConversationEvent({ v: 1, type: "provider.surprise", at: 1 })).toBeNull();
    expect(parseConversationEvent({ v: 1, type: "assistant.block", at: 1, messageId: "m", index: -1 })).toBeNull();

    const timeline = new Timeline();
    expect(timeline.push(line({ v: 1, type: "commands.updated", at: 1 }))).toEqual([]);
    expect(timeline.items).toEqual([]);
  });

  it("ignora o espelho legado que existe apenas para rollback", () => {
    const timeline = new Timeline();
    timeline.push(
      line({
        type: "user",
        prometheusV1Mirror: true,
        message: { role: "user", content: "não duplicar" },
      }),
    );
    expect(timeline.items).toEqual([]);
  });

  it("reduz eventos canônicos sem conhecer o envelope de nenhum provider", () => {
    const timeline = new Timeline();
    timeline.push(line({ v: 1, type: "user.message", at: 1, content: [{ kind: "text", text: "oi" }] }));
    timeline.push(line({ v: 1, type: "assistant.started", at: 2, messageId: "m1" }));
    timeline.push(
      line({ v: 1, type: "assistant.block.started", at: 3, messageId: "m1", index: 0, block: { kind: "text", text: "" } }),
    );
    timeline.push(line({ v: 1, type: "assistant.delta", at: 4, messageId: "m1", index: 0, kind: "text", delta: "olá" }));
    timeline.push(
      line({ v: 1, type: "assistant.block", at: 5, messageId: "m1", index: 0, block: { kind: "text", text: "olá!" } }),
    );
    timeline.push(line({ v: 1, type: "turn.completed", at: 6, outcome: "ok", message: "", durationMs: 10, costUsd: null }));

    expect(timeline.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(timeline.items[1]).toMatchObject({ kind: "assistant", streaming: false, blocks: [{ kind: "text", text: "olá!" }] });
    expect(timeline.busy).toBe(false);
  });

  it("reproduz a mesma timeline ao adaptar um transcript legado antes ou durante a leitura", () => {
    const legacy = [
      { type: "control_response", ts: 1, response: { response: { commands: [{ name: "compact", description: "Compact", argumentHint: "" }] } } },
      { type: "system", subtype: "init", ts: 2, terminal_slash_commands: [] },
      { type: "user", ts: 3, message: { content: "faça" } },
      { type: "stream_event", ts: 4, event: { type: "message_start", message: { id: "m1" } } },
      { type: "stream_event", ts: 5, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { type: "stream_event", ts: 6, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "indo" } } },
      { type: "assistant", ts: 7, message: { id: "m1", content: [{ type: "text", text: "indo" }] } },
      { type: "assistant", ts: 8, message: { id: "m1", content: [{ type: "tool_use", id: "tool-1", name: "Agent", input: { description: "mapear" } }] } },
      { type: "control_request", ts: 9, request_id: "request-1", request: { subtype: "can_use_tool", tool_name: "Agent", tool_use_id: "tool-1", input: { description: "mapear" } } },
      { type: "system", subtype: "task_started", ts: 10, task_id: "task-1", tool_use_id: "tool-1", description: "mapear" },
      { type: "user", ts: 11, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "iniciou" }] } },
      { type: "system", subtype: "background_tasks_changed", ts: 12, tasks: [] },
      { type: "system", subtype: "task_notification", ts: 13, task_id: "task-1", status: "completed", summary: "mapeamento terminou" },
      { type: "system", subtype: "status", ts: 14, status: "compacting" },
      { type: "system", subtype: "status", ts: 15, status: null, compact_result: "success" },
      { type: "system", subtype: "compact_boundary", ts: 16, compact_metadata: { pre_tokens: 100, post_tokens: 20 } },
      { type: "result", ts: 17, is_error: false, duration_ms: 50 },
    ];
    const during = new Timeline();
    const before = new Timeline();
    const adapter = new LegacyConversationAdapter();
    for (const value of legacy) {
      during.push(line(value));
      for (const event of adapter.translate(value)) before.push(line(event));
    }

    expect(before.items).toEqual(during.items);
    expect(before.busy).toBe(during.busy);
    expect(before.compacting).toBe(during.compacting);
    expect([...before.tasks]).toEqual([...during.tasks]);
    expect(before.commands).toEqual(during.commands);
  });
});

it("accepts canonical usage for Gemini without accepting unknown provider names", () => {
  const event = { v: 1, type: "usage.updated", at: 1, provider: "gemini", usage: { windows: [] } };
  expect(parseConversationEvent(event)).toEqual(event);
  expect(parseConversationEvent({ ...event, provider: "unknown" })).toBeNull();
});
