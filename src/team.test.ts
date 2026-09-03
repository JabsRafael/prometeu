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

const { init, boardChanged, notesOf, onError, useTransport } = await import("./team");

/// O relay de mentira: guarda o que o app mandou e deixa o teste responder.
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
  /// Só os frames de um tipo, na ordem em que saíram.
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

/// Conecta e entrega o `welcome`, como o relay faz a cada conexão.
function welcome() {
  relay.onopen?.();
  relay.says({ t: "welcome", you: config.member, members: [], shares: [], inbox: [], watching: {} });
}

/// A conexão cai e o app volta sozinho, com a espera crescente que ele usa.
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
    // Parou de compartilhar: sai do quadro do relay, mas o cache de notas
    // continua sabendo que já se perguntou por ele.
    boardChanged(board(workspace("ws1", false)));
    relay.sent = [];

    reconnect();

    expect(relay.only("notes")).toEqual([]);
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
