import { describe, expect, it } from "vitest";
import { Timeline, summary } from "./timeline";

const j = (o: unknown) => JSON.stringify(o);
const assistant = (id: string, block: unknown, extra = {}) =>
  j({ type: "assistant", message: { id, role: "assistant", content: [block] }, uuid: `u-${Math.random()}`, ...extra });
const ev = (event: unknown) => j({ type: "stream_event", event, parent_tool_use_id: null });

describe("Timeline", () => {
  it("uma fala, uma resposta em blocos com o mesmo id, um item só", () => {
    const t = new Timeline();
    t.push(j({ type: "user", message: { role: "user", content: "oi" }, timestamp: "2026-08-27T22:12:36.835Z" }));
    expect(t.busy).toBe(true);
    t.push(assistant("m1", { type: "thinking", thinking: "hmm" }));
    t.push(assistant("m1", { type: "text", text: "olá" }));
    t.push(assistant("m1", { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }));
    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const a = t.items[1];
    if (a.kind !== "assistant") throw new Error();
    expect(a.blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool"]);
    expect(t.items[0].ts).toBe(Date.parse("2026-08-27T22:12:36.835Z"));
  });

  it("o resultado da ferramenta entra no bloco dela, não numa fala", () => {
    const t = new Timeline();
    t.push(assistant("m1", { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }));
    const touched = t.push(
      j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "a.txt\n" }] } }),
    );
    expect(touched).toEqual([0]);
    expect(t.items).toHaveLength(1);
    const a = t.items[0];
    if (a.kind !== "assistant" || a.blocks[0].kind !== "tool") throw new Error();
    expect(a.blocks[0].result).toBe("a.txt\n");
    expect(a.blocks[0].done).toBe(true);
  });

  it("o rascunho do streaming vira o bloco inteiro quando a linha chega", () => {
    const t = new Timeline();
    t.push(ev({ type: "message_start", message: { id: "m1" } }));
    t.push(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    t.push(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ol" } }));
    t.push(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "á" } }));
    let a = t.items[0];
    if (a.kind !== "assistant" || a.blocks[0].kind !== "text") throw new Error();
    expect(a.blocks[0].text).toBe("olá");
    expect(a.streaming).toBe(true);

    t.push(ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "Write", input: {} } }));
    t.push(ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path": "a' } }));
    t.push(ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '.txt"}' } }));
    t.push(ev({ type: "content_block_stop", index: 1 }));
    a = t.items[0];
    if (a.kind !== "assistant" || a.blocks[1].kind !== "tool") throw new Error();
    expect(a.blocks[1].input).toEqual({ file_path: "a.txt" });

    // As linhas inteiras caem em cima, na ordem: um item só, dois blocos.
    t.push(assistant("m1", { type: "text", text: "olá!" }));
    t.push(assistant("m1", { type: "tool_use", id: "tu1", name: "Write", input: { file_path: "a.txt", content: "x" } }));
    expect(t.items).toHaveLength(1);
    a = t.items[0];
    if (a.kind !== "assistant" || a.blocks[0].kind !== "text" || a.blocks[1].kind !== "tool") throw new Error();
    expect(a.blocks[0].text).toBe("olá!");
    expect(a.blocks[1].input).toEqual({ file_path: "a.txt", content: "x" });

    t.push(j({ type: "result", subtype: "success", is_error: false, duration_ms: 10 }));
    expect(t.busy).toBe(false);
    expect((t.items[0] as { streaming: boolean }).streaming).toBe(false);
    // Turno que terminou bem não ganha linha.
    expect(t.items).toHaveLength(1);
  });

  it("delta sem item aberto é descartado — o colega chegou no meio", () => {
    const t = new Timeline();
    expect(t.push(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }))).toEqual([]);
    expect(t.items).toHaveLength(0);
  });

  it("um pedido de permissão vira card, e o resultado da ferramenta o fecha", () => {
    const t = new Timeline();
    t.push(assistant("m1", { type: "tool_use", id: "tu1", name: "ExitPlanMode", input: { plan: "# P" } }));
    t.push(
      j({
        type: "control_request",
        request_id: "r1",
        request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "# P" }, tool_use_id: "tu1" },
      }),
    );
    expect(t.pending.map((a) => a.id)).toEqual(["r1"]);
    // De novo a mesma linha (snapshot mais ao vivo cruzados): um card só.
    t.push(
      j({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: {} } }),
    );
    expect(t.items.filter((i) => i.kind === "ask")).toHaveLength(1);
    t.push(j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } }));
    expect(t.pending).toEqual([]);
  });

  it("responder daqui fecha o card na hora", () => {
    const t = new Timeline();
    t.push(j({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }));
    expect(t.answer("r1")).toEqual([0]);
    expect(t.pending).toEqual([]);
  });

  it("erro no turno vira linha; interrupção também", () => {
    const t = new Timeline();
    t.push(j({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrompido"] }));
    expect(t.items[0]).toMatchObject({ kind: "result", error: true, text: "interrompido" });
  });

  it("o que não é conversa não entra: meta, subagente, ruído, lixo", () => {
    const t = new Timeline();
    t.push(j({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-stdout>x</local-command-stdout>" } }));
    t.push(j({ type: "assistant", parent_tool_use_id: "tu9", message: { id: "sub", content: [{ type: "text", text: "sou subagente" }] } }));
    t.push(j({ type: "system", subtype: "hook_started" }));
    t.push(j({ type: "attachment", attachment: {} }));
    t.push("{meia linha");
    expect(t.items).toEqual([]);
  });

  it("compactação: o aviso enquanto dura, a fronteira depois", () => {
    const t = new Timeline();
    t.push(j({ type: "system", subtype: "status", status: "compacting" }));
    expect(t.compacting).toBe(true);
    t.push(j({ type: "system", subtype: "status", status: null }));
    expect(t.compacting).toBe(false);
    t.push(j({ type: "system", subtype: "compact_boundary" }));
    expect(t.items[0]).toMatchObject({ kind: "system", text: "compacted" });
  });

  it("o stderr do processo aparece como erro", () => {
    const t = new Timeline();
    t.push(j({ type: "prometheus", subtype: "stderr", text: "No conversation found" }));
    expect(t.items[0]).toMatchObject({ kind: "system", error: true, text: "No conversation found" });
  });

  it("a hora nunca volta: linha sem carimbo herda a anterior", () => {
    const t = new Timeline();
    t.push(j({ type: "user", message: { role: "user", content: "a" }, ts: 1000 }));
    t.push(assistant("m1", { type: "text", text: "b" }));
    expect(t.items[1].ts).toBe(1000);
    t.push(j({ type: "user", message: { role: "user", content: "c" }, timestamp: new Date(500).toISOString() }));
    expect(t.items[2].ts).toBe(500);
  });

  it("load lê um buffer inteiro e pula o que estiver cortado", () => {
    const t = new Timeline();
    t.load(`ssage":{"content":"cortado"}}\n${j({ type: "user", message: { role: "user", content: "inteira" } })}\n`);
    expect(t.items.map((i) => i.kind)).toEqual(["user"]);
  });
});

describe("summary", () => {
  it("diz o alvo da ferramenta numa linha", () => {
    expect(summary("Bash", { command: "ls -la\necho x", description: "lista" })).toBe("ls -la");
    expect(summary("Read", { file_path: "/a/b.rs" })).toBe("/a/b.rs");
    expect(summary("Task", { description: "procurar bugs", prompt: "x" })).toBe("procurar bugs");
    expect(summary("Foo", {})).toBe("");
  });
});
