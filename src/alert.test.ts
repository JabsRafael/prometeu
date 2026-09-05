import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, Status, Workspace } from "./types";

const { badge, start, inbox } = vi.hoisted(() => ({
  badge: vi.fn(), start: vi.fn(), inbox: [] as { id: string }[],
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setBadgeCount: async (n?: number) => badge(n) }),
}));
vi.mock("./team", () => ({ inboxItems: () => inbox, inboxCount: () => inbox.length }));
import { boardChanged, chatChanged, init, looked, setSound, teamChanged, waiting } from "./alert";

const tab = (id: string, status: Status = "rodando") => ({ id, title: id, status, note: null, tokens: null });
const workspace = (id: string, tabs = [tab(`${id}-t`)], unread = false) =>
  ({ id, tabs, unread }) as Workspace;
const board = (...workspaces: Workspace[]): Board => ({ stages: [], projects: [], workspaces });
const emit = (tab: string, event: Record<string, unknown>) =>
  chatChanged(tab, JSON.stringify({ v: 1, at: 1, ...event }));
const done = (tab = "a-t") => emit(tab, {
  type: "turn.completed", outcome: "ok", message: "", durationMs: null, costUsd: null,
});
const question = (tab = "a-t") => emit(tab, {
  type: "request.opened", requestId: "q", kind: "question", toolId: null, tool: "AskUserQuestion", input: {},
});
const speak = (tab = "a-t") => emit(tab, { type: "user.message", content: [{ kind: "text", text: "continue" }] });
// Um pling usa dois osciladores. Contamos reprodução, não apenas a decisão de avisar.
const sounds = () => start.mock.calls.length / 2;
let focused = false;
const visible = new Set<string>();

beforeEach(() => {
  focused = false;
  visible.clear();
  inbox.length = 0;
  const storage = new Map<string, string>();
  vi.stubGlobal("document", { hasFocus: () => focused });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const node = () => ({
    gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    frequency: { value: 0 },
    connect() { return this; }, start, stop() {},
  });
  vi.stubGlobal("AudioContext", class {
    state = "running";
    currentTime = 0;
    destination = {};
    createGain = node;
    createOscillator = node;
  });
  init({ visible: (tab) => visible.has(tab) });
  boardChanged(board());
  vi.clearAllMocks();
});

describe("avisos da conversa", () => {
  it("atualizações do quadro não tocam som sem um evento de conclusão ou pergunta", () => {
    for (let i = 0; i < 5; i++) {
      boardChanged(board(workspace("a", [tab("a-t", "rodando")])));
      boardChanged(board(workspace("a", [tab("a-t", "pronta")])));
      boardChanged(board(workspace("a", [tab("a-t", "querendo")])));
    }
    expect(sounds()).toBe(0);
    expect(waiting()).toBe(0);
  });

  it("streaming, ferramentas, background e contexto não tocam; fim real toca uma vez", () => {
    boardChanged(board(workspace("a")));
    for (let i = 0; i < 10; i++) {
      emit("a-t", { type: "assistant.started", messageId: "m" });
      emit("a-t", { type: "assistant.block", messageId: "m", index: i, block: { kind: "text", text: "trabalhando" } });
      emit("a-t", { type: "tool.completed", toolId: "tool", output: "ok", error: false, background: false });
      emit("a-t", { type: "background.changed", tasks: [] });
      emit("a-t", { type: "context.updated", used: i, window: 100 });
    }
    expect(sounds()).toBe(0);
    done();
    done();
    expect(sounds()).toBe(1);
    expect(waiting()).toBe(1);
    expect(badge).toHaveBeenLastCalledWith(1);
  });

  it("continuações automáticas não repetem aviso pendente; nova fala rearma", () => {
    boardChanged(board(workspace("a")));
    done();
    emit("a-t", { type: "assistant.block", messageId: "next", index: 0, block: { kind: "text", text: "mais" } });
    done();
    expect(sounds()).toBe(1);
    speak();
    done();
    expect(sounds()).toBe(2);
  });

  it("pergunta avisa; responder permite avisar a próxima conclusão", () => {
    boardChanged(board(workspace("a")));
    question();
    question();
    expect(sounds()).toBe(1);
    emit("a-t", { type: "request.closed", requestId: "q", outcome: "answered" });
    done();
    expect(sounds()).toBe(2);
  });

  it("abas visíveis na mesa ou workspace não apitam com a janela em foco", () => {
    focused = true;
    visible.add("a-t");
    visible.add("b-t");
    boardChanged(board(workspace("a"), workspace("b")));
    done();
    question("b-t");
    expect(sounds()).toBe(0);
    expect(waiting()).toBe(0);
    // Aba recolhida ou outra aba do workspace continua merecendo aviso.
    visible.delete("b-t");
    question("b-t");
    expect(sounds()).toBe(1);
  });

  it("janela atrás avisa; voltar às conversas visíveis reconhece a pendência", () => {
    visible.add("a-t");
    boardChanged(board(workspace("a")));
    done();
    looked();
    expect(waiting()).toBe(1);
    focused = true;
    looked();
    expect(waiting()).toBe(0);
    expect(badge).toHaveBeenLastCalledWith(undefined);
  });

  it("cada aba avisa independentemente; o Dock conta um workspace", () => {
    boardChanged(board(workspace("a", [tab("a-t"), tab("b-t")], true)));
    done();
    done("b-t");
    expect(sounds()).toBe(2);
    expect(waiting()).toBe(1);
    boardChanged(board());
    expect(waiting()).toBe(0);
  });

  it("som desligado preserva a bolinha sem tocar", () => {
    setSound(false);
    boardChanged(board(workspace("a")));
    done();
    expect(sounds()).toBe(0);
    expect(waiting()).toBe(1);
    setSound(true);
    done();
    expect(sounds()).toBe(0);
    speak();
    done();
    expect(sounds()).toBe(1);
  });

  it("ignora interrupção, dados inválidos e sessões ausentes, remotas ou arquivadas", () => {
    boardChanged(board(workspace("a"), { ...workspace("b"), archived: true }, { ...workspace("c"), remote: {} } as Workspace));
    chatChanged("a-t", "invalid json");
    emit("a-t", { type: "turn.completed" });
    emit("a-t", { type: "turn.completed", outcome: "interrupted", message: "", durationMs: null, costUsd: null });
    done("unknown");
    done("b-t");
    done("c-t");
    expect(sounds()).toBe(0);
  });
});

it("comentário avisa uma vez, inclusive depois de reconectar", () => {
  inbox.push({ id: "comment" });
  teamChanged();
  teamChanged();
  inbox.length = 0;
  teamChanged();
  inbox.push({ id: "comment" });
  teamChanged();
  expect(sounds()).toBe(1);
  expect(waiting()).toBe(1);
});
