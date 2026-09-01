import { invoke } from "./ipc";
import { listen } from "@tauri-apps/api/event";
import { icon } from "./icons";
import { fromBack, t, tn } from "./i18n";
import { diffHtml, isDiff } from "./highlight";
import { kilo } from "./context";
import {
  capError,
  capLines,
  contextPanel,
  countTools,
  errorPeek,
  inputView,
  peek,
  tallyText,
  took,
  toolIcon,
  toolLabel,
  wantsCard,
} from "./chat-presentation";
import { effortStep, modelLabel } from "./launcher";
import { md } from "./markdown";
import * as commands from "./commands";
import * as notes from "./notes";
import * as paths from "./paths";
import * as team from "./team";
import { pieces, summary, Timeline, touched, type Ask, type Block, type Command, type Item, type Piece, type ToolBlock } from "./timeline";
import type { Status } from "./types";
import { h, template } from "./util";

/// A conversa na tela: a timeline desenhada, e a caixa de escrever embaixo.
///
/// Não é um terminal. O que chega é uma linha de JSON por vez (`chat.rs`), o
/// `Timeline` diz o que ela mudou, e só isso é redesenhado. O que sai é uma
/// fala, uma resposta a um card (permissão, pergunta, plano) ou uma
/// interrupção — pelo mesmo cano, na mesma forma.
///
/// A conversa de um colega é a mesma tela: as linhas vêm do relay em vez do
/// back, e o que se escreve vai para o Mac dele em vez do processo daqui.
///
/// As notas do time moram aqui dentro, na hora em que foram escritas — entre
/// a fala e a resposta a que se referem.

/// O que a tela precisa saber da aba aberta, e que não está nas linhas.
export type Info = {
  /// O id do workspace na tela (o de um colega vem prefixado).
  workspace: string | null;
  status: Status | null;
  /// A fala que ainda não foi — espera o setup do worktree terminar.
  pending: string | null;
  /// A conversa é de um colega: o nome dele, e se ele está aí.
  remote: { name: string; online: boolean } | null;
  /// Este workspace participa do time — e, portanto, aceita notas. Ter um time
  /// configurado não basta: um workspace local que nunca foi compartilhado
  /// não existe no relay.
  team: boolean;
  /// Com quem se está falando: o modelo e o esforço desta conversa — o que a
  /// aba escolheu ao nascer, ou o do workspace. Vazio é o padrão do CLI, e aí
  /// a caixa não diz nada.
  model: string;
  effort: string;
};

export type Ctx = {
  say: (text: string, isError?: boolean) => void;
  info: () => Info;
};

export class ChatView {
  private feed!: HTMLElement;
  private box!: HTMLElement;
  private area!: HTMLTextAreaElement;
  private ctx!: Ctx;
  private key: string | null = null;
  private remote = false;
  private tl = new Timeline();
  /// Os pedaços que estão na tela, e o nó de cada um — na mesma ordem.
  private shown: Piece[] = [];
  private drawn: HTMLElement[] = [];
  /// Os cartões de trabalho que alguém abriu: continuam abertos quando o
  /// pedaço é redesenhado, e depois de trocar de aba e voltar.
  private opened = new Set<string>();
  /// O que ainda não fechou uma linha, na conversa de um colega: os bytes
  /// chegam em pedaços, e um pedaço pode cortar um JSON no meio.
  private partial = "";
  private decoder = new TextDecoder("utf-8");
  private mode: "agent" | "note" = "agent";
  /// Em que lado do toggle cada workspace estava. Escolher "nota" é sobre
  /// aquele workspace — trocar de aba e voltar encontra o que estava escolhido
  /// ali, com o rascunho junto, e não o do último workspace visitado.
  private modes = new Map<string, "agent" | "note">();
  /// A fala pela metade de cada aba. O que se escreve é daquela conversa:
  /// trocar de aba no meio de uma frase e voltar encontra a frase onde ela
  /// ficou, e a aba de destino encontra a dela — não a de onde se veio.
  private says = new Map<string, string>();
  private feedback: string | null = null;
  /// Itens que mudaram desde o último quadro. O stream manda uma linha por
  /// token; redesenhar a cada uma trava a tela — um quadro por vez basta.
  private dirty = new Set<number>();
  private raf = 0;
  /// A nota que acabou de sair daqui, esperando voltar do relay: quantas o
  /// workspace tinha antes dela. Quando aparecer uma a mais, a rolagem vai
  /// até ela — mesmo que quem escreveu tenha subido para citar um trecho.
  private posted: { ws: string; count: number } | null = null;
  private working = template("div", "working", "<i></i><i></i><i></i><span class=\"wlabel\"></span>");
  /// A fala guardada, esperando o setup: fica na tela como se tivesse ido,
  /// com o aviso de que ainda não foi.
  private waiting = template("div", "turn user wait", `<div class="bubble"></div><div class="working"><i></i><i></i><i></i><span class="wlabel"></span></div>`);

  open(host: HTMLElement, ctx: Ctx) {
    this.ctx = ctx;
    this.feed = h("div", "feed");
    this.box = h("div", "composer");
    host.append(this.feed, this.box);
    this.buildComposer();

    listen<[string, string, number]>("chat", ({ payload: [session, line] }) => {
      if (session !== this.key || this.remote) return;
      this.absorb(line);
    });
    // Nota nova — de um colega, ou a própria voltando do relay — entra no
    // fim da conversa. Segue a mesma regra do stream: a rolagem acompanha se
    // já estava no fim; e a nota que acabou de sair daqui é vista sempre.
    team.onChange(() => {
      const stick = this.arrived() || this.stuck();
      if (this.key) this.paintNotes();
      this.paintComposer();
      if (stick) this.feed.scrollTop = this.feed.scrollHeight;
    });
    document.addEventListener("selectionchange", () => this.paintQuoteButton());
  }

  /* ---------- ligar e desligar ---------- */

  /// Uma conversa daqui: a rolagem que o back guardou, e daí em diante as
  /// linhas ao vivo.
  async attach(key: string) {
    this.stash();
    this.key = key;
    this.remote = false;
    this.reset();
    this.restoreMode();
    const text = await invoke<string>("chat_buffer", { session: key });
    if (this.key !== key) return;
    this.tl.load(text);
    this.renderAll();
  }

  /// A conversa de um colega: as linhas que vieram dele. Daqui em diante os
  /// bytes chegam por `remoteWrite`.
  attachRemote(key: string, bytes: Uint8Array) {
    this.stash();
    this.key = key;
    this.remote = true;
    this.reset();
    this.restoreMode();
    this.tl.load(new TextDecoder("utf-8").decode(bytes));
    this.renderAll();
  }

