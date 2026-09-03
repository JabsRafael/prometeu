/// Contrato próprio da conversa. Providers traduzem para estes eventos na
/// borda; timeline, transcript e relay não precisam conhecer seus protocolos.

export type InputContent =
  | { kind: "text"; text: string }
  | { kind: "image"; name: string; mediaType: string }
  | { kind: "file"; name: string };

export type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown };

export type BackgroundTask = {
  id: string;
  description: string;
  toolId: string | null;
};

export type SlashCommand = { name: string; description: string; hint: string };

type EventBase<T extends string> = { v: 1; type: T; at: number };

export type ConversationEventV1 =
  | (EventBase<"user.message"> & {
      content: InputContent[];
    })
  | (EventBase<"assistant.block"> & {
      messageId: string;
      index: number;
      block: AssistantBlock;
    })
  | (EventBase<"tool.completed"> & {
      toolId: string;
      output: string;
      error: boolean;
      background: boolean;
    })
  | (EventBase<"request.opened"> & {
      requestId: string;
      kind: "approval" | "question" | "plan";
      toolId: string | null;
      tool: string | null;
      input: Record<string, unknown>;
    })
  | (EventBase<"request.closed"> & {
      requestId: string;
      outcome: "allowed" | "denied" | "answered" | "cancelled";
    })
  | (EventBase<"turn.completed"> & {
      outcome: "ok" | "error" | "interrupted";
      message: string;
      durationMs: number | null;
      costUsd: number | null;
    })
  | (EventBase<"context.compacted"> & {
      before: number | null;
      after: number | null;
    })
  | (EventBase<"background.changed"> & {
      tasks: BackgroundTask[];
    })
  | (EventBase<"system.notice"> & {
      level: "info" | "warning" | "error";
      code: string;
      detail: string;
    })
  | (EventBase<"system.summary"> & { text: string })
  | (EventBase<"context.reported"> & { markdown: string });

export type ConversationEphemeralV1 =
  | (EventBase<"assistant.started"> & { messageId: string })
  | (EventBase<"assistant.block.started"> & {
      messageId: string;
      index: number;
      block: AssistantBlock;
    })
  | (EventBase<"assistant.delta"> & {
      messageId: string;
      index: number;
      kind: "text" | "thinking";
      delta: string;
    })
  | (EventBase<"tool.input.delta"> & {
      messageId: string;
      index: number;
      toolId: string;
      delta: string;
    })
  | (EventBase<"context.compaction"> & {
      state: "started" | "stopped" | "failed";
      detail: string;
    })
  | (EventBase<"context.updated"> & { used: number; window: number | null })
  | (EventBase<"session.state"> & {
      state: "starting" | "ready" | "busy" | "waiting" | "stopped";
    })
  | (EventBase<"session.identity"> & { providerSession: string })
  | (EventBase<"commands.updated"> & { commands: SlashCommand[] })
  | (EventBase<"usage.updated"> & { provider: "claude" | "codex"; usage: unknown });

export type AnyConversationEventV1 = ConversationEventV1 | ConversationEphemeralV1;

export type RequestResponse =
  | { outcome: "allow" }
  | { outcome: "deny"; message: string }
  | { outcome: "answer"; answers: Record<string, string> };

export type ConversationCommandV1 =
  | { v: 1; type: "message.send"; text: string }
  | { v: 1; type: "request.respond"; requestId: string; response: RequestResponse }
  | { v: 1; type: "turn.interrupt" }
  | { v: 1; type: "permission.mode.set"; mode: "bypass" }
  | { v: 1; type: "commands.list" };

const EVENT_TYPES = new Set([
  "user.message",
  "assistant.block",
  "tool.completed",
  "request.opened",
  "request.closed",
  "turn.completed",
  "context.compacted",
  "background.changed",
  "system.notice",
  "system.summary",
  "context.reported",
  "assistant.started",
  "assistant.block.started",
  "assistant.delta",
  "tool.input.delta",
  "context.compaction",
  "context.updated",
  "session.state",
  "session.identity",
  "commands.updated",
  "usage.updated",
]);

