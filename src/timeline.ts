/// A conversa como a tela a desenha, a partir das linhas que o `claude -p`
/// escreve em stream-json — e das mesmas linhas em repouso, no transcript.
///
/// É um reducer: entra uma linha de JSON, sai a lista de itens atualizada e
/// quais itens mudaram. Sem DOM, sem Tauri, sem rede — é por isso que dá para
/// testar com um punhado de strings, e é a mesma conta nos dois lados do
/// relay: o dono e o colega desenham a mesma coisa a partir dos mesmos bytes.
///
/// O que o stream manda, e o que se faz com cada coisa:
///
/// - `user` — a fala da pessoa, ou o resultado de uma ferramenta (que vai
///   parar dentro do bloco da ferramenta, não numa fala).
/// - `assistant` — um bloco por linha (texto, pensamento, ferramenta), todos
///   com o mesmo `message.id`: viram um item só.
/// - `stream_event` — o mesmo bloco chegando letra a letra, antes da linha
///   `assistant` inteira. Desenha o rascunho; a linha inteira o substitui.
/// - `control_request` — pedido de permissão, pergunta, plano: um card que
///   espera resposta.
/// - `result` — o fim do turno.
/// - `system` — o começo (`init`), a compactação, e ruído que se ignora.

export type ToolBlock = {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  /// O JSON do input chegando em pedaços, antes de dar para ler inteiro.
  json: string;
  result: string | null;
  error: boolean;
  /// O resultado chegou (ou o bloco foi finalizado sem resultado ainda).
  done: boolean;
};
export type Block = { kind: "text"; text: string } | { kind: "thinking"; text: string } | ToolBlock;

export type Ask = {
  kind: "ask";
  ts: number;
  /// O `request_id` — é com ele que a resposta volta.
  id: string;
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
  answered: boolean;
};

export type Item =
  | { kind: "user"; ts: number; text: string }
  | { kind: "assistant"; ts: number; msg: string; blocks: Block[]; streaming: boolean; next: number }
  | Ask
  | { kind: "result"; ts: number; error: boolean; text: string; cost: number | null; ms: number | null }
  | { kind: "system"; ts: number; text: string; error: boolean };

type Line = Record<string, any>;

export class Timeline {
  items: Item[] = [];
  /// Um turno em andamento: a fala foi, e o `result` ainda não veio.
  busy = false;
  compacting = false;
  /// A ferramenta de cada `tool_use_id`, para o resultado achar o bloco.
  private tools = new Map<string, { item: number; block: number }>();
  private lastTs = 0;

  /// Os pedidos esperando resposta.
  get pending(): Ask[] {
    return this.items.filter((i): i is Ask => i.kind === "ask" && !i.answered);
  }

  /// Todas as linhas de um buffer ou snapshot, de uma vez. Linha que não é
  /// JSON (o começo cortado de um buffer que passou do teto) é pulada.
  load(text: string, now = Date.now()) {
    for (const line of text.split("\n")) {
      if (line.trim()) this.push(line, now);
    }
  }

  /// Uma linha. Devolve os índices dos itens que mudaram — é o que a tela
  /// redesenha, em vez da conversa inteira a cada letra.
  push(line: string, now = Date.now()): number[] {
    let o: Line;
    try {
      o = JSON.parse(line);
    } catch {
      return [];
    }
    if (!o || typeof o !== "object") return [];
    // Subagentes escrevem no mesmo cano com o pai marcado; a conversa é a de
    // cima. O que eles fizeram aparece no resultado da ferramenta Task.
    if (o.isSidechain || o.parent_tool_use_id) return [];
    const ts = this.when(o, now);
    switch (o.type) {
      case "user":
        return this.user(o, ts);
      case "assistant":
        return this.assistant(o, ts);
      case "stream_event":
        return this.stream(o, ts);
      case "control_request":
        return this.ask(o, ts);
      case "result":
        return this.result(o, ts);
      case "system":
        return this.system(o, ts);
      case "prometheus":
        if (o.subtype === "stderr") return [this.add({ kind: "system", ts, text: String(o.text), error: true })];
        return [];
      default:
        return [];
    }
  }

