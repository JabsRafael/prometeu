import { describe, expect, it } from "vitest";
import { pieces, Timeline, summary, touched } from "./timeline";

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

  it("fala nova fecha a mensagem que estava chegando — e diz que ela mudou", () => {
    const t = new Timeline();
    t.push(ev({ type: "message_start", message: { id: "m1" } }));
    t.push(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    expect((t.items[0] as { streaming: boolean }).streaming).toBe(true);
    const touched = t.push(j({ type: "user", message: { role: "user", content: "outra" } }));
    expect(touched).toEqual([0, 1]);
    expect((t.items[0] as { streaming: boolean }).streaming).toBe(false);
  });

  it("o pensamento inteiro vem vazio; o que os deltas trouxeram fica", () => {
    const t = new Timeline();
    t.push(ev({ type: "message_start", message: { id: "m1" } }));
    t.push(ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
    t.push(ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pensei" } }));
    t.push(assistant("m1", { type: "thinking", thinking: "", signature: "x" }));
    const a = t.items[0];
    if (a.kind !== "assistant" || a.blocks[0].kind !== "thinking") throw new Error();
    expect(a.blocks[0].text).toBe("pensei");
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

  it("o fim do buffer sem turno assenta o que parecia estar chegando", () => {
    const t = new Timeline();
    t.push(j({ type: "user", message: { role: "user", content: "oi" } }));
    t.push(assistant("m1", { type: "text", text: "olá" }));
    t.push(j({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }));
    expect(t.busy).toBe(true);
    expect(t.push(j({ type: "prometheus", subtype: "state", busy: false }))).toEqual([1, 2]);
    expect(t.busy).toBe(false);
    expect((t.items[1] as { streaming: boolean }).streaming).toBe(false);
    expect(t.pending).toEqual([]);
    // Com turno, fica como está.
    t.push(assistant("m2", { type: "text", text: "de novo" }));
    t.push(j({ type: "prometheus", subtype: "state", busy: true }));
    expect(t.busy).toBe(true);
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

  it("initialize: a resposta traz os comandos de barra; o init tira os de terminal", () => {
    const t = new Timeline();
    expect(t.commands).toEqual([]);
    const answer = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "initialize",
        response: {
          commands: [
            { name: "compact", description: "Free up context", argumentHint: "<instructions>" },
            { name: "color", description: "Set the color" },
            { name: "release", description: "Solta uma versão" },
            { bogus: true },
          ],
        },
      },
    };
    expect(t.push(j(answer))).toEqual([]);
    expect(t.items).toEqual([]);
    expect(t.commands).toEqual([
      { name: "compact", description: "Free up context", hint: "<instructions>" },
      { name: "color", description: "Set the color", hint: "" },
      { name: "release", description: "Solta uma versão", hint: "" },
    ]);
    // O init vem depois da primeira fala e diz quais são de terminal.
    t.push(j({ type: "system", subtype: "init", slash_commands: ["compact", "color", "release"], terminal_slash_commands: ["color"] }));
    expect(t.commands.map((c) => c.name)).toEqual(["compact", "release"]);
    // Uma resposta nova (o processo subiu de novo) respeita o que o init disse.
    t.push(j(answer));
    expect(t.commands.map((c) => c.name)).toEqual(["compact", "release"]);
    // As outras respostas (permissão respondida) não mexem em nada.
    t.push(j({ type: "control_response", response: { subtype: "success", request_id: "x", response: {} } }));
    expect(t.commands.length).toBe(2);
  });

  it("skill: o corpo dela fica dentro do card, não vira fala", () => {
    const t = new Timeline();
    t.push(assistant("m1", { type: "tool_use", id: "tu1", name: "Skill", input: { skill: "release" } }));
    t.push(j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Launching skill: release" }] } }));
    t.push(j({ type: "user", isSynthetic: true, message: { role: "user", content: [{ type: "text", text: "Você vai soltar uma versão" }] } }));
    const a = t.items[0];
    if (a.kind !== "assistant" || a.blocks[0].kind !== "tool") throw new Error();
    expect(a.blocks[0].result).toBe("Você vai soltar uma versão");
    expect(t.items).toHaveLength(1);
  });

  it("skill em segundo plano não engole a fala seguinte", () => {
    const t = new Timeline();
    t.push(assistant("m1", { type: "tool_use", id: "tu1", name: "Skill", input: { skill: "code-review" } }));
    t.push(j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Launching skill: code-review" }] } }));
    t.push(assistant("m2", { type: "text", text: "chamei a skill" }));
    t.push(j({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-stdout>x</local-command-stdout>" } }));
    t.push(j({ type: "user", message: { role: "user", content: "e aí?" } }));
    if (t.items[0].kind !== "assistant" || t.items[0].blocks[0].kind !== "tool") throw new Error();
    expect(t.items[0].blocks[0].result).toBe("Launching skill: code-review");
    expect(t.items[2]).toMatchObject({ kind: "user", text: "e aí?" });
  });

  it("tarefa em segundo plano: o card gira até o aviso, e a lista diz quantas", () => {
    const t = new Timeline();
    t.push(assistant("m1", { type: "tool_use", id: "tu1", name: "Agent", input: { description: "mapear", run_in_background: true } }));
    t.push(j({ type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "tu1", description: "mapear", is_backgrounded: true }));
    t.push(j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Agent started" }] } }));
    t.push(j({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", description: "mapear" }] }));
    t.push(j({ type: "result", subtype: "success" }));
    const a = t.items[0];
    if (a.kind !== "assistant" || a.blocks[0].kind !== "tool") throw new Error();
    expect(a.blocks[0].done).toBe(true);
    expect(a.blocks[0].background).toBe(true);
    expect([...t.tasks.values()].map((k) => k.description)).toEqual(["mapear"]);
    expect(t.busy).toBe(false);
    const touched = t.push(
      j({ type: "system", subtype: "task_notification", task_id: "bg1", tool_use_id: "tu1", status: "completed", summary: 'Agent "mapear" finished' }),
    );
    expect(touched).toEqual([0, 1]);
    expect(a.blocks[0].background).toBe(false);
    expect(t.tasks.size).toBe(0);
    expect(t.items[1]).toMatchObject({ kind: "system", text: 'Agent "mapear" finished', error: false });
  });

  it("no transcript o aviso de tarefa é uma linha user com XML: vira a mesma linha de sistema", () => {
    const t = new Timeline();
    t.push(j({ type: "user", message: { role: "user", content: "<task-notification>\n<task-id>x</task-id>\n<summary>Agent \"mapear\" finished</summary>\n</task-notification>" } }));
    expect(t.items[0]).toMatchObject({ kind: "system", text: 'Agent "mapear" finished' });
    expect(t.busy).toBe(false);
  });

  it("compactar: legenda enquanto dura, tamanho no fim, resumo dobrado, eco do comando fora", () => {
    const t = new Timeline();
    t.push(j({ type: "user", message: { role: "user", content: "/compact" } }));
    t.push(j({ type: "system", subtype: "status", status: "compacting" }));
    expect(t.compacting).toBe(true);
    t.push(j({ type: "system", subtype: "status", status: null, compact_result: "success" }));
    expect(t.compacting).toBe(false);
    t.push(j({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 23978, post_tokens: 3132 } }));
    t.push(j({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation…" } }));
    t.push(j({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } }));
    t.push(j({ type: "user", message: { role: "user", content: "<command-name>/compact</command-name>" } }));
    t.push(j({ type: "result", subtype: "success" }));
    expect(t.items.map((i) => i.kind)).toEqual(["user", "system", "system"]);
    expect(t.items[1]).toMatchObject({ what: "compacted", tokens: [23978, 3132] });
    expect(t.items[2]).toMatchObject({ what: "summary" });
    expect(t.busy).toBe(false);
  });

  it("compactação que falha é um erro na tela, não um silêncio", () => {
    const t = new Timeline();
    t.push(j({ type: "system", subtype: "status", status: "compacting" }));
    t.push(j({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Not enough messages to compact." }));
    expect(t.compacting).toBe(false);
    expect(t.items[0]).toMatchObject({ kind: "system", error: true, text: "Not enough messages to compact." });
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

  it("com o JSON pela metade, lê o começo da string que já chegou", () => {
    expect(summary("Agent", {}, '{"description": "Mapear lacunas de te')).toBe("Mapear lacunas de te");
    expect(summary("Bash", {}, '{"command": "git diff\\nls", "descr')).toBe("git diff");
    expect(summary("Bash", {}, '{"command": "echo \\"a\\" ')).toBe('echo "a" ');
    expect(summary("Bash", {}, '{"comm')).toBe("");
  });
});

describe("pieces", () => {
  const work = (t: Timeline, id: string, tool: string, cmd: string) => {
    t.push(assistant(id, { type: "thinking", thinking: "hmm" }));
    t.push(assistant(id, { type: "tool_use", id: `tu-${id}`, name: tool, input: { command: cmd } }));
  };

  it("o trabalho seguido, mesmo em mensagens diferentes, é um pedaço só", () => {
    const t = new Timeline();
    t.push(j({ type: "user", message: { role: "user", content: "oi" } }));
    work(t, "m1", "Bash", "ls");
    work(t, "m2", "Bash", "pwd");
    work(t, "m3", "Read", "x");
    const p = pieces(t.items);
    expect(p.map((x) => x.kind)).toEqual(["item", "work"]);
    const w = p[1];
    if (w.kind !== "work") throw new Error();
    expect(w.refs.length).toBe(6);
    expect(w.key).toBe("w1.0");
  });

  it("a fala do agente fica de fora, e corta o trabalho em dois", () => {
    const t = new Timeline();
    work(t, "m1", "Bash", "ls");
    t.push(assistant("m2", { type: "text", text: "achei" }));
    work(t, "m3", "Bash", "pwd");
    expect(pieces(t.items).map((x) => x.kind)).toEqual(["work", "say", "work"]);
  });

  it("o que espera resposta corta o trabalho: o card não fica dentro do cartão", () => {
    const t = new Timeline();
    work(t, "m1", "Bash", "rm -rf /");
    t.push(
      j({
        type: "control_request",
        request_id: "r1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf /" } },
      }),
    );
    work(t, "m2", "Bash", "ls");
    expect(pieces(t.items).map((x) => x.kind)).toEqual(["work", "item", "work"]);
  });

  it("os arquivos que o agente mexeu vêm do último para o primeiro, sem repetir", () => {
    const t = new Timeline();
    t.push(assistant("m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/ws/a.rb" } }));
    t.push(assistant("m2", { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls /ws/nada.rb" } }));
    t.push(assistant("m3", { type: "tool_use", id: "t3", name: "Grep", input: { path: "/ws/app" } }));
    t.push(assistant("m4", { type: "tool_use", id: "t4", name: "Edit", input: { file_path: "/ws/b.rb" } }));
    t.push(assistant("m5", { type: "tool_use", id: "t5", name: "Read", input: { file_path: "/ws/a.rb" } }));
    // O Bash e o Grep não apontam um arquivo, e o a.rb lido duas vezes é um só,
    // na posição da última.
    expect(touched(t.items)).toEqual(["/ws/a.rb", "/ws/b.rb"]);
    expect(touched(t.items, 1)).toEqual(["/ws/a.rb"]);
  });

  it("a chave de um pedaço não muda quando a conversa cresce", () => {
    const t = new Timeline();
    work(t, "m1", "Bash", "ls");
    const before = pieces(t.items).map((x) => x.key);
    work(t, "m2", "Bash", "pwd");
    t.push(assistant("m3", { type: "text", text: "pronto" }));
    expect(pieces(t.items).map((x) => x.key).slice(0, before.length)).toEqual(before);
  });
});
