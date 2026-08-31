import { parseContext, type Report } from "./context";

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
/// - `system` — o começo (`init`), a compactação, as tarefas em segundo
///   plano (`task_started`, `background_tasks_changed`, `task_notification`),
///   e ruído que se ignora.

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
  /// O resultado veio, mas a ferramenta continua rodando em segundo plano
  /// (`run_in_background`): o aviso de que acabou vem depois, como `system`.
  background: boolean;
};

/// Uma tarefa em segundo plano, do jeito que o Claude Code a lista.
export type Task = { id: string; description: string; toolUseId: string | null };
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
  | { kind: "system"; ts: number; text: string; error: boolean; what?: "compacted" | "summary"; tokens?: [number, number] }
  /// O `/context`: um relatório, não uma fala do agente.
  | { kind: "context"; ts: number; report: Report };

type Line = Record<string, any>;

/// Um comando de barra, como o agente o descreve: `/name`, o que faz, e a
/// dica do que vai depois (`<model>`), quando há.
export type Command = { name: string; description: string; hint: string };

export class Timeline {
  items: Item[] = [];
  /// Um turno em andamento: a fala foi, e o `result` ainda não veio.
  busy = false;
  compacting = false;
  /// O que roda em segundo plano agora, pela lista que o Claude Code manda.
  tasks = new Map<string, Task>();
  /// Os comandos de barra que o agente aceita: a resposta ao `initialize`
  /// que o back manda ao subir o processo (ver `chat.rs`), com nome e
  /// descrição. O `init` do stream, que só sai depois da primeira fala, diz
  /// quais deles são de terminal (`exit`, `color`) — esses saem da lista.
  commands: Command[] = [];
  private terminal = new Set<string>();
  /// A ferramenta de cada `tool_use_id`, para o resultado achar o bloco.
  private tools = new Map<string, { item: number; block: number }>();
  /// A skill que acabou de ser chamada: o corpo dela vem na linha seguinte, e
  /// vai para dentro do card em vez de virar uma fala.
  private skill: { id: string; item: number; block: number } | null = null;
  private lastTs = 0;
  /// Mensagens que deixaram de estar chegando por causa da linha de agora —
  /// mudaram, e a tela precisa saber, mesmo não sendo o item da linha.
  private settled: number[] = [];

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
    this.settled = [];
    const touched = this.reduce(o, ts);
    return this.settled.length ? [...new Set([...this.settled, ...touched])] : touched;
  }

  private reduce(o: Line, ts: number): number[] {
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
      case "control_response":
        return this.answered(o);
      case "prometheus":
        if (o.subtype === "stderr") return [this.add({ kind: "system", ts, text: String(o.text), error: true })];
        // O fim de um buffer: o back diz se há turno em andamento. Sem turno,
        // nada está chegando — por mais que as linhas pareçam dizer que sim.
        if (o.subtype === "state" && !o.busy) return this.idle();
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

  /// Nada está acontecendo: nenhuma mensagem chegando, nenhum pedido aberto,
  /// nenhum turno. Devolve o que mudou.
  private idle(): number[] {
    const touched: number[] = [];
    this.busy = false;
    this.compacting = false;
    this.items.forEach((it, i) => {
      if (it.kind === "assistant" && it.streaming) {
        it.streaming = false;
        touched.push(i);
      }
      if (it.kind === "ask" && !it.answered) {
        it.answered = true;
        touched.push(i);
      }
    });
    return touched;
  }

  /// Nenhuma mensagem do agente continua "chegando" antes daqui.
  private settle() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === "assistant" && it.streaming) {
        it.streaming = false;
        this.settled.push(i);
      } else if (it.kind === "assistant") break;
    }
  }

  private user(o: Line, ts: number): number[] {
    // O corpo de uma skill: o Claude Code o injeta como se fosse fala, logo
    // depois do resultado da ferramenta Skill. É o que a skill mandou fazer —
    // vai para dentro do card dela, não para a conversa.
    const skill = this.skillBody(o);
    if (skill) return skill;
    // `isMeta` é o que o Claude Code injeta por conta própria — saída de
    // comando, lembrete de sistema. Não foi ninguém que falou.
    if (o.isMeta) return [];
    const content = o.message?.content;
    if (typeof content === "string") {
      if (!content.trim()) return [];
      return this.spoken(content, ts, !!o.isCompactSummary);
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
        // "Launching skill: x" é só o aviso de que a skill entrou; o que ela
        // diz vem na linha seguinte.
        this.skill = tool.name === "Skill" && !tool.error ? { id: block.tool_use_id, ...at } : null;
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
    if (texts.length) touched.push(...this.spoken(texts.join("\n\n"), ts, !!o.isCompactSummary));
    return touched;
  }

  /// O texto que a skill trouxe, se esta linha for ele: vem logo depois do
  /// resultado da ferramenta Skill, marcado como injetado pelo próprio Claude
  /// Code (`isSynthetic` ao vivo, `isMeta` no transcript — que ainda diz de
  /// qual ferramenta veio). Vira o resultado do card, e some da conversa.
  private skillBody(o: Line): number[] | null {
    const at = this.skill;
    if (!at || (!o.isSynthetic && !o.isMeta)) return null;
    const from = typeof o.sourceToolUseID === "string" ? o.sourceToolUseID : null;
    if (from && from !== at.id) return null;
    const content = o.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? textOf(content) : "";
    if (!text.trim()) return null;
    this.skill = null;
    const item = this.items[at.item];
    if (item?.kind !== "assistant") return null;
    const tool = item.blocks[at.block];
    if (tool?.kind !== "tool") return null;
    tool.result = text;
    return [at.item];
  }

  /// Texto numa linha `user`. Nem tudo é fala: o Claude Code também escreve
  /// ali o eco de um comando (`/compact`), o resumo com que a conversa
  /// continua depois de compactar, e o aviso de tarefa que acabou — no
  /// transcript; ao vivo o aviso vem como `system`.
  private spoken(text: string, ts: number, summary: boolean): number[] {
    if (/^\s*<(command-name|local-command-stdout|local-command-caveat)>/.test(text)) return [];
    if (summary || text.startsWith("This session is being continued from a previous conversation")) {
      return [this.add({ kind: "system", ts, text, error: false, what: "summary" })];
    }
    const task = /^\s*<task-notification>/.test(text) ? /<summary>([\s\S]*?)<\/summary>/.exec(text) : null;
    if (task) return [this.add({ kind: "system", ts, text: task[1].trim(), error: false })];
    this.busy = true;
    return [this.add({ kind: "user", ts, text })];
  }

  /// A linha `assistant` inteira de um bloco. Cai em cima do rascunho que o
  /// streaming desenhou — o n-ésimo bloco finalizado é o de índice n — ou
  /// entra no fim, quando não houve rascunho (transcript, ou colega que abriu
  /// a conversa no meio).
  private assistant(o: Line, ts: number): number[] {
    // O agente já falou: o que a skill tinha a dizer, se era para vir, veio.
    this.skill = null;
    const msg = String(o.message?.id ?? o.uuid ?? "");
    const content = Array.isArray(o.message?.content) ? o.message.content : [];
    // Resposta sintética: o Claude Code respondendo a um comando (`/context`,
    // `/cost`), sem modelo. O `/context` tem desenho próprio.
    if (o.message?.model === "<synthetic>") {
      const text = content.find((c: Line) => c?.type === "text")?.text;
      const report = typeof text === "string" ? parseContext(text) : null;
      if (report) return [this.add({ kind: "context", ts, report })];
    }
    let at = this.findAssistant(msg);
    if (at === -1) at = this.add({ kind: "assistant", ts, msg, blocks: [], streaming: true, next: 0 });
    const item = this.items[at];
    if (item.kind !== "assistant") return [];
    this.busy = true;
    for (const raw of content) {
      const block = toBlock(raw);
      if (!block) continue;
      const index = item.next++;
      // O pensamento inteiro vem vazio na linha `assistant` (e no transcript):
      // o texto só existe nos deltas. O rascunho é o que se tem; fica.
      const draft = item.blocks[index];
      if (block.kind === "thinking" && !block.text && draft?.kind === "thinking") block.text = draft.text;
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

  /// A resposta do processo a um pedido do app. A que interessa é a do
  /// `initialize`: a lista de comandos de barra. As outras (permissão,
  /// interrupção) não têm nada para a tela.
  private answered(o: Line): number[] {
    const list: unknown = o.response?.response?.commands;
    if (!Array.isArray(list)) return [];
    this.commands = list
      .filter((c): c is Line => !!c && typeof c.name === "string" && !this.terminal.has(c.name))
      .map((c) => ({ name: c.name, description: String(c.description ?? ""), hint: String(c.argumentHint ?? "") }));
    return [];
  }

  private system(o: Line, ts: number): number[] {
    switch (o.subtype) {
      case "init": {
        const terminal: unknown[] = Array.isArray(o.terminal_slash_commands) ? o.terminal_slash_commands : [];
        this.terminal = new Set(terminal.filter((c): c is string => typeof c === "string"));
        this.commands = this.commands.filter((c) => !this.terminal.has(c.name));
        return [];
      }
      case "status":
        this.compacting = o.status === "compacting";
        if (o.compact_result === "failed") {
          return [this.add({ kind: "system", ts, text: String(o.compact_error ?? "compact failed"), error: true })];
        }
        return [];
      case "compact_boundary": {
        this.compacting = false;
        const m = o.compact_metadata ?? {};
        const tokens: [number, number] | undefined =
          typeof m.pre_tokens === "number" && typeof m.post_tokens === "number" ? [m.pre_tokens, m.post_tokens] : undefined;
        return [this.add({ kind: "system", ts, text: "compacted", error: false, what: "compacted", tokens })];
      }
      case "task_started": {
        const id = String(o.task_id ?? "");
        if (!id) return [];
        const toolUseId = typeof o.tool_use_id === "string" ? o.tool_use_id : null;
        this.tasks.set(id, { id, description: String(o.description ?? ""), toolUseId });
        return this.mark(toolUseId, true);
      }
      case "background_tasks_changed": {
        // A lista inteira, de novo: o que saiu dela acabou.
        const now = new Map<string, Task>();
        for (const raw of Array.isArray(o.tasks) ? o.tasks : []) {
          const id = String(raw?.task_id ?? "");
          if (!id) continue;
          now.set(id, this.tasks.get(id) ?? { id, description: String(raw.description ?? ""), toolUseId: null });
        }
        const touched: number[] = [];
        for (const [id, task] of this.tasks) if (!now.has(id)) touched.push(...this.mark(task.toolUseId, false));
        this.tasks = now;
        return touched;
      }
      case "task_notification": {
        const id = String(o.task_id ?? "");
        const task = this.tasks.get(id);
        this.tasks.delete(id);
        const toolUseId = typeof o.tool_use_id === "string" ? o.tool_use_id : (task?.toolUseId ?? null);
        const touched = this.mark(toolUseId, false);
        const text = String(o.summary ?? "").trim();
        if (text) touched.push(this.add({ kind: "system", ts, text, error: o.status !== "completed" }));
        return touched;
      }
      default:
        return [];
    }
  }

  /// A ferramenta de um `tool_use_id` (se está na tela) passa a rodar em
  /// segundo plano, ou deixa de rodar.
  private mark(toolUseId: string | null, background: boolean): number[] {
    const at = toolUseId ? this.tools.get(toolUseId) : undefined;
    if (!at) return [];
    const item = this.items[at.item];
    if (item.kind !== "assistant") return [];
    const tool = item.blocks[at.block];
    if (tool?.kind !== "tool" || tool.background === background) return [];
    tool.background = background;
    return [at.item];
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
        background: false,
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

/// Só o texto de uma lista de blocos.
function textOf(content: Line[]): string {
  return content
    .filter((b) => b?.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n\n");
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
export function summary(_name: string, input: unknown, json = ""): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = SUMMARY_KEYS.map((k) => i[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined;
  if (pick) return pick.split("\n")[0];
  // O input ainda está chegando: o JSON não fecha, mas o começo de uma string
  // já dá para ler — é o que o card mostra enquanto espera o resto.
  for (const k of SUMMARY_KEYS) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
    if (m?.[1]) return m[1].replace(/\\n[\s\S]*/, "").replace(/\\(.)/g, "$1");
  }
  return "";
}

const SUMMARY_KEYS = ["command", "file_path", "pattern", "path", "url", "query", "skill", "description", "prompt"];

/// Os arquivos que o agente leu ou escreveu nesta conversa, do último para o
/// primeiro e sem repetir. É o que faz o "@" da caixa oferecer primeiro o que
/// está em cima da mesa: quem escreve "@" no meio de um trabalho quase sempre
/// quer um arquivo que acabou de aparecer na conversa (ver `paths.ts`).
///
/// Só as ferramentas que apontam um arquivo — o `path` de um Grep é uma pasta
/// onde procurar, e o de um Bash não existe.
export function touched(items: Item[], most = 12): string[] {
  const out: string[] = [];
  for (let at = items.length - 1; at >= 0 && out.length < most; at--) {
    const item = items[at];
    if (item.kind !== "assistant") continue;
    for (let k = item.blocks.length - 1; k >= 0 && out.length < most; k--) {
      const block = item.blocks[k];
      if (block.kind !== "tool" || !FILE_TOOLS.has(block.name)) continue;
      const file = (block.input as Record<string, unknown> | null)?.["file_path"];
      if (typeof file === "string" && file && !out.includes(file)) out.push(file);
    }
  }
  return out;
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "MultiEdit"]);

/* ---------- a conversa em pedaços de tela ---------- */

/// Um bloco, pelo lugar dele: em que item, e em que posição.
export type BlockRef = { at: number; block: number };

/// Um pedaço da conversa na tela — que não é um item.
///
/// O agente trabalha em rajadas: pensa, chama uma ferramenta, pensa de novo,
/// chama outra. Cada rajada dessas é uma mensagem, e uma tarefa banal vira
/// vinte mensagens — desenhadas uma a uma, a fala que interessa se perde no
/// meio de quarenta cartões. Aqui o trabalho seguido vira um pedaço só
/// (`work`), e o que a pessoa lê fica de fora dele: a fala do agente (`say`),
/// e tudo que não é mensagem dele (`item` — a fala da pessoa, o card que
/// espera resposta, o fim do turno).
///
/// A `key` é o que a tela guarda de um quadro para o outro: os itens só
/// crescem no fim, então o começo de um pedaço nunca muda de lugar — o mesmo
/// pedaço é o mesmo nó, com a mesma seleção e o mesmo aberto/fechado.
export type Piece =
  | { kind: "item"; key: string; at: number }
  | { kind: "say"; key: string; at: number; block: number }
  | { kind: "work"; key: string; refs: BlockRef[] };

export function pieces(items: Item[]): Piece[] {
  const out: Piece[] = [];
  let work: Extract<Piece, { kind: "work" }> | null = null;
  items.forEach((item, at) => {
    if (item.kind !== "assistant") {
      work = null;
      out.push({ kind: "item", key: `i${at}`, at });
      return;
    }
    item.blocks.forEach((block, k) => {
      if (!block) return;
      if (block.kind === "text") {
        work = null;
        out.push({ kind: "say", key: `s${at}.${k}`, at, block: k });
        return;
      }
      if (!work) out.push((work = { kind: "work", key: `w${at}.${k}`, refs: [] }));
      work.refs.push({ at, block: k });
    });
  });
  return out;
}
