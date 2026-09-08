import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const begin = (tab = "a-t") => {
  emit(tab, { type: "session.state", state: "busy" });
  emit(tab, { type: "assistant.started", messageId: "m" });
};
const settle = () => vi.advanceTimersByTime(1_000);
const background = (tasks: string[], tab = "a-t") => emit(tab, {
  type: "background.changed", tasks: tasks.map((id) => ({ id, description: id, toolId: null })),
});
const question = (tab = "a-t") => emit(tab, {
  type: "request.opened", requestId: "q", kind: "question", toolId: null, tool: "AskUserQuestion", input: {},
});
const speak = (tab = "a-t") => emit(tab, { type: "user.message", content: [{ kind: "text", text: "continue" }] });
// Each bell uses two oscillators; count actual playback, not only notification decisions.
const sounds = () => start.mock.calls.length / 2;
let focused = false;
const visible = new Set<string>();

beforeEach(() => {
  vi.useFakeTimers();
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

afterEach(() => vi.useRealTimers());

describe("som de conclusão", () => {
  it("exige envio aceito e conclusão; status, mensagens sintéticas e perguntas não tocam", () => {
    boardChanged(board(workspace("a")));
    for (let i = 0; i < 5; i++) {
      boardChanged(board(workspace("a", [tab("a-t", i % 2 ? "pronta" : "rodando")])));
      speak();
      emit("a-t", { type: "assistant.started", messageId: "m" });
      question();
      emit("a-t", { type: "request.closed", requestId: "q", outcome: "answered" });
      done();
      settle();
    }
    expect(sounds()).toBe(0);
    begin();
    question();
    settle();
    expect(sounds()).toBe(0);
    expect(waiting()).toBe(1);
    emit("a-t", { type: "request.closed", requestId: "q", outcome: "answered" });
    done();
    settle();
    expect(sounds()).toBe(1);
  });

  it("ferramentas e streaming longos ficam silenciosos; conclusão avisa uma vez", () => {
    boardChanged(board(workspace("a")));
    begin();
    for (let i = 0; i < 10; i++) {
      emit("a-t", { type: "assistant.block", messageId: "m", index: i, block: { kind: "text", text: "trabalhando" } });
      emit("a-t", { type: "tool.completed", toolId: "tool", output: "ok", error: false, background: false });
      emit("a-t", { type: "context.updated", used: i, window: 100 });
      settle();
    }
    expect(sounds()).toBe(0);
    done();
    emit("a-t", { type: "context.compaction", state: "stopped", detail: "" });
    done();
    settle();
    expect(sounds()).toBe(1);
    expect(waiting()).toBe(1);
    expect(badge).toHaveBeenLastCalledWith(1);
  });

  it("não confunde resultados intermediários com fim enquanto há tarefas em background", () => {
    boardChanged(board(workspace("a")));
    begin();
    background(["one", "two"]);
    done();
    settle();
    expect(sounds()).toBe(0);
    focused = true;
    visible.add("a-t");
    looked();
    focused = false;
    background(["two"]);
    speak();
    emit("a-t", { type: "assistant.started", messageId: "automatic" });
    done();
    settle();
    expect(sounds()).toBe(0);
    background([]);
    settle();
    expect(sounds()).toBe(0);
    emit("a-t", { type: "assistant.started", messageId: "final" });
    done();
    settle();
    expect(sounds()).toBe(1);
  });

  it("retomada antes do som cancela conclusão candidata, sem inferir fim por silêncio", () => {
    boardChanged(board(workspace("a")));
    begin();
    done();
    vi.advanceTimersByTime(500);
    emit("a-t", { type: "assistant.started", messageId: "continued" });
    vi.advanceTimersByTime(30_000);
    expect(sounds()).toBe(0);
    done();
    settle();
    expect(sounds()).toBe(1);
  });

  it("olhar, responder e receber mensagens sintéticas nunca rearmam execução já avisada", () => {
    boardChanged(board(workspace("a")));
    begin();
    done();
    settle();
    focused = true;
    visible.add("a-t");
    looked();
    expect(waiting()).toBe(0);
    focused = false;
    speak();
    question();
    emit("a-t", { type: "request.closed", requestId: "q", outcome: "answered" });
    emit("a-t", { type: "assistant.started", messageId: "automatic" });
    done();
    settle();
    expect(sounds()).toBe(1);
    begin();
    done();
    settle();
    expect(sounds()).toBe(2);
  });

  it("consome conclusão vista ou silenciada; sair da aba ou ligar som não toca depois", () => {
    boardChanged(board(workspace("a")));
    focused = true;
    visible.add("a-t");
    begin();
    done();
    settle();
    focused = false;
    done();
    settle();
    expect(sounds()).toBe(0);
    setSound(false);
    begin();
    done();
    settle();
    expect(waiting()).toBe(1);
    setSound(true);
    done();
    settle();
    expect(sounds()).toBe(0);
    begin();
    done();
    settle();
    expect(sounds()).toBe(1);
  });

  it("ver conclusão durante espera cancela som mesmo saindo antes de tocar", () => {
    boardChanged(board(workspace("a")));
    begin();
    done();
    focused = true;
    visible.add("a-t");
    looked();
    focused = false;
    settle();
    expect(sounds()).toBe(0);
    done();
    settle();
    expect(sounds()).toBe(0);
  });

  it("cada aba conclui independentemente; Dock conta workspaces e preserva unread", () => {
    boardChanged(board(workspace("a", [tab("a-t"), tab("b-t")], true)));
    begin();
    begin("b-t");
    done();
    done("b-t");
    settle();
    expect(sounds()).toBe(2);
    expect(waiting()).toBe(1);
    boardChanged(board());
    expect(waiting()).toBe(0);
  });

  it("arquivar ou remover aba cancela som pendente; remotos nunca armam aviso", () => {
    boardChanged(board(workspace("a"), { ...workspace("b"), remote: {} } as Workspace));
    begin();
    done();
    begin("b-t");
    done("b-t");
    boardChanged(board({ ...workspace("a"), archived: true }));
    settle();
    expect(sounds()).toBe(0);
    expect(waiting()).toBe(0);
  });

  it("reiniciar processo descarta background antigo; novo envio no mesmo processo preserva tarefas", () => {
    boardChanged(board(workspace("a")));
    begin();
    background(["old"]);
    begin();
    done();
    settle();
    expect(sounds()).toBe(0);
    emit("a-t", { type: "session.state", state: "starting" });
    begin();
    done();
    settle();
    expect(sounds()).toBe(1);
  });

  it("ignora dados inválidos, comandos locais e interrupções; erro terminal avisa", () => {
    boardChanged(board(workspace("a")));
    chatChanged("a-t", "invalid json");
    emit("a-t", { type: "turn.completed" });
    emit("a-t", { type: "session.state", state: "busy" });
    emit("a-t", { type: "context.reported", markdown: "context" });
    done();
    emit("a-t", { type: "assistant.started", messageId: "automatic" });
    done();
    settle();
    expect(sounds()).toBe(0);
    begin();
    emit("a-t", { type: "turn.completed", outcome: "interrupted", message: "", durationMs: null, costUsd: null });
    done();
    settle();
    expect(sounds()).toBe(0);
    emit("a-t", { type: "session.state", state: "busy" });
    emit("a-t", { type: "turn.completed", outcome: "error", message: "failed", durationMs: null, costUsd: null });
    settle();
    expect(sounds()).toBe(1);
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