  /// A hora de uma linha: a do transcript, a que o app carimbou ao mandar a
  /// fala, ou — ao vivo, sem nenhuma — agora. Nunca antes da anterior, para as
  /// notas do time entrarem no lugar certo entre os itens.
  private when(o: Line, now: number): number {
    let ts = typeof o.ts === "number" ? o.ts : o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ts)) ts = this.lastTs || now;
    this.lastTs = Math.max(this.lastTs, ts);
    return ts;
  }

  private add(item: Item): number {
    // Fala nova, ou mensagem nova do agente: o que estava chegando letra a
    // letra acabou — o `result` só fecha o turno, não cada mensagem.
    if (item.kind === "user" || item.kind === "assistant") this.settle();
    this.items.push(item);
    return this.items.length - 1;
  }

  /// Nenhuma mensagem do agente continua "chegando" antes daqui.
  private settle() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === "assistant" && it.streaming) it.streaming = false;
      else if (it.kind === "assistant") break;
    }
  }

  private user(o: Line, ts: number): number[] {
    // `isMeta` é o que o Claude Code injeta por conta própria — saída de
    // comando, lembrete de sistema. Não foi ninguém que falou.
    if (o.isMeta) return [];
    const content = o.message?.content;
    if (typeof content === "string") {
      if (!content.trim()) return [];
      this.busy = true;
      return [this.add({ kind: "user", ts, text: content })];
    }
    if (!Array.isArray(content)) return [];
    const touched: number[] = [];
    const texts: string[] = [];
    for (const block of content) {
      if (block?.type === "tool_result") {
        const at = this.tools.get(block.tool_use_id);
        if (!at) continue;
        const item = this.items[at.item];
        if (item.kind !== "assistant") continue;
        const tool = item.blocks[at.block];
        if (tool?.kind !== "tool") continue;
        tool.result = resultText(block.content);
        tool.error = !!block.is_error;
        tool.done = true;
        touched.push(at.item);
        // O resultado de uma ferramenta que pedia permissão é a resposta ao
        // pedido — de quem quer que tenha respondido.
        for (const ask of this.items) {
          if (ask.kind === "ask" && ask.toolUseId === block.tool_use_id) ask.answered = true;
        }
      } else if (block?.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block?.type === "image") {
        texts.push("[imagem]");
      }
    }
    if (texts.length) {
      this.busy = true;
      touched.push(this.add({ kind: "user", ts, text: texts.join("\n\n") }));
    }
    return touched;
  }

  /// A linha `assistant` inteira de um bloco. Cai em cima do rascunho que o
  /// streaming desenhou — o n-ésimo bloco finalizado é o de índice n — ou
  /// entra no fim, quando não houve rascunho (transcript, ou colega que abriu
  /// a conversa no meio).
  private assistant(o: Line, ts: number): number[] {
    const msg = String(o.message?.id ?? o.uuid ?? "");
    const content = Array.isArray(o.message?.content) ? o.message.content : [];
    let at = this.findAssistant(msg);
    if (at === -1) at = this.add({ kind: "assistant", ts, msg, blocks: [], streaming: true, next: 0 });
    const item = this.items[at];
    if (item.kind !== "assistant") return [];
    this.busy = true;
    for (const raw of content) {
      const block = toBlock(raw);
      if (!block) continue;
      const index = item.next++;
      item.blocks[index] = block;
      if (block.kind === "tool") this.tools.set(block.id, { item: at, block: index });
    }
    return [at];
  }

  private findAssistant(msg: string): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === "assistant") return it.msg === msg ? i : -1;
      // Uma fala ou um resultado no meio: a mensagem acabou; a próxima linha
      // com o mesmo id (uma retomada) é outra.
      if (it.kind === "user" || it.kind === "result") return -1;
    }
    return -1;
  }

  /// O rascunho. `message_start` abre o item; cada bloco entra pelo índice
  /// que o próprio evento traz; os deltas somam. Delta sem item aberto — o
  /// colega chegou no meio — é descartado: a linha inteira vem logo atrás.
  private stream(o: Line, ts: number): number[] {
    const ev = o.event;
    if (!ev) return [];
    if (ev.type === "message_start") {
      const msg = String(ev.message?.id ?? "");
      if (this.findAssistant(msg) !== -1) return [];
      this.busy = true;
      return [this.add({ kind: "assistant", ts, msg, blocks: [], streaming: true, next: 0 })];
    }
    const at = this.streamingAt();
    if (at === -1) return [];
    const item = this.items[at];
    if (item.kind !== "assistant") return [];
    const index = Number(ev.index);
    switch (ev.type) {
      case "content_block_start": {
        if (index < item.next) return [];
        const block = toBlock(ev.content_block);
        if (!block) return [];
        item.blocks[index] = block;
        if (block.kind === "tool") this.tools.set(block.id, { item: at, block: index });
        return [at];
      }
      case "content_block_delta": {
        if (index < item.next) return [];
        const block = item.blocks[index];
        const d = ev.delta ?? {};
        if (!block) return [];
        if (block.kind === "text" && d.type === "text_delta") block.text += String(d.text ?? "");
        else if (block.kind === "thinking" && d.type === "thinking_delta") block.text += String(d.thinking ?? "");
        else if (block.kind === "tool" && d.type === "input_json_delta") {
          block.json += String(d.partial_json ?? "");
          block.input = tryJson(block.json) ?? block.input;
        } else return [];
        return [at];
      }
      case "content_block_stop": {
        const block = item.blocks[index];
        if (block?.kind === "tool" && block.json) block.input = tryJson(block.json) ?? block.input;
        return block ? [at] : [];
      }
      case "message_stop":
        return [];
      default:
        return [];
    }
  }

  private streamingAt(): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === "assistant") return it.streaming ? i : -1;
    }
    return -1;
  }

  private ask(o: Line, ts: number): number[] {
    const req = o.request ?? {};
    if (req.subtype !== "can_use_tool") return [];
    const id = String(o.request_id ?? "");
    if (!id || this.items.some((i) => i.kind === "ask" && i.id === id)) return [];
    this.busy = true;
    return [
      this.add({
        kind: "ask",
        ts,
        id,
        tool: String(req.tool_name ?? ""),
        input: typeof req.input === "object" && req.input ? req.input : {},
        toolUseId: req.tool_use_id ? String(req.tool_use_id) : null,
        answered: false,
      }),
    ];
  }

  /// Respondido daqui: o card fecha antes de o stream confirmar.
  answer(id: string): number[] {
    const at = this.items.findIndex((i) => i.kind === "ask" && i.id === id);
    if (at === -1) return [];
    (this.items[at] as Ask).answered = true;
    return [at];
  }

  private result(o: Line, ts: number): number[] {
    this.busy = false;
    const touched: number[] = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === "assistant" && it.streaming) {
        it.streaming = false;
        touched.push(i);
      }
      if (it.kind === "ask" && !it.answered) {
        it.answered = true;
        touched.push(i);
      }
      if (it.kind === "user") break;
    }
    const error = !!o.is_error;
    const errors: string[] = Array.isArray(o.errors) ? o.errors.map(String) : [];
    const text = errors.length ? errors.join("\n") : error && typeof o.result === "string" ? o.result : "";
    // Um turno que terminou bem não precisa de linha nenhuma: o texto do
    // agente já é o fim. Erro, sim — e interrupção é um erro sem texto.
    if (error || text) {
      touched.push(
        this.add({
          kind: "result",
          ts,
          error,
          text,
          cost: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
          ms: typeof o.duration_ms === "number" ? o.duration_ms : null,
        }),
      );
    }
    return touched;
  }

  private system(o: Line, ts: number): number[] {
    switch (o.subtype) {
      case "status":
        this.compacting = o.status === "compacting";
        return [];
      case "compact_boundary":
        this.compacting = false;
        return [this.add({ kind: "system", ts, text: "compacted", error: false })];
      default:
        return [];
    }
  }
}

function toBlock(raw: Line | undefined): Block | null {
  if (!raw || typeof raw !== "object") return null;
  switch (raw.type) {
    case "text":
      return { kind: "text", text: String(raw.text ?? "") };
    case "thinking":
      return { kind: "thinking", text: String(raw.thinking ?? "") };
    case "tool_use":
      return {
        kind: "tool",
        id: String(raw.id ?? ""),
        name: String(raw.name ?? ""),
        input: raw.input ?? {},
        json: "",
        result: null,
        error: false,
        done: false,
      };
    default:
      return null;
  }
}

/// O que uma ferramenta devolveu, como texto: vem como string, ou como lista
/// de blocos (texto e imagem).
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[imagem]" : ""))
    .filter(Boolean)
    .join("\n");
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/// Um resumo de uma linha do input de uma ferramenta — o que o card mostra
/// fechado. Mesma escolha do `activity` do back: o comando, o arquivo, o
/// padrão.
export function summary(_name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = ["command", "file_path", "pattern", "path", "url", "query", "skill", "description", "prompt"]
    .map((k) => i[k])
    .find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return pick ? pick.split("\n")[0] : "";
}
