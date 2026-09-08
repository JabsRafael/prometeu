import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Down, Up } from "../relay/src/protocol";
import { t } from "./i18n";
import type { Board, Workspace } from "./types";

const config = {
  relay: "wss://relay.exemplo",
  team: "time1234",
  secret: "segredo-de-teste-1234567",
  member: "membro1",
  credential: "credencial-de-teste-com-tamanho-bastante",
  name: "Eu",
};

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "team_config" ? { config, default_name: "Eu" } : null,
  ),
}));

const {
  addNote,
  boardChanged,
  inboxCount,
  init,
  notesOf,
  onChange,
  onError,
  readInbox,
  replyNote,
  resolveNote,
  setName,
  supportsThreads,
  useTransport,
} = await import("./team");

/// A fake relay records outgoing frames and lets tests supply responses.
class Relay {
  sent: Up[] = [];
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string | ArrayBuffer | Uint8Array) {
    if (typeof data === "string" && data !== "ping") this.sent.push(JSON.parse(data) as Up);
  }
  close() {}

  says(frame: Down) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /// Return frames of one type in send order.
  only<T extends Up["t"]>(t: T) {
    return this.sent.filter((f): f is Extract<Up, { t: T }> => f.t === t);
  }
}

let relay: Relay;

function workspace(id: string, shared: boolean): Workspace {
  return {
    id,
    title: id,
    project: "p",
    repo: "/r",
    repo_name: "r",
    branch: "b",
    worktree: `/w/${id}`,
    repos: [],
    stage: "",
    archived: false,
    pinned: false,
    unread: false,
    agent: "claude",
    model: "",
    effort: "",
    mcp: null,
    plugins: null,
    port: null,
    issue: null,
    cleaned: false,
    shared,
    audience: null,
    preparing: false,
    failed: null,
    remote: null,
    tabs: [],
    active: null,
  };
}

const board = (...workspaces: Workspace[]): Board => ({ stages: [], projects: [], workspaces });

/// Connect and deliver welcome as the relay does on every connection.
function welcome() {
  relay.onopen?.();
  relay.says({ t: "welcome", comments: 1, you: config.member, members: [], shares: [], inbox: [], watching: {} });
}

/// Reconnect after failure using the client's increasing backoff.
function reconnect() {
  relay.onclose?.();
  vi.advanceTimersByTime(60_000);
  welcome();
}

beforeEach(async () => {
  vi.useFakeTimers();
  relay = new Relay();
  useTransport({
    socket: () => relay,
    create: async () => ({ team: "", secret: "", member: "", credential: "" }),
    enroll: async () => ({ member: "", credential: "" }),
    needsRelay: true,
  });
  await init();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("notas do time", () => {
  it("não consulta um workspace local que nunca foi anunciado", () => {
    expect(notesOf("workspace-local-nunca-compartilhado")).toEqual([]);
  });

  it("pergunta pelas notas depois de anunciar o que é meu", () => {
    welcome();
    boardChanged(board(workspace("ws1", true)));
    notesOf("ws1");
    relay.sent = [];

    reconnect();
    boardChanged(board(workspace("ws1", true)));

    const ordem = relay.sent.filter((f) => f.t === "share" || f.t === "notes").map((f) => f.t);
    expect(ordem).toEqual(["share", "notes"]);
  });

  it("não repete o pedido de um workspace que parou de ser compartilhado", () => {
    welcome();
    boardChanged(board(workspace("ws1", true)));
    notesOf("ws1");
    // Stopping a share removes its relay board entry while preserving the notes-cache lookup history.
    boardChanged(board(workspace("ws1", false)));
    relay.sent = [];

    reconnect();

    expect(relay.only("notes")).toEqual([]);
  });

  it("envia comentário, resposta e resolução; atualização substitui a raiz", () => {
    welcome();
    boardChanged(board(workspace("comments-ws", true)));
    expect(supportsThreads()).toBe(true);
    expect(addNote("comments-ws", null, null, "oi", [], null)).toBe(true);
    expect(replyNote("comments-ws", "root", "feito", [])).toBe(true);
    expect(resolveNote("comments-ws", "root")).toBe(true);
    expect(relay.only("note").slice(-1)[0]).toMatchObject({ text: "oi", tab: null, anchor: null });
    expect(relay.only("note_reply").slice(-1)[0]).toMatchObject({ note: "root", text: "feito" });
    expect(relay.only("note_resolve").slice(-1)[0]).toMatchObject({ note: "root" });

    const root = { id: "root", ws: "comments-ws", author: "membro1", text: "oi", mentions: [], quote: null, ts: 1, tab: null, anchor: null, parent: null, resolved: false };
    relay.says({ t: "notes", ws: "comments-ws", items: [root] });
    relay.says({ t: "note", note: { ...root, resolved: true } });
    expect(notesOf("comments-ws")).toHaveLength(1);
    expect(notesOf("comments-ws")[0].resolved).toBe(true);
  });

  it("abrir item de Para mim não o remove", () => {
    welcome();
    relay.says({ t: "inbox", items: [{ id: "root", ws: "ws1", author: "alice", ts: 1, tab: "t1", text: "revisa" }] });
    expect(readInbox("root")).toEqual({ workspace: "ws1", note: "root", tab: "t1" });
    expect(inboxCount()).toBe(1);
    expect(relay.only("inbox_read")).toEqual([]);
  });

  it("relay antigo mantém a leitura como fallback para limpar a caixa", () => {
    relay.onopen?.();
    relay.says({
      t: "welcome",
      you: config.member,
      members: [],
      shares: [],
      inbox: [{ id: "legacy", ws: "ws1", author: "alice", ts: 1 }],
      watching: {},
    });
    expect(supportsThreads()).toBe(false);
    expect(readInbox("legacy")).toEqual({ workspace: "ws1", note: "legacy", tab: null });
    expect(inboxCount()).toBe(0);
    expect(relay.only("inbox_read")).toEqual([{ t: "inbox_read", id: "legacy" }]);
  });
});

describe("erro do relay", () => {
  it("cala o que o app perguntou sozinho", () => {
    const fail = vi.fn();
    onError(fail);
    welcome();

    relay.says({ t: "error", code: "noShare" });
    relay.says({ t: "error", code: "noTab" });

    expect(fail).not.toHaveBeenCalled();
  });

  it("mostra o que responde ao que a pessoa fez", () => {
    const fail = vi.fn();
    onError(fail);
    welcome();

    relay.says({ t: "error", code: "tooBig" });

    expect(fail).toHaveBeenCalledWith(t("err.team.tooBig"));
  });
});

describe("ouvintes", () => {
  it("deixa uma tela removida parar de ouvir mudanças", async () => {
    const changed = vi.fn();
    const stop = onChange(changed);

    await setName("Primeiro nome");
    expect(changed).toHaveBeenCalledTimes(1);

    stop();
    await setName("Segundo nome");
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