/// Parser tolerante na borda da UI. Tipos e versões desconhecidos são no-op;
/// campos obrigatórios inválidos descartam só aquela linha, nunca a sessão.
export function parseConversationEvent(value: unknown): AnyConversationEventV1 | null {
  if (!isObject(value)) return null;
  const event = value;
  if (event.v !== 1 || typeof event.type !== "string" || !EVENT_TYPES.has(event.type)) return null;
  if (typeof event.at !== "number" || !Number.isFinite(event.at)) return null;
  const valid = (() => {
    switch (event.type) {
      case "user.message":
        return Array.isArray(event.content) && event.content.every(isInputContent);
      case "assistant.block":
        return isString(event.messageId) && isIndex(event.index) && isAssistantBlock(event.block);
      case "tool.completed":
        return isString(event.toolId) && isString(event.output) && isBoolean(event.error) && isBoolean(event.background);
      case "request.opened":
        return (
          isString(event.requestId) &&
          ["approval", "question", "plan"].includes(String(event.kind)) &&
          nullableString(event.toolId) &&
          nullableString(event.tool) &&
          isObject(event.input)
        );
      case "request.closed":
        return isString(event.requestId) && ["allowed", "denied", "answered", "cancelled"].includes(String(event.outcome));
      case "turn.completed":
        return (
          ["ok", "error", "interrupted"].includes(String(event.outcome)) &&
          isString(event.message) &&
          nullableNumber(event.durationMs) &&
          nullableNumber(event.costUsd)
        );
      case "context.compacted":
        return nullableNumber(event.before) && nullableNumber(event.after);
      case "background.changed":
        return (
          Array.isArray(event.tasks) &&
          event.tasks.every(
            (task) => isObject(task) && isString(task.id) && isString(task.description) && nullableString(task.toolId),
          )
        );
      case "system.notice":
        return ["info", "warning", "error"].includes(String(event.level)) && isString(event.code) && isString(event.detail);
      case "system.summary":
        return isString(event.text);
      case "context.reported":
        return isString(event.markdown);
      case "assistant.started":
        return isString(event.messageId);
      case "assistant.block.started":
        return isString(event.messageId) && isIndex(event.index) && isAssistantBlock(event.block);
      case "assistant.delta":
        return (
          isString(event.messageId) &&
          isIndex(event.index) &&
          (event.kind === "text" || event.kind === "thinking") &&
          isString(event.delta)
        );
      case "tool.input.delta":
        return isString(event.messageId) && isIndex(event.index) && isString(event.toolId) && isString(event.delta);
      case "context.compaction":
        return ["started", "stopped", "failed"].includes(String(event.state)) && isString(event.detail);
      case "context.updated":
        return isNumber(event.used) && nullableNumber(event.window);
      case "session.state":
        return ["starting", "ready", "busy", "waiting", "stopped"].includes(String(event.state));
      case "session.identity":
        return isString(event.providerSession);
      case "commands.updated":
        return (
          Array.isArray(event.commands) &&
          event.commands.every(
            (command) =>
              isObject(command) && isString(command.name) && isString(command.description) && isString(command.hint),
          )
        );
      case "usage.updated":
        return (event.provider === "claude" || event.provider === "codex") && "usage" in event;
      default:
        return false;
    }
  })();
  return valid ? (event as AnyConversationEventV1) : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableString = (value: unknown): value is string | null => value === null || isString(value);
const nullableNumber = (value: unknown): value is number | null => value === null || isNumber(value);
const isIndex = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;

function isInputContent(value: unknown): value is InputContent {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "text") return isString(value.text);
  if (value.kind === "file") return isString(value.name);
  return value.kind === "image" && isString(value.name) && isString(value.mediaType);
}

function isAssistantBlock(value: unknown): value is AssistantBlock {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "text" || value.kind === "thinking") return isString(value.text);
  return value.kind === "tool" && isString(value.id) && isString(value.name) && "input" in value;
}
