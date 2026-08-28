import { describe, expect, it, vi } from "vitest";
// O que o Dock recebeu, por chamada. O módulo da janela do Tauri não existe
// fora do app; aqui ele é só este registro.
const sent: (number | undefined)[] = [];
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setBadgeCount: async (n?: number) => void sent.push(n) }),
}));
import { boardChanged, init, looked, stopped, waiting } from "./alert";
import type { Board, Status, Workspace } from "./types";

const tab = (id: string, status: Status) => ({ id, title: id, status, note: null, tokens: null });
const board = (...wss: [string, ReturnType<typeof tab>[]][]): Board => ({
  stages: [],
  projects: [],
  workspaces: wss.map(([id, tabs]) => ({ id, tabs, unread: false }) as unknown as Workspace),
});

describe("stopped", () => {
  it("o primeiro quadro só semeia: nada é novidade", () => {
    const { fresh, now } = stopped(new Map(), board(["a", [tab("t1", "pronta")]]));
    expect(fresh).toEqual([]);
    expect(now.get("t1")).toBe("pronta");
  });

  it("rodando → pronta é novidade; pronta → pronta não", () => {
    const first = stopped(new Map(), board(["a", [tab("t1", "rodando")]]));
    const second = stopped(first.now, board(["a", [tab("t1", "pronta")]]));
    expect(second.fresh).toEqual(["a"]);
    const third = stopped(second.now, board(["a", [tab("t1", "pronta")]]));
    expect(third.fresh).toEqual([]);
  });

  it("rodando → querendo é novidade, e o workspace aparece uma vez só", () => {
    const first = stopped(new Map(), board(["a", [tab("t1", "rodando"), tab("t2", "rodando")]]));
    const second = stopped(first.now, board(["a", [tab("t1", "querendo"), tab("t2", "pronta")]]));
    expect(second.fresh).toEqual(["a"]);
  });

  it("aba nova já parada não apita; desligar também não", () => {
    const first = stopped(new Map(), board(["a", [tab("t1", "rodando")]]));
    const second = stopped(first.now, board(["a", [tab("t1", "rodando"), tab("t2", "pronta")]]));
    expect(second.fresh).toEqual([]);
    const third = stopped(second.now, board(["a", [tab("t1", "desligada"), tab("t2", "pronta")]]));
    expect(third.fresh).toEqual([]);
  });

  it("aba que sumiu sai do mapa", () => {
    const first = stopped(new Map(), board(["a", [tab("t1", "rodando")]]));
    const second = stopped(first.now, board(["a", []]));
    expect(second.now.size).toBe(0);
  });
});

describe("badge", () => {
  const ws = (id: string, status: Status, unread = false) =>
    ({ id, unread, tabs: [tab(`${id}-t`, status)] }) as unknown as Workspace;
  const board = (...wss: Workspace[]): Board => ({ stages: [], projects: [], workspaces: wss });

  // Vitest roda em node: o que o módulo pede do navegador entra aqui, mínimo.
  let focused = false;
  const g = globalThis as Record<string, unknown>;
  g.document = { hasFocus: () => focused };
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.localStorage = { getItem: () => "0", setItem() {}, removeItem() {} };
  const last = () => sent[sent.length - 1];

  it("parar com a janela atrás conta na bolinha mesmo com o workspace na tela; olhar de novo zera", async () => {
    focused = false;
    init({ looking: () => "a" });
    boardChanged(board(ws("a", "rodando")));
    expect(waiting()).toBe(0);
    boardChanged(board(ws("a", "pronta")));
    expect(waiting()).toBe(1);
    await Promise.resolve();
    expect(last()).toBe(1);
    // Sem foco, olhar não conta.
    looked();
    expect(waiting()).toBe(1);
    focused = true;
    looked();
    expect(waiting()).toBe(0);
    await Promise.resolve();
    // Zero apaga: o Dock recebe "sem número", não "0".
    expect(last()).toBeUndefined();
  });

  it("o unread do back soma sem contar duas vezes, e workspace removido some", () => {
    focused = false;
    init({ looking: () => null });
    boardChanged(board(ws("b", "rodando"), ws("c", "rodando")));
    boardChanged(board(ws("b", "pronta", true), ws("c", "querendo")));
    expect(waiting()).toBe(2);
    boardChanged(board(ws("c", "querendo")));
    expect(waiting()).toBe(1);
    boardChanged(board());
    expect(waiting()).toBe(0);
  });

  it("com a janela na frente e o workspace na tela, parar não é novidade", () => {
    focused = true;
    init({ looking: () => "d" });
    boardChanged(board(ws("d", "rodando")));
    boardChanged(board(ws("d", "pronta")));
    expect(waiting()).toBe(0);
  });
});