  /// Saída ao vivo de uma conversa remota. O que não é da chave na tela é
  /// descartado — o link guarda o espelho de cada aba, e é dele que a tela
  /// renasce ao trocar.
  remoteWrite(key: string, bytes: Uint8Array) {
    if (key !== this.key || !this.remote) return;
    this.partial += this.decoder.decode(bytes, { stream: true });
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.absorb(line);
  }

  detach() {
    this.stash();
    this.key = null;
    this.remote = false;
    this.reset();
    this.restoreMode();
    this.paintComposer();
  }

  private reset() {
    this.tl = new Timeline();
    this.shown = [];
    this.drawn = [];
    this.partial = "";
    this.decoder = new TextDecoder("utf-8");
    this.feedback = null;
    this.posted = null;
    this.dirty.clear();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.feed.replaceChildren();
  }

  current() {
    return this.key;
  }

  focus() {
    this.area.focus();
  }

  /// O estado da aba mudou fora daqui (o quadro redesenhou): a caixa e a fala
  /// que espera acompanham.
  refresh() {
    const stick = this.stuck();
    this.paintWorking();
    this.paintComposer();
    if (stick) this.feed.scrollTop = this.feed.scrollHeight;
  }

  /// O texto selecionado dentro da conversa — é o que uma nota cita.
  selection(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode || !this.feed.contains(sel.anchorNode)) return "";
    return sel.toString();
  }

  /// Caminhos soltos em cima da conversa entram na caixa, como o Terminal faz.
  insert(text: string) {
    const a = this.area;
    const cut = a.selectionStart;
    a.value = `${a.value.slice(0, cut)}${text}${a.value.slice(cut)}`;
    a.selectionStart = a.selectionEnd = cut + text.length;
    this.grow();
    a.focus();
  }

  /* ---------- as linhas ---------- */

  private absorb(line: string) {
    for (const i of this.tl.push(line)) this.dirty.add(i);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  /// Um quadro: o que mudou desde o último, de uma vez. A rolagem só segue se
  /// já estava no fim — quem subiu para ler não é puxado de volta.
  private flush() {
    this.raf = 0;
    const stick = this.stuck();
    const changed = this.dirty.size > 0;
    this.sync(this.dirty);
    this.dirty.clear();
    if (changed) this.paintNotes();
    this.paintWorking();
    this.paintComposer();
    if (stick) this.feed.scrollTop = this.feed.scrollHeight;
  }

  /// Os três pontos no fim: o agente está trabalhando e nada está chegando
  /// letra a letra agora (entre uma ferramenta e a próxima fala, por exemplo).
  /// Com uma legenda quando há o que dizer: compactando, ou o que continua
  /// rodando em segundo plano — que roda mesmo com o turno terminado.
  private paintWorking() {
    this.paintWaiting();
    const last = this.tl.items[this.tl.items.length - 1];
    const typing = last?.kind === "assistant" && last.streaming && last.blocks[last.blocks.length - 1]?.kind === "text";
    const tasks = [...this.tl.tasks.values()];
    const show = this.tl.compacting || tasks.length > 0 || (this.tl.busy && !typing && !this.tl.pending.length);
    if (!show) {
      this.working.remove();
      return;
    }
    const label = this.tl.compacting
      ? t("chat.compacting")
      : tasks.length
        ? `${tn(tasks.length, "chat.bg")}: ${tasks.map((k) => k.description || "…").join(" · ")}`
        : "";
    this.working.querySelector(".wlabel")!.textContent = label;
    this.feed.append(this.working);
  }

  /// A primeira fala, quando ainda não foi: o setup do worktree está rodando
  /// e ela vai quando ele acabar. Sem isto a tela fica vazia esperando, e
  /// parece que a fala se perdeu.
  private paintWaiting() {
    const info = this.ctx.info();
    const text = !this.remote && this.key ? info.pending : null;
    if (!text) {
      this.waiting.remove();
      return;
    }
    this.waiting.querySelector(".bubble")!.textContent = text;
    this.waiting.querySelector(".wlabel")!.textContent = t("chat.waiting");
    this.feed.querySelector(".nohint")?.remove();
    this.feed.append(this.waiting);
  }

  private stuck() {
    return this.feed.scrollTop + this.feed.clientHeight >= this.feed.scrollHeight - 48;
  }

  /// A nota que saiu daqui chegou: o workspace tem mais notas do que tinha
  /// quando ela foi enviada. Vale uma vez, e só nesta aba.
  private arrived(): boolean {
    const posted = this.posted;
    if (!posted) return false;
    if (this.ctx.info().workspace !== posted.ws) return false;
    if (team.notesOf(posted.ws).length <= posted.count) return false;
    this.posted = null;
    return true;
  }

  private renderAll() {
    this.shown = [];
    this.drawn = [];
    this.feed.replaceChildren();
    if (!this.tl.items.length) this.feed.append(h("div", "nohint", t("chat.empty")));
    this.sync(null);
    this.paintNotes();
    this.paintWorking();
    this.paintComposer();
    this.feed.scrollTop = this.feed.scrollHeight;
  }

  /// A tela alcança a timeline: os pedaços que tocam um item que mudou são
  /// redesenhados, os que nasceram entram no fim, e o resto fica exatamente o
  /// nó que já estava lá — com a seleção de quem lê e o que estava aberto.
  /// `dirty` nulo é "mudou tudo".
  private sync(dirty: Set<number> | null) {
    const next = pieces(this.tl.items);
    // Até onde continua sendo a mesma conversa. Como os itens só crescem no
    // fim, isto quase sempre é tudo o que já está na tela.
    let same = 0;
    while (same < next.length && same < this.shown.length && next[same].key === this.shown[same].key) same++;
    for (const gone of this.drawn.splice(same)) gone.remove();
    for (let i = 0; i < same; i++) if (this.touches(next[i], dirty)) this.draw(i, next[i]);
    for (let i = same; i < next.length; i++) this.draw(i, next[i]);
    this.shown = next;
  }

  private touches(piece: Piece, dirty: Set<number> | null): boolean {
    if (!dirty) return true;
    return piece.kind === "work" ? piece.refs.some((r) => dirty.has(r.at)) : dirty.has(piece.at);
  }

  private draw(i: number, piece: Piece) {
    const old = this.drawn[i];
    // Chegando letra a letra: mexe no nó que está lá, em vez de trocá-lo.
    // Trocar o nó a cada quadro é o que dava o tremor — e apagava a seleção
    // de quem estava lendo.
    if (old && this.repaint(old, piece)) return;
    const node = this.node(piece);
    node.dataset.key = piece.key;
    if (old) {
      // Card de ferramenta aberto continua aberto depois do redesenho.
      for (const open of old.querySelectorAll<HTMLElement>(".tool.open")) {
        const id = open.dataset.tool;
        node.querySelector<HTMLElement>(`.tool[data-tool="${CSS.escape(id ?? "")}"]`)?.classList.add("open");
      }
      old.replaceWith(node);
    } else {
      this.feed.querySelector(".nohint")?.remove();
      this.feed.append(node);
    }
    this.drawn[i] = node;
  }

  private node(piece: Piece): HTMLElement {
    if (piece.kind === "item") {
      const item = this.tl.items[piece.at];
      // Mensagem do agente vira `say` e `work`, nunca um pedaço `item`.
      return item.kind === "assistant" ? h("div", "turn bot") : this.render(item, piece.at);
    }
    if (piece.kind === "say") {
      const el = h("div", "turn bot");
      const at = this.blockAt(piece);
      if (at) el.append(this.block(at.block, at.live));
      this.paintMeta(el, piece);
      return el;
    }
    return this.workCard(piece);
  }

  /// O rodapé de uma resposta: quanto o turno levou, e o botão que copia o que
  /// o agente escreveu. Só na última fala de um turno que acabou — no meio da
  /// rajada não há tempo para dizer, e a linha viraria ruído a cada ferramenta.
  private paintMeta(el: HTMLElement, piece: Extract<Piece, { kind: "say" }>) {
    const ms = this.turnMs(piece);
    const old = el.querySelector(".meta");
    if (ms === null) return void old?.remove();
    // Menos de um décimo não é duração — é a linha do transcript, que não
    // guarda quando o turno começou. Aí fica só o copiar.
    const label = ms < 100 ? "" : took(ms);
    if (old) return void (old.querySelector(".took")!.textContent = label);
    const meta = template("div", "meta", `<span class="took"></span><button class="ico sm cp"></button>`);
    meta.querySelector(".took")!.textContent = label;
    const cp = meta.querySelector<HTMLElement>(".cp")!;
    cp.innerHTML = icon("copy", 13);
    cp.title = t("chat.copy");
    cp.addEventListener("click", () => {
      const at = this.blockAt(piece);
      if (at?.block.kind !== "text") return;
      void navigator.clipboard.writeText(at.block.text);
      cp.innerHTML = icon("check", 13);
      setTimeout(() => (cp.innerHTML = icon("copy", 13)), 1200);
    });
    el.append(meta);
  }

  /// Quanto durou o turno que esta fala fecha, ou `null` se ela não o fecha.
  /// Fecha quem é o último bloco de uma mensagem que parou de chegar e não tem
  /// outra mensagem do agente depois — isto é, o agente devolveu a vez.
  private turnMs(piece: Extract<Piece, { kind: "say" }>): number | null {
    const item = this.tl.items[piece.at];
    if (item?.kind !== "assistant" || item.streaming) return null;
    if (piece.block !== item.blocks.length - 1) return null;
    for (let i = piece.at + 1; i < this.tl.items.length; i++) {
      const next = this.tl.items[i];
      if (next.kind === "assistant") return null;
      if (next.kind === "user") break;
    }
    for (let i = piece.at - 1; i >= 0; i--) {
      const before = this.tl.items[i];
      if (before.kind === "user") return Math.max(0, item.ts - before.ts);
    }
    return null;
  }

  /// O bloco de um pedaço, e se ele ainda está chegando: o último de uma
  /// mensagem em streaming é o que está sendo escrito agora.
  private blockAt(ref: { at: number; block: number }): { block: Block; live: boolean } | null {
    const item = this.tl.items[ref.at];
    if (item?.kind !== "assistant") return null;
    const block = item.blocks[ref.block];
    if (!block) return null;
    return { block, live: item.streaming && ref.block === item.blocks.length - 1 };
  }

  /// O que não é mensagem do agente: a fala da pessoa, o card que espera
  /// resposta, o fim do turno, um aviso do sistema. Mensagem do agente vira
  /// pedaço (`say`, `work`) e não passa por aqui.
  private render(item: Exclude<Item, { kind: "assistant" }>, i: number): HTMLElement {
    switch (item.kind) {
      case "user": {
        const el = template("div", "turn user", `<div class="bubble"></div>`);
        (el.firstElementChild as HTMLElement).textContent = item.text;
        return el;
      }
      case "ask":
        return this.askCard(item, i);
      case "result": {
        return this.errorCard(item.text || t("chat.result.error"));
      }
      case "context":
        return contextPanel(item.report);
      case "system": {
        if (item.what === "summary") {
          // O resumo com que o agente continua depois de compactar: é dele,
          // não da pessoa — e é longo. Fica dobrado, como o pensamento.
          const el = template("details", "think summary", `<summary></summary><div class="md"></div>`);
          el.querySelector("summary")!.textContent = t("chat.summary");
          (el.lastElementChild as HTMLElement).innerHTML = md(item.text);
          return el;
        }
        if (item.error) return this.errorCard(item.text);
        const el = h("div", "sys");
        el.textContent =
          item.what === "compacted"
            ? item.tokens
              ? t("chat.compacted.tokens", { pre: kilo(item.tokens[0]), post: kilo(item.tokens[1]) })
              : t("chat.compacted")
            : item.text;
        return el;
      }
    }
  }

  /// Erro técnico não vira um paredão vermelho no meio da conversa. A linha
  /// explica o que houve; a saída completa continua disponível para diagnóstico.
  private errorCard(text: string): HTMLElement {
    const value = text.trim() || t("chat.result.error");
    if (!value.includes("\n") && value.length <= 180) {
      const el = h("div", "sys err");
      el.textContent = value;
      return el;
    }
    const el = template(
      "details",
      "syserr",
      `<summary><span class="eic">${icon("x", 12)}</span><b></b><span class="prev"></span></summary><pre></pre>`,
    );
    el.querySelector("b")!.textContent = t("chat.error.title");
    el.querySelector(".prev")!.textContent = errorPeek(value);
    el.querySelector("pre")!.textContent = capError(value);
    return el;
  }

  /// Um pedaço que já está na tela mudou. Bloco por bloco: o que é do mesmo
  /// tipo é atualizado no lugar, o que é novo entra no fim. `false` é "não
  /// deu, troca o nó inteiro".
  private repaint(el: HTMLElement, piece: Piece): boolean {
    if (el.dataset.key !== piece.key) return false;
    // Fala da pessoa, card, aviso: refazer é barato, e o card guarda o que
    // já foi escolhido nele.
    if (piece.kind === "item") return false;
    if (piece.kind === "say") {
      const at = this.blockAt(piece);
      const node = el.firstElementChild as HTMLElement | null;
      if (!at || at.block.kind !== "text" || node?.dataset.kind !== "text") return false;
      node.innerHTML = md(at.block.text);
      node.classList.toggle("typing", at.live);
      // O turno acabou enquanto esta fala estava na tela: é agora que a
      // duração e o copiar aparecem embaixo dela.
      this.paintMeta(el, piece);
      return true;
    }
    // Trabalho que era só pensamento e ganhou a primeira ferramenta deixa de
    // ser um pensamento solto e passa a ser cartão: aí o nó é outro.
    const parts = piece.refs.map((r) => this.blockAt(r)).filter((p) => !!p);
    const card = el.classList.contains("work");
    if (wantsCard(parts) !== card) return false;
    const body = card ? el.querySelector<HTMLElement>(".wbody") : el;
    if (!body) return false;
    // O cartão fechado é o resumo do que está dentro: mudou um bloco, mudou
    // o cabeçalho.
    if (card) this.paintWorkHead(el, piece);
    return this.patch(body, parts);
  }

  /// Os blocos de um pedaço, dentro do nó que já está na tela.
  private patch(el: HTMLElement, blocks: ({ block: Block; live: boolean } | null)[]): boolean {
    for (let k = 0; k < blocks.length; k++) {
      const at = blocks[k];
      if (!at) continue;
      const node = el.children[k] as HTMLElement | undefined;
      if (!node) {
        el.append(this.block(at.block, at.live));
        continue;
      }
      // Um bloco mudou de tipo: não acontece no stream, mas se acontecer o
      // nó inteiro é refeito, em vez de a tela mentir.
      if (node.dataset.kind !== at.block.kind) return false;
      if (at.block.kind === "text") {
        node.innerHTML = md(at.block.text);
        node.classList.toggle("typing", at.live);
      } else if (at.block.kind === "thinking") {
        node.querySelector("b")!.textContent = t(at.live ? "chat.thinking" : "chat.thought");
        node.querySelector(".prev")!.textContent = peek(at.block.text);
        (node.lastElementChild as HTMLElement).textContent = at.block.text;
        node.classList.toggle("live", at.live);
        node.classList.toggle("bare", !at.block.text);
      } else {
        // Ferramenta: o card muda de estado (rodou, deu erro) — refeito, mas
        // aberto continua aberto.
        const fresh = this.block(at.block, at.live);
        if (node.classList.contains("open")) fresh.classList.add("open");
        node.replaceWith(fresh);
      }
    }
    return true;
  }

  /// O trabalho do agente num cartão só. Fechado, é a linha do que ele está
  /// fazendo agora — ou quanto fez, quando acabou. Aberto, é o passo a passo
  /// de sempre. Sem isto, uma tarefa banal é quarenta cartões empilhados e a
  /// fala que interessa se perde no meio deles.
  private workCard(piece: Extract<Piece, { kind: "work" }>): HTMLElement {
    const parts = piece.refs.map((r) => this.blockAt(r)).filter((p) => !!p);
    if (!wantsCard(parts)) {
      const el = h("div", "turn bot");
      for (const p of parts) el.append(this.block(p.block, p.live));
      return el;
    }
    const el = h("div", "work" + (this.opened.has(piece.key) ? " open" : ""));
    const head = template("button", "whead", `<span class="wic"></span><b></b><span class="sum"></span><span class="st"></span>`);
    head.addEventListener("click", () => {
      const open = el.classList.toggle("open");
      if (open) this.opened.add(piece.key);
      else this.opened.delete(piece.key);
    });
    const body = h("div", "wbody");
    for (const p of parts) body.append(this.block(p.block, p.live));
    el.append(head, body);
    this.paintWorkHead(el, piece);
    return el;
  }

  /// O cabeçalho do cartão. Enquanto anda, é o passo de agora — senão a
  /// conversa vira uma caixa fechada e ninguém vê o agente trabalhando.
  /// Parado, é quantos passos foram, e em quê.
  private paintWorkHead(el: HTMLElement, piece: Extract<Piece, { kind: "work" }>) {
    const parts = piece.refs.map((r) => this.blockAt(r)).filter((p) => !!p);
    const tools = parts.map((p) => p.block).filter((b): b is ToolBlock => b.kind === "tool");
    const last = parts[parts.length - 1];
    const running = parts.some((p) => p.live) || tools.some((b) => !b.done || b.background);
    const bad = tools.some((b) => b.error);
    el.classList.toggle("going", running);
    el.classList.toggle("bad", !running && bad);
    el.classList.toggle("ok", !running && !bad);

    const now = running && last.block.kind === "tool" ? last.block : null;
    const tally = countTools(tools);
    const name = now ? now.name : tally[0]?.[0] ?? "";
    const q = (sel: string) => el.querySelector(sel)!;
    q(".wic").innerHTML = icon(running && !now ? "sparkles" : toolIcon(name), 14);
    q("b").textContent = now ? toolLabel(now.name) : running ? t("chat.thinking") : tn(tools.length, "chat.work");
    q(".sum").textContent = now ? summary(now.name, now.input, now.json) : running ? "" : tallyText(tally);
    q(".st").innerHTML = running ? `<span class="spin"></span>` : icon(bad ? "x" : "check", 12);
  }

  /// `live` é o bloco que ainda está chegando: o último de uma mensagem em
  /// streaming. É o que separa "Pensando…" de "Pensou".
  private block(block: Block, live: boolean): HTMLElement {
    if (block.kind === "text") {
      const el = h("div", "md" + (live ? " typing" : ""));
      el.dataset.kind = "text";
      el.innerHTML = md(block.text);
      return el;
    }
    if (block.kind === "thinking") {
      // Sem texto (histórico do transcript, que não guarda o pensamento) não
      // há o que abrir: fica o rótulo, sem seta.
      const el = template(
        "details",
        "think" + (live ? " live" : "") + (block.text ? "" : " bare"),
        `<summary><span class="tic">${icon("brain", 14)}</span><b></b><span class="prev"></span></summary><div></div>`,
      );
      el.dataset.kind = "thinking";
      el.querySelector("b")!.textContent = t(live ? "chat.thinking" : "chat.thought");
      el.querySelector(".prev")!.textContent = peek(block.text);
      (el.lastElementChild as HTMLElement).textContent = block.text;
      return el;
    }
    // Ferramenta: uma linha fechada, e o que entrou e saiu quando aberta.
    const running = !block.done || block.background;
    const el = h("div", "tool" + (running ? " run" : block.error ? " bad" : " ok"));
    el.dataset.kind = "tool";
    el.dataset.tool = block.id;
    const head = template("button", "thead", `<span class="tic">${icon(toolIcon(block.name), 14)}</span><b></b><span class="sum"></span><span class="bgtag"></span><span class="st"></span>`);
    head.querySelector("b")!.textContent = toolLabel(block.name);
    head.querySelector(".sum")!.textContent = block.name === "ExitPlanMode" ? "" : summary(block.name, block.input, block.json);
    head.querySelector(".bgtag")!.textContent = block.background ? t("chat.bg.tag") : "";
    head.querySelector(".st")!.innerHTML = running ? `<span class="spin"></span>` : icon(block.error ? "x" : "check", 12);
    head.addEventListener("click", () => el.classList.toggle("open"));
    el.append(head);
    const body = h("div", "tbody");
    if (block.name === "ExitPlanMode") {
      // O plano é para ler, não para abrir: fica na tela, em markdown.
      el.classList.add("open", "plan");
      const plan = h("div", "md");
      plan.innerHTML = md(String((block.input as { plan?: string })?.plan ?? ""));
      body.append(plan);
    } else if (block.error) {
      const failed = template("div", "tfail", `<span class="tic">${icon("x", 12)}</span><span></span>`);
      failed.lastElementChild!.textContent = t("chat.tool.failed");
      body.append(failed);

      const technical = h("div", "ttech");
      const input = inputView(block.name, block.input);
      if (input.childElementCount) technical.append(input);
      if (block.result !== null) {
        const out = h("pre", "tout");
        out.textContent = capError(block.result);
        technical.append(out);
      }
      if (technical.childElementCount) {
        const details = template("details", "ttechnical", `<summary></summary>`);
        details.querySelector("summary")!.textContent = t("chat.tool.details");
        details.append(technical);
        body.append(details);
      }
    } else if (block.name === "Skill" && block.result) {
      // A skill é uma instrução escrita para o agente: dentro do card, fechada,
      // e em markdown para quem abrir conseguir ler.
      const what = h("div", "md");
      what.innerHTML = md(capLines(block.result));
      body.append(what);
    } else {
      body.append(inputView(block.name, block.input));
      if (block.result !== null) {
        const out = h("pre", "tout");
        // Um diff que a ferramenta devolveu (o `git diff` no Bash) se lê
        // colorido, como o do Edit.
        if (isDiff(block.result)) {
          out.classList.add("tdiff");
          out.innerHTML = diffHtml(capLines(block.result));
        } else out.textContent = capLines(block.result);
        body.append(out);
      }
    }
    el.append(body);
    return el;
  }

  /* ---------- cards que esperam resposta ---------- */

  private askCard(ask: Ask, i: number): HTMLElement {
    if (ask.answered) {
      const el = template("div", "sys done", `${icon("check", 12)}<span></span>`);
      el.querySelector("span")!.textContent = t("chat.answered", { what: toolLabel(ask.tool) });
      return el;
    }
    const el = h("div", "ask");
    if (ask.tool === "ExitPlanMode") return this.planCard(el, ask);
    if (ask.tool === "AskUserQuestion") return this.questionCard(el, ask);
    return this.permCard(el, ask, i);
  }

  private planCard(el: HTMLElement, ask: Ask): HTMLElement {
    el.classList.add("plan");
    el.append(h("h4", "", t("chat.plan.title")));
    const row = h("div", "row");
    const go = h("button", "pri md", t("chat.plan.go"));
    go.title = t("chat.plan.go.title");
    go.addEventListener("click", () => {
      // O "sim" solta o agente: vira bypass antes de responder, senão a
      // primeira ferramenta do plano já pergunta de novo.
      this.control({
        type: "control_request",
        request_id: crypto.randomUUID(),
        request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
      });
      this.respond(ask, { behavior: "allow", updatedInput: ask.input });
    });
    const asking = h("button", "outline md", t("chat.plan.ask"));
    asking.title = t("chat.plan.ask.title");
    asking.addEventListener("click", () => this.respond(ask, { behavior: "allow", updatedInput: ask.input }));
    const no = h("button", "ghost md", t("chat.plan.no"));
    row.append(go, asking, no);
    el.append(row);
    // Pedir mudanças abre o campo: o que você escrever volta ao agente como a
    // recusa — é assim que o plano muda.
    const fb = template("div", "fb", `<textarea rows="3"></textarea><div class="row"><span class="spacer"></span><button class="pri md"></button></div>`);
    const area = fb.querySelector("textarea")!;
    area.placeholder = t("chat.plan.feedback");
    fb.querySelector("button")!.textContent = t("chat.plan.send");
    fb.hidden = this.feedback !== ask.id;
    no.addEventListener("click", () => {
      this.feedback = ask.id;
      fb.hidden = false;
      area.focus();
    });
    const send = () => {
      const text = area.value.trim();
      if (!text) return;
      this.feedback = null;
      this.respond(ask, { behavior: "deny", message: text });
    };
    fb.querySelector("button")!.addEventListener("click", send);
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    el.append(fb);
    return el;
  }

  /// Uma aba por pergunta, como na TUI: escolher já leva à próxima que falta,
  /// e responder só quando todas estiverem — o agente recebe tudo de uma vez.
  private questionCard(el: HTMLElement, ask: Ask): HTMLElement {
    el.classList.add("question");
    type Q = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };
    const questions = (ask.input.questions as Q[]) ?? [];
    const answers: Record<string, string[]> = {};
    const other: Record<string, string> = {};
    let active = 0;
    const has = (q: Q) => (answers[q.question]?.length ?? 0) > 0 || !!other[q.question]?.trim();
    // A próxima que falta, depois desta; senão a primeira que falta; senão
    // fica — está tudo respondido, e o botão é o que sobra.
    const next = () => {
      const after = questions.findIndex((q, i) => i > active && !has(q));
      const any = questions.findIndex((q) => !has(q));
      active = after !== -1 ? after : any !== -1 ? any : active;
    };
    const tabs = h("div", "qtabs");
    const body = h("div", "qbody");
    const row = h("div", "row");
    const go = h("button", "pri md", t("chat.ask.go")) as HTMLButtonElement;
    go.addEventListener("click", () => {
      const out: Record<string, string> = {};
      for (const q of questions) {
        const typed = other[q.question]?.trim();
        const picked = answers[q.question] ?? [];
        out[q.question] = [...picked, ...(typed ? [typed] : [])].join(", ");
      }
      this.respond(ask, { behavior: "allow", updatedInput: { ...ask.input, answers: out } });
    });
    row.append(h("span", "spacer"), go);

    const paint = () => {
      tabs.replaceChildren(
        ...questions.map((q, i) => {
          const b = template("button", "qtab" + (i === active ? " on" : "") + (has(q) ? " done" : ""), `<span></span>${icon("check", 11)}`);
          b.querySelector("span")!.textContent = q.header || t("chat.ask.n", { n: i + 1 });
          b.addEventListener("click", () => {
            active = i;
            paint();
          });
          return b;
        }),
      );
      tabs.hidden = questions.length < 2;
      const q = questions[active];
      body.replaceChildren();
      if (!q) return;
      body.append(h("p", "", q.question));
      const opts = h("div", "opts");
      for (const o of q.options ?? []) {
        const on = (answers[q.question] ?? []).includes(o.label);
        const b = template("button", "opt" + (on ? " on" : ""), `<b></b><span></span>`);
        b.querySelector("b")!.textContent = o.label;
        b.querySelector("span")!.textContent = o.description ?? "";
        b.addEventListener("click", () => {
          const list = answers[q.question] ?? [];
          if (q.multiSelect) {
            answers[q.question] = on ? list.filter((x) => x !== o.label) : [...list, o.label];
          } else {
            answers[q.question] = [o.label];
            next();
          }
          paint();
        });
        opts.append(b);
      }
      body.append(opts);
      const free = document.createElement("input");
      free.className = "field";
      free.placeholder = t("chat.ask.other");
      free.value = other[q.question] ?? "";
      free.addEventListener("input", () => {
        other[q.question] = free.value;
        paintGo();
        paintTabs();
      });
      free.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && free.value.trim()) {
          e.preventDefault();
          if (questions.every(has)) go.click();
          else {
            next();
            paint();
          }
        }
      });
      body.append(free);
      paintGo();
    };
    const paintGo = () => void (go.disabled = !questions.every(has));
    const paintTabs = () => {
      for (const [i, b] of [...tabs.children].entries()) b.classList.toggle("done", has(questions[i]));
    };
    el.append(tabs, body, row);
    paint();
    return el;
  }

  private permCard(el: HTMLElement, ask: Ask, _i: number): HTMLElement {
    el.append(h("h4", "", t("chat.perm.title", { tool: toolLabel(ask.tool) })));
    el.append(inputView(ask.tool, ask.input));
    const row = h("div", "row");
    const yes = h("button", "pri md", t("chat.perm.yes"));
    yes.addEventListener("click", () => this.respond(ask, { behavior: "allow", updatedInput: ask.input }));
    const always = h("button", "outline md", t("chat.perm.always"));
    always.addEventListener("click", () => {
      this.control({
        type: "control_request",
        request_id: crypto.randomUUID(),
        request: { subtype: "set_permission_mode", mode: "bypassPermissions" },
      });
      this.respond(ask, { behavior: "allow", updatedInput: ask.input });
    });
    const no = h("button", "ghost md", t("chat.perm.no"));
    no.addEventListener("click", () => this.respond(ask, { behavior: "deny", message: t("chat.perm.denied") }));
    row.append(yes, always, no);
    el.append(row);
    return el;
  }

  private respond(ask: Ask, response: unknown) {
    this.control({ type: "control_response", response: { subtype: "success", request_id: ask.id, response } });
    this.sync(new Set(this.tl.answer(ask.id)));
    this.paintComposer();
  }

  /// Uma linha de controle para o processo — daqui, ou pelo relay até o Mac
  /// do dono, que a repassa (ver `team.ts`).
  private control(frame: unknown) {
    if (!this.key) return;
    if (this.remote) team.write(JSON.stringify(frame));
    else invoke("chat_control", { session: this.key, frame }).catch((e) => this.ctx.say(fromBack(e), true));
  }

  private interrupt() {
    this.control({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } });
  }

  /* ---------- a caixa ---------- */

  private buildComposer() {
    this.box.innerHTML = `
      <div class="cquote" hidden></div>
      <textarea rows="1" spellcheck="true"></textarea>
      <div class="crow">
        <div class="modes" hidden>
          <button class="mode on" data-mode="agent"></button>
          <button class="mode" data-mode="note"></button>
        </div>
        <!-- O "+" abre a lista de arquivos do workspace, a mesma do "@". -->
        <button class="ico sm addfile" hidden></button>
        <!-- Com quem se fala, como no rodapé do lançador: o modelo e o degrau
             de esforço desta conversa. Aqui só se lê — modelo não se troca com
             a conversa de pé; escolhe-se ao abrir a aba, na setinha do "+". -->
        <span class="with" hidden>
          <span class="mdl"></span>
          <span class="effort"><span class="bars"><i></i><i></i><i></i><i></i><i></i></span><span class="el"></span></span>
        </span>
        <button class="ico sm at" hidden></button>
        <button class="outline md quotesel" hidden></button>
        <span class="hint"></span>
        <span class="spacer"></span>
        <button class="ghost md stop" hidden></button>
        <button class="send"></button>
      </div>`;
    this.area = this.box.querySelector("textarea")!;
    const q = (sel: string) => this.box.querySelector<HTMLElement>(sel)!;
    q(".mode[data-mode=agent]").textContent = t("chat.mode.agent");
    q(".mode[data-mode=note]").textContent = t("chat.mode.note");
    q(".at").innerHTML = icon("at-sign", 13);
    q(".at").title = t("notes.mention");
    q(".addfile").innerHTML = icon("plus", 14);
    q(".addfile").title = t("chat.addFile");
    q(".quotesel").innerHTML = `${icon("message-square", 12)}<span></span>`;
    q(".quotesel span").textContent = t("notes.quoteSelection");
    q(".quotesel").title = t("notes.quoteSelection.title");
    q(".stop").innerHTML = `${icon("square", 12)}<span></span>`;
    q(".stop span").textContent = t("chat.stop");

    for (const b of this.box.querySelectorAll<HTMLElement>(".mode")) {
      b.addEventListener("click", () => this.setMode(b.dataset.mode as "agent" | "note"));
    }
    q(".at").addEventListener("click", () => notes.pickMention(this.area, () => this.keep()));
    q(".addfile").addEventListener("click", () => this.addFile());
    q(".quotesel").addEventListener("click", () => this.quoteSelection());
    q(".stop").addEventListener("click", () => this.interrupt());
    q(".send").addEventListener("click", () => this.send());

    this.area.addEventListener("input", () => {
      this.keep();
      this.grow();
      // O "@" é do texto, não do menu: ele entra como qualquer letra, e a
      // lista abre depois e acompanha o que vem — quem fecha a lista continua
      // com o que digitou, e quem escolhe um nome vê o nome tomar o lugar do
      // "@ti" que já estava lá.
      if (this.mode === "note") notes.typedMention(this.area, () => this.keep());
      // O "/" no começo da fala é a mesma coisa: a lista dos comandos que o
      // agente aceita abre em cima da caixa e acompanha as letras. Onde não há
      // comando, o "@" vale como caminho: na fala é assim que se aponta um
      // arquivo do workspace (ver `paths.ts`).
      else if (!commands.typed(this.area, this.commands(), () => this.grow())) this.typedPath();
    });
    this.area.addEventListener("keydown", (e) => {
      const pick = e.key === "Enter" || e.key === "Tab";
      if (pick && !e.shiftKey && !e.isComposing && (notes.acceptMention() || commands.accept(e.key === "Tab") || paths.accept())) {
        e.preventDefault();
      } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      } else if (e.key === "Escape" && this.tl.busy && !this.area.value) {
        e.preventDefault();
        this.interrupt();
      }
    });
  }

  /// O "+" ao lado da caixa: abre a lista de arquivos do workspace sem que
  /// ninguém precise saber do "@". O que ele faz é escrever o "@" onde o
  /// cursor está — o caminho escolhido entra na fala como qualquer outro.
  private addFile() {
    const a = this.area;
    const { text, cut } = paths.begin(a.value, a.selectionStart);
    a.value = text;
    a.focus();
    a.selectionStart = a.selectionEnd = cut;
    this.grow();
    this.typedPath();
  }

  /// A lista de caminhos do "@". Só na conversa daqui: a de um colega roda no
  /// Mac dele, e os arquivos que ela aponta não são os deste workspace.
  private typedPath() {
    const ws = this.ctx.info().workspace;
    if (this.remote || !ws) return paths.dismiss();
    void paths.typed(this.area, ws, touched(this.tl.items), () => this.grow());
  }

  /// O rascunho da nota, guardado a cada tecla: a nota é do workspace, e o
  /// quadro pode redesenhar no meio de uma frase.
  private keep() {
    const ws = this.ctx.info().workspace;
    if (this.mode === "note" && ws) notes.draftOf(ws).text = this.area.value;
  }

  /// Guarda a fala antes de a tela ligar noutra conversa. A nota é do
  /// workspace, mas a fala é da aba — e no meio de uma troca só a chave antiga
  /// ainda está aqui; o workspace de `info()` já pode ser o de destino.
  private stash() {
    if (this.mode === "agent" && this.key) this.says.set(this.key, this.area.value);
  }

  private stashed(): string {
    return (this.key && this.says.get(this.key)) || "";
  }

  /// Aba fechada leva junto a fala que ficou pela metade nela.
  forget(alive: Set<string>) {
    for (const key of this.says.keys()) if (!alive.has(key)) this.says.delete(key);
  }

  private grow() {
    const a = this.area;
    a.style.height = "0";
    a.style.height = `${Math.min(a.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  private setMode(mode: "agent" | "note") {
    if (mode === this.mode) return;
    const ws = this.ctx.info().workspace;
    if (this.mode === "note" && ws) notes.draftOf(ws).text = this.area.value;
    else this.stash();
    this.mode = mode;
    if (ws) this.modes.set(ws, mode);
    this.area.value = mode === "note" ? (ws ? notes.draftOf(ws).text : "") : this.stashed();
    this.grow();
    this.paintComposer();
    this.area.focus();
  }

  /// Ligar noutra conversa: o toggle volta a ser o daquele workspace, e a
  /// caixa, o que estava escrito ali — a nota do workspace, ou a fala da aba.
  /// Sem isto, começar uma frase num workspace e clicar noutro levava a frase
  /// junto.
  private restoreMode() {
    const ws = this.ctx.info().workspace;
    const mode = (ws && this.modes.get(ws)) || "agent";
    this.area.value = mode === "note" ? (ws ? notes.draftOf(ws).text : "") : this.stashed();
    this.mode = mode;
    this.grow();
  }

  /// ⌘⇧M, ou o botão: a nota nasce citando o que está selecionado.
  quoteSelection(): boolean {
    const ws = this.ctx.info().workspace;
    const sel = this.selection().trim();
    if (!ws || !sel || !this.ctx.info().team) return false;
    notes.draftOf(ws).quote = sel;
    this.setMode("note");
    this.paintComposer();
    this.area.focus();
    return true;
  }

  private send() {
    const text = this.area.value.trim();
    if (!text || !this.key) return;
    const info = this.ctx.info();
    if (this.mode === "note") {
      if (!info.workspace) return;
      const draft = notes.draftOf(info.workspace);
      let sent: boolean;
      try {
        sent = team.addNote(info.workspace, text, notes.mentionsIn(text), draft.quote);
      } catch (e) {
        return this.ctx.say(fromBack(e), true);
      }
      // Sem conexão a nota não sai. O texto fica onde está — perder o que se
      // acabou de escrever é pior que ver o erro.
      if (!sent) return this.ctx.say(t("err.team.down"), true);
      this.posted = { ws: info.workspace, count: team.notesOf(info.workspace).length };
      notes.dropDraft(info.workspace);
      this.area.value = "";
      this.grow();
      this.paintComposer();
      return;
    }
    if (info.remote && !info.remote.online) return this.ctx.say(t("err.team.offline"), true);
    if (this.remote) team.write(text);
    else invoke("chat_send", { session: this.key, text }).catch((e) => this.ctx.say(fromBack(e), true));
    this.says.delete(this.key);
    this.area.value = "";
    commands.dismiss();
    paths.dismiss();
    this.grow();
  }

  /// Os comandos de barra desta conversa: o que o processo respondeu ao subir
  /// (ver `Timeline.commands`). Com a conversa desligada não há processo, e
  /// o transcript não guarda a resposta: vale a última lista vista com este
  /// modelo — os comandos são quase todos os mesmos de uma conversa para
  /// outra — e, antes de qualquer uma, os dois que o app conhece por si.
  private commands(): Command[] {
    const key = `prometheus:comandos:${this.ctx.info().model}`;
    const live = this.tl.commands;
    if (live.length) {
      localStorage.setItem(key, JSON.stringify(live));
      return live;
    }
    try {
      const seen: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (Array.isArray(seen) && seen.length) {
        return seen.filter((c): c is Command => !!c && typeof c.name === "string" && typeof c.description === "string");
      }
    } catch {
      /* lista velha ilegível: é como se não houvesse */
    }
    return [
      { name: "compact", description: t("chat.cmd.compact"), hint: "" },
      { name: "context", description: t("chat.cmd.context"), hint: "" },
    ];
  }

  private paintComposer() {
    const info = this.ctx.info();
    const q = (sel: string) => this.box.querySelector<HTMLElement>(sel)!;
    const hasKey = !!this.key;
    this.box.hidden = !hasKey;
    if (!hasKey) return;
    if (!info.team && this.mode === "note") this.setMode("agent");
    q(".modes").hidden = !info.team;
    for (const b of this.box.querySelectorAll<HTMLElement>(".mode")) b.classList.toggle("on", b.dataset.mode === this.mode);
    const note = this.mode === "note";
    q(".at").hidden = !note;
    // O "+" aponta arquivo do workspace daqui: não há o que apontar numa nota,
    // nem na conversa de um colega — os arquivos dela são do Mac dele.
    q(".addfile").hidden = note || this.remote || !info.workspace;
    q(".stop").hidden = note || !this.tl.busy;
    this.box.classList.toggle("note", note);
    this.box.classList.toggle("busy", !note && this.tl.busy);

    const off = info.remote ? !info.remote.online : false;
    this.area.disabled = !note && off;
    this.area.placeholder = note
      ? t("notes.write")
      : off
        ? t("chat.placeholder.remoteOff", { name: info.remote?.name ?? "" })
        : info.remote
          ? t("chat.placeholder.remote", { name: info.remote.name })
          : info.status === "desligada"
            ? t("chat.placeholder.off")
            : t("chat.placeholder");
    q(".hint").textContent = note ? "" : this.tl.compacting ? t("chat.compacting") : this.tl.busy ? t("chat.busy") : "";
    this.paintWith(info, note);
    // Falar com o agente é uma seta redonda, como no Conductor; deixar nota é
    // outra coisa, e continua dizendo o que faz.
    const send = q(".send");
    send.className = note ? "send pri md" : "send pri round";
    send.title = t(note ? "notes.send" : "chat.send");
    if (note) send.textContent = t("notes.send");
    else send.innerHTML = icon("arrow-up", 16);

    const quote = note && info.workspace ? notes.draftOf(info.workspace).quote : null;
    const chip = q(".cquote");
    chip.hidden = !quote;
    chip.replaceChildren();
    if (quote && info.workspace) {
      chip.append(
        notes.quoteChip(quote, () => {
          notes.draftOf(info.workspace!).quote = null;
          this.paintComposer();
        }),
      );
    }
    this.paintQuoteButton();
  }

  /// Com quem se está falando, embaixo da caixa: o modelo e o degrau de
  /// esforço desta conversa — o dela, quando a aba nasceu com um escolhido, ou
  /// o do workspace. Aqui só se lê, e por isso não é botão: trocar é abrir aba
  /// nova. Nota não vai para modelo nenhum: some.
  private paintWith(info: Info, note: boolean) {
    const el = this.box.querySelector<HTMLElement>(".with")!;
    const label = info.model ? modelLabel(info.model) : "";
    el.hidden = note || !label;
    if (el.hidden) return;
    el.querySelector<HTMLElement>(".mdl")!.innerHTML = `${icon("sparkles", 13)}<span></span>`;
    el.querySelector<HTMLElement>(".mdl span")!.textContent = label;
    const step = effortStep(info.model, info.effort);
    const bars = el.querySelector<HTMLElement>(".effort")!;
    bars.hidden = !step;
    if (!step) return;
    bars.classList.toggle("ultra", info.effort === "ultracode");
    bars.querySelector<HTMLElement>(".el")!.textContent = step.label;
    bars.querySelectorAll(".bars i").forEach((bar, n) => bar.classList.toggle("lit", n <= step.step));
    bars.title = t("chat.with", { model: label, effort: step.label });
  }

  /// O botão "Comentar a seleção", que só existe com time e seleção.
  private paintQuoteButton() {
    if (!this.key) return;
    const b = this.box.querySelector<HTMLElement>(".quotesel");
    if (b) b.hidden = !this.ctx.info().team || !this.selection().trim();
  }

  /* ---------- notas do time, no meio da conversa ---------- */

  /// Cada nota entra antes do primeiro item mais novo que ela — é a hora em
  /// que foi escrita que diz de que pedaço da conversa ela fala.
  private paintNotes() {
    const ws = this.ctx.info().workspace;
    for (const old of this.feed.querySelectorAll(".note")) old.remove();
    if (!ws || !this.ctx.info().team) return;
    const list = team.notesOf(ws);
    if (!list.length) return;
    const items = this.tl.items;
    for (const note of [...list].sort((a, b) => a.ts - b.ts)) {
      const at = items.findIndex((it) => it.ts > note.ts);
      const card = notes.card(note);
      const node = at === -1 ? null : this.nodeOf(at);
      if (node) node.before(card);
      else this.feed.append(card);
    }
  }

  /// O nó em que um item aparece: o dele, ou o cartão de trabalho que o
  /// engoliu. É onde uma nota daquela hora entra.
  private nodeOf(at: number): HTMLElement | null {
    for (let i = 0; i < this.shown.length; i++) {
      const piece = this.shown[i];
      const last = piece.kind === "work" ? piece.refs[piece.refs.length - 1].at : piece.at;
      if (last >= at) return this.drawn[i] ?? null;
    }
    return null;
  }

  /// Leva até uma nota — de onde a caixa "Para mim" leva.
  focusNote(id: string) {
    this.paintNotes();
    const el = this.feed.querySelector<HTMLElement>(`.note[data-note="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.add("lit");
    el.scrollIntoView({ block: "center" });
  }
}
