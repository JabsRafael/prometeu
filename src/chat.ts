import { invoke } from "./ipc";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { capabilitiesOf } from "./agents";
import type { ConversationCommandV1, RequestResponse } from "./conversation";
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
import { effortStep, fitsEffort, modelGroups, modelLabel, nextEffort } from "./launcher";
import { md } from "./markdown";
import * as mcp from "./mcp";
import * as menu from "./menu";
import * as plugins from "./plugins";
import * as commands from "./commands";
import * as notes from "./notes";
import * as paths from "./paths";
import * as team from "./team";
import { pieces, summary, Timeline, touched, type Ask, type Block, type Command, type Item, type Piece, type ToolBlock } from "./timeline";
import type { Choice, ProviderId, Status } from "./types";
import { h, template } from "./util";

/// A conversa na tela: a timeline desenhada, e a caixa de escrever embaixo.
///
/// Não é um terminal. O que chega é uma linha de JSON por vez (`chat.rs`), o
/// `Timeline` diz o que ela mudou, e só isso é redesenhado. O que sai é uma
/// fala, uma resposta a um card (permissão, pergunta, plano) ou uma
/// interrupção — por `ConversationCommandV1` no mesmo cano.
///
/// A conversa de um colega é a mesma tela: as linhas vêm do relay em vez do
/// back, e o que se escreve vai para o Mac dele em vez do processo daqui.
///
/// Comentários do time ficam no painel lateral e apontam para os `Piece.key`
/// estáveis que esta tela grava em cada trecho do transcript.

/// O que a tela precisa saber da aba aberta, e que não está nas linhas.
export type Info = {
  /// O id do workspace na tela (o de um colega vem prefixado).
  workspace: string | null;
  status: Status | null;
  /// A fala que ainda não foi — espera o setup do worktree terminar.
  pending: string | null;
  /// A conversa é de um colega: o nome dele, e se ele está aí.
  remote: { name: string; online: boolean } | null;
  /// Onde o agente trabalha: a pasta do worktree. O "+" abre o Finder ali, e
  /// o arquivo escolhido dentro dela entra na fala como caminho relativo.
  worktree: string | null;
  /// Este workspace participa do time — e, portanto, aceita comentários. Ter um time
  /// configurado não basta: um workspace local que nunca foi compartilhado
  /// não existe no relay.
  team: boolean;
  /// Com quem se está falando: o modelo e o esforço desta conversa — o que a
  /// aba escolheu (ao nascer, ou depois, no rodapé da caixa), ou o do
  /// workspace. Vazio é o padrão do CLI, e aí a caixa não diz nada.
  agent: ProviderId;
  model: string;
  effort: string;
  /// As ferramentas de MCP deste workspace. `null` é nunca ter escolhido — o
  /// CLI decide, como antes do hub existir.
  mcp: string[] | null;
  /// Os plugins deste workspace, pela mesma regra do MCP.
  plugins: string[] | null;
};

export type Ctx = {
  say: (text: string, isError?: boolean) => void;
  info: () => Info;
  comment?: (target: notes.Target) => void;
  thread?: (id: string) => void;
};

/* ---------- marcar MCP e plugin sem derrubar a conversa a cada clique ------ */

/// Gravar a escolha de MCP ou de plugin derruba o processo da conversa e faz o
/// back republicar o quadro — que redesenha o app inteiro. A cada clique isso é
/// caro, e marcar três coisas seguidas fazia três vezes. A marca na tela é na
/// hora (o menu se redesenha com o que a pessoa acabou de marcar); o back ouve
/// quando a mão para.
const SETTLE = 300;
/// Uma escolha pendente por assunto: mexer no MCP e nos plugins na mesma
/// respiração são duas gravações, e uma não pode engolir a outra.
const settling = new Map<string, () => void>();
let settleAt: number | undefined;

function settleWrite(what: string, workspace: string, fn: () => void) {
  // A escolha é do workspace. Com várias caixas na mesa, usar só o assunto
  // fazia um clique em outro workspace substituir silenciosamente o primeiro.
  settling.set(`${what}\u0000${workspace}`, fn);
  clearTimeout(settleAt);
  settleAt = window.setTimeout(settleNow, SETTLE);
}

/// Grava agora o que estava esperando. Falar é o momento em que esperar deixa
/// de ser economia e passa a ser corrida: a fala sobe o processo, e a gravação
/// atrasada o derrubaria em seguida.
function settleNow() {
  clearTimeout(settleAt);
  settleAt = undefined;
  const runs = [...settling.values()];
  settling.clear();
  for (const run of runs) run();
}

/* ---------- estado efêmero que pertence à conversa, não à tela ----------- */

/// A mesa e o workspace desenham a mesma conversa em `ChatView`s diferentes.
/// Rascunho e anexos precisam, portanto, morar acima da
/// instância: entrar no workspace não pode fazer a fala parecer que sumiu.
const drafts = {
  says: new Map<string, string>(),
  files: new Map<string, string[]>(),
};

export class ChatView {
  private feed!: HTMLElement;
  private box!: HTMLElement;
  private area!: HTMLTextAreaElement;
  private ctx!: Ctx;
  private key: string | null = null;
  private remote = false;
  /// Invalida também uma segunda ligação para a mesma chave. Comparar apenas
  /// `key` não distingue o snapshot velho do novo depois de sair e voltar.
  private attachVersion = 0;
  private disposed = false;
  private cleanup: (() => void)[] = [];
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
  private feedback: string | null = null;
  /// Itens que mudaram desde o último quadro. O stream manda uma linha por
  /// token; redesenhar a cada uma trava a tela — um quadro por vez basta.
  private dirty = new Set<number>();
  private raf = 0;
  private working = template("div", "working", "<i></i><i></i><i></i><span class=\"wlabel\"></span>");
  /// A fala guardada, esperando o setup: fica na tela como se tivesse ido,
  /// com o aviso de que ainda não foi.
  private waiting = template("div", "turn user wait", `<div class="bubble"></div><div class="working"><i></i><i></i><i></i><span class="wlabel"></span></div>`);

  open(host: HTMLElement, ctx: Ctx) {
    this.ctx = ctx;
    this.disposed = false;
    this.feed = h("div", "feed");
    this.box = h("div", "composer");
    host.append(this.feed, this.box);
    this.buildComposer();

    void listen<[string, string, number]>("chat", ({ payload: [session, line] }) => {
      if (session !== this.key || this.remote) return;
      this.absorb(line);
    }).then((unlisten) => {
      // A aba pode ter sumido enquanto o registro atravessava o IPC.
      if (this.disposed) unlisten();
      else this.cleanup.push(unlisten);
    });
    // Comentário novo ou resolvido atualiza somente os marcadores do transcript.
    const teamChanged = () => {
      if (this.key) this.paintCommentPins();
      this.paintComposer();
    };
    this.cleanup.push(team.onChange(teamChanged));
    const selectionChanged = () => this.paintQuoteButton();
    document.addEventListener("selectionchange", selectionChanged);
    this.cleanup.push(() => document.removeEventListener("selectionchange", selectionChanged));
  }

  /* ---------- ligar e desligar ---------- */

  /// Uma conversa daqui: a rolagem que o back guardou, e daí em diante as
  /// linhas ao vivo.
  async attach(key: string) {
    if (this.disposed) return;
    const version = ++this.attachVersion;
    this.stash();
    this.key = key;
    this.remote = false;
    this.reset();
    this.restore();
    const text = await invoke<string>("chat_buffer", { session: key });
    if (this.disposed || version !== this.attachVersion || this.key !== key) return;
    this.tl.load(text);
    this.renderAll();
  }

  /// A conversa de um colega: as linhas que vieram dele. Daqui em diante os
  /// bytes chegam por `remoteWrite`.
  attachRemote(key: string, bytes: Uint8Array) {
    if (this.disposed) return;
    this.attachVersion++;
    this.stash();
    this.key = key;
    this.remote = true;
    this.reset();
    this.restore();
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
    this.attachVersion++;
    this.stash();
    this.key = null;
    this.remote = false;
    this.reset();
    this.restore();
    this.paintComposer();
  }

  /// Uma tela escondida pode voltar e por isso só `detach`; um quadro cuja aba
  /// deixou de existir termina aqui, junto com ouvintes que o reteriam para
  /// sempre mesmo depois de o DOM sair.
  dispose(forget = false) {
    if (this.disposed) return;
    const key = this.key;
    this.detach();
    // Arquivar ou limpar só tira o quadro da mesa; fechar a aba tira também o
    // rascunho dela. Quem conhece essa diferença é o dono da coleção.
    if (forget && key) {
      drafts.says.delete(key);
      drafts.files.delete(key);
    }
    this.disposed = true;
    for (const stop of this.cleanup.splice(0)) stop();
  }

  private reset() {
    this.tl = new Timeline();
    this.shown = [];
    this.drawn = [];
    this.partial = "";
    this.decoder = new TextDecoder("utf-8");
    this.feedback = null;
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

  /// O texto selecionado dentro da conversa — é o que um comentário cita.
  selection(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode || !this.feed.contains(sel.anchorNode)) return "";
    return sel.toString();
  }

  /// Só a conversa local consegue entregar um arquivo deste
  /// Mac. É a mesma regra do botão "+" da caixa.
  canAttachFiles(): boolean {
    const info = this.ctx.info();
    return (
      !!this.key &&
      !this.remote &&
      !!info.workspace &&
      capabilitiesOf(info.agent).attachments
    );
  }

  /// Arquivos escolhidos no Finder ou soltos em cima da conversa entram no
  /// mesmo rascunho, sem mexer no texto que já estava sendo escrito.
  attachFiles(paths: string[]): boolean {
    if (!this.canAttachFiles()) return false;
    const files = this.attached().slice();
    for (const path of paths) if (path && !files.includes(path)) files.push(path);
    if (this.key) drafts.files.set(this.key, files);
    this.paintComposer();
    this.area.focus();
    return true;
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
    if (changed) this.paintCommentPins();
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

  private renderAll() {
    this.shown = [];
    this.drawn = [];
    this.feed.replaceChildren();
    if (!this.tl.items.length) this.feed.append(h("div", "nohint", t("chat.empty")));
    this.sync(null);
    this.paintCommentPins();
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
    if (old) {
      old.querySelector(".took")!.textContent = label;
      this.paintCommentAction(old, piece);
      return;
    }
    const meta = template("div", "meta", `<span class="took"></span><button class="ico sm cp"></button><button class="ghost sm cm"></button>`);
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
    this.paintCommentAction(meta, piece);
    el.append(meta);
  }

  private paintCommentAction(meta: Element, piece: Extract<Piece, { kind: "say" }>) {
    const button = meta.querySelector<HTMLButtonElement>(".cm");
    if (!button) return;
    button.hidden = !this.ctx.comment || !this.ctx.info().team;
    if (button.hidden) return;
    button.innerHTML = `${icon("message-square", 12)}<span></span>`;
    button.querySelector("span")!.textContent = t("notes.comment");
    button.title = t("notes.comment.turn");
    button.onclick = () => {
      const at = this.blockAt(piece);
      const quote = at?.block.kind === "text" ? at.block.text : null;
      if (this.key) this.ctx.comment?.({ tab: this.key, anchor: piece.key, quote });
    };
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
        v: 1,
        type: "permission.mode.set",
        mode: "bypass",
      });
      this.respond(ask, { outcome: "allow" });
    });
    const asking = h("button", "outline md", t("chat.plan.ask"));
    asking.title = t("chat.plan.ask.title");
    asking.addEventListener("click", () => this.respond(ask, { outcome: "allow" }));
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
      this.respond(ask, { outcome: "deny", message: text });
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
      this.respond(ask, { outcome: "answer", answers: out });
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
    yes.addEventListener("click", () => this.respond(ask, { outcome: "allow" }));
    const always = h("button", "outline md", t("chat.perm.always"));
    always.addEventListener("click", () => {
      this.control({
        v: 1,
        type: "permission.mode.set",
        mode: "bypass",
      });
      this.respond(ask, { outcome: "allow" });
    });
    const no = h("button", "ghost md", t("chat.perm.no"));
    no.addEventListener("click", () => this.respond(ask, { outcome: "deny", message: t("chat.perm.denied") }));
    row.append(yes, always, no);
    el.append(row);
    return el;
  }

  private respond(ask: Ask, response: RequestResponse) {
    this.control({ v: 1, type: "request.respond", requestId: ask.id, response });
    this.sync(new Set(this.tl.answer(ask.id)));
    this.paintComposer();
  }

  /// Uma linha de controle para o processo — daqui, ou pelo relay até o Mac
  /// do dono, que a repassa (ver `team.ts`).
  private control(frame: ConversationCommandV1) {
    if (!this.key) return;
    if (this.remote) team.write(JSON.stringify(frame));
    else invoke("chat_control", { session: this.key, frame }).catch((e) => this.ctx.say(fromBack(e), true));
  }

  private interrupt() {
    this.control({ v: 1, type: "turn.interrupt" });
  }

  /* ---------- a caixa ---------- */

  private buildComposer() {
    this.box.innerHTML = `
      <!-- Os anexos ficam à vista, em cima do que se escreve: o que vai junto
           da fala é parte da fala. É a mesma tira do lançador. -->
      <div class="cfiles" hidden></div>
      <textarea rows="1" spellcheck="true"></textarea>
      <div class="crow">
        <!-- O "+" abre o Finder: qualquer arquivo do Mac vira menção na fala. -->
        <button class="ico sm addfile" hidden></button>
        <!-- Com quem se fala, como no rodapé do lançador: o modelo e o degrau
             de esforço desta conversa, e onde se troca os dois no meio dela.
             Trocar derruba o processo, e a próxima fala o retoma — o mesmo
             que o seletor de MCP ao lado faz. -->
        <span class="with" hidden>
          <button class="ghost mdl"></button>
          <button class="ghost effort"><span class="bars"><i></i><i></i><i></i><i></i><i></i></span><span class="el"></span></button>
        </span>
        <!-- As ferramentas: aqui se troca, diferente do modelo. Trocar derruba
             o processo, e a próxima fala o levanta retomando a sessão — a
             conversa continua de onde estava, com o que foi marcado agora. -->
        <button class="ghost sm mcpbtn" hidden><span></span></button>
        <button class="ghost sm plugbtn" hidden><span></span></button>
        <button class="outline md quotesel" hidden></button>
        <span class="hint"></span>
        <span class="spacer"></span>
        <button class="ghost md stop" hidden></button>
        <button class="send"></button>
      </div>`;
    this.area = this.box.querySelector("textarea")!;
    const q = (sel: string) => this.box.querySelector<HTMLElement>(sel)!;
    q(".addfile").innerHTML = icon("plus", 14);
    q(".addfile").title = t("chat.addFile");
    q(".quotesel").innerHTML = `${icon("message-square", 12)}<span></span>`;
    q(".quotesel span").textContent = t("notes.quoteSelection");
    q(".quotesel").title = t("notes.quoteSelection.title");
    q(".stop").innerHTML = `${icon("square", 12)}<span></span>`;
    q(".stop span").textContent = t("chat.stop");

    q(".addfile").addEventListener("click", () => void this.addFile());
    q(".quotesel").addEventListener("click", () => this.quoteSelection());
    q(".stop").addEventListener("click", () => this.interrupt());
    q(".send").addEventListener("click", () => this.send());

    this.area.addEventListener("input", () => {
      this.keep();
      this.grow();
      // O "/" no começo da fala é a mesma coisa: a lista dos comandos que o
      // agente aceita abre em cima da caixa e acompanha as letras. Onde não há
      // comando, o "@" vale como caminho: na fala é assim que se aponta um
      // arquivo do workspace (ver `paths.ts`).
      if (!commands.typed(this.area, this.commands(), () => this.grow())) this.typedPath();
    });
    this.area.addEventListener("keydown", (e) => {
      const pick = e.key === "Enter" || e.key === "Tab";
      if (pick && !e.shiftKey && !e.isComposing && (commands.accept(e.key === "Tab") || paths.accept())) {
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

  /// O "+" ao lado da caixa: o Finder, aberto no worktree mas livre para ir a
  /// qualquer canto do Mac — a captura de tela na Área de Trabalho, o arquivo
  /// de outro projeto. O escolhido vira anexo desta fala, como no lançador: um
  /// chip em cima da caixa, que sai da fala com o "×" e vira menção quando ela
  /// vai. O texto que se está escrevendo não é mexido.
  private async addFile() {
    const root = this.ctx.info().worktree;
    const picked = await open({ multiple: true, title: t("chat.addFile.dialog"), defaultPath: root ?? undefined });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    this.attachFiles(list);
  }

  /// Os anexos desta conversa. Sem aba não há onde guardá-los.
  private attached(): string[] {
    return (this.key && drafts.files.get(this.key)) || [];
  }

  /// A lista de caminhos do "@". Só na conversa daqui: a de um colega roda no
  /// Mac dele, e os arquivos que ela aponta não são os deste workspace.
  private typedPath() {
    const ws = this.ctx.info().workspace;
    if (this.remote || !ws) return paths.dismiss();
    void paths.typed(this.area, ws, touched(this.tl.items), () => this.grow());
  }

  /// O rascunho da fala fica na aba e acompanha cada tecla.
  private keep() {
    if (this.key) drafts.says.set(this.key, this.area.value);
  }

  /// Guarda a fala antes de a tela ligar noutra conversa.
  private stash() {
    this.keep();
  }

  private stashed(): string {
    return (this.key && drafts.says.get(this.key)) || "";
  }

  /// Aba fechada leva junto a fala que ficou pela metade nela, e os anexos
  /// que esperavam por ela.
  forget(alive: Set<string>) {
    for (const key of drafts.says.keys()) if (!alive.has(key)) drafts.says.delete(key);
    for (const key of drafts.files.keys()) if (!alive.has(key)) drafts.files.delete(key);
  }

  private grow() {
    const a = this.area;
    a.style.height = "0";
    a.style.height = `${Math.min(a.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  /// Ligar noutra conversa restaura o rascunho daquela aba.
  private restore() {
    this.area.value = this.stashed();
    this.grow();
  }

  /// ⌘⇧M, ou o botão: abre o painel sem trocar a caixa do agente.
  quoteSelection(): boolean {
    const sel = this.selection().trim();
    if (!this.key || !sel || !this.ctx.info().team || !this.ctx.comment) return false;
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    const anchor = element?.closest<HTMLElement>("[data-key]")?.dataset.key ?? null;
    this.ctx.comment({ tab: this.key, anchor, quote: sel });
    return true;
  }

  private send() {
    // O que foi marcado no seletor e ainda não foi gravado vai agora: a fala
    // sobe o processo, e a gravação atrasada o derrubaria em seguida.
    settleNow();
    const text = this.area.value.trim();
    const files = this.attached();
    if ((!text && !files.length) || !this.key) return;
    const info = this.ctx.info();
    if (info.remote && !info.remote.online) return this.ctx.say(t("err.team.offline"), true);
    // Os anexos vão na frente da fala, como menção — a mesma forma que o
    // lançador dá ao que se anexa à primeira fala.
    const said = [paths.mentions(files, info.worktree), text].filter(Boolean).join("\n\n");
    if (this.remote) team.write(said);
    else invoke("chat_send", { session: this.key, text: said }).catch((e) => this.ctx.say(fromBack(e), true));
    drafts.says.delete(this.key);
    drafts.files.delete(this.key);
    this.area.value = "";
    commands.dismiss();
    paths.dismiss();
    this.grow();
    this.paintComposer();
  }

  /// Os comandos de barra desta conversa: o que o processo respondeu ao subir
  /// (ver `Timeline.commands`). Com a conversa desligada não há processo, e
  /// o transcript não guarda a resposta: vale a última lista vista com este
  /// modelo — os comandos são quase todos os mesmos de uma conversa para
  /// outra — e, antes de qualquer uma, os dois que o app conhece por si.
  private commands(): Command[] {
    const info = this.ctx.info();
    const capabilities = capabilitiesOf(info.agent);
    const supported = (command: Command) =>
      (command.name !== "compact" || capabilities.compact) &&
      (command.name !== "context" || capabilities.contextReport);
    const key = `prometeu:comandos:${info.agent}:${info.model}`;
    const live = this.tl.commands;
    if (live.length) {
      localStorage.setItem(key, JSON.stringify(live));
      return live.filter(supported);
    }
    try {
      const seen: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (Array.isArray(seen) && seen.length) {
        return seen
          .filter((c): c is Command => !!c && typeof c.name === "string" && typeof c.description === "string")
          .filter(supported);
      }
    } catch {
      /* lista velha ilegível: é como se não houvesse */
    }
    return [
      ...(capabilities.compact ? [{ name: "compact", description: t("chat.cmd.compact"), hint: "" }] : []),
      ...(capabilities.contextReport ? [{ name: "context", description: t("chat.cmd.context"), hint: "" }] : []),
    ];
  }

  private paintComposer() {
    const info = this.ctx.info();
    const q = (sel: string) => this.box.querySelector<HTMLElement>(sel)!;
    const hasKey = !!this.key;
    this.box.hidden = !hasKey;
    if (!hasKey) return;
    // O "+" aponta arquivo para o agente daqui. Na conversa de um colega, o
    // agente roda noutro disco.
    q(".addfile").hidden =
      this.remote || !info.workspace || !capabilitiesOf(info.agent).attachments;
    q(".stop").hidden = !this.tl.busy;
    this.box.classList.toggle("busy", this.tl.busy);

    const off = info.remote ? !info.remote.online : false;
    this.area.disabled = off;
    this.area.placeholder = off
        ? t("chat.placeholder.remoteOff", { name: info.remote?.name ?? "" })
        : info.remote
          ? t("chat.placeholder.remote", { name: info.remote.name })
          : info.status === "desligada"
            ? t("chat.placeholder.off")
            : t("chat.placeholder");
    q(".hint").textContent = this.tl.compacting ? t("chat.compacting") : this.tl.busy ? t("chat.busy") : "";
    this.paintWith(info);
    this.paintMcp(info);
    this.paintPlugins(info);
    const send = q(".send");
    send.className = "send pri round";
    send.title = t("chat.send");
    send.innerHTML = icon("arrow-up", 16);
    this.paintQuoteButton();
    this.paintFiles();
  }

  /// Os anexos em cima da caixa: um chip por arquivo, com o nome à vista e o
  /// caminho no title — o mesmo que o agente vai ler. O "×" tira o arquivo da
  /// fala.
  private paintFiles() {
    const row = this.box.querySelector<HTMLElement>(".cfiles")!;
    const list = this.attached();
    row.hidden = !list.length;
    row.replaceChildren(
      ...list.map((path, i) => {
        const chip = template("span", "injchip", `<span></span><button class="ico sm">${icon("x", 12)}</button>`);
        chip.children[0].textContent = path.split("/").pop() ?? path;
        chip.children[0].setAttribute("title", paths.short(path, this.ctx.info().worktree));
        chip.children[1].addEventListener("click", () => {
          const files = this.attached().slice();
          files.splice(i, 1);
          if (this.key) drafts.files.set(this.key, files);
          this.paintComposer();
        });
        return chip;
      }),
    );
  }

  /// Com quem se está falando, embaixo da caixa: o modelo e o degrau de
  /// esforço desta conversa — o dela, quando a aba escolheu um, ou o do
  /// workspace.
  ///
  /// Aqui também se troca, como no rodapé do lançador: o modelo abre a lista,
  /// o esforço sobe um degrau por clique. A troca fica gravada na aba, derruba
  /// o processo e a próxima fala o retoma com as flags novas — a conversa
  /// continua de onde estava, falando com outro. É por isso que os botões
  /// fecham enquanto o agente trabalha: derrubar no meio de um turno jogaria o
  /// turno fora.
  ///
  /// Só os modelos do CLI que já está de pé entram na lista: o `--resume` do
  /// Claude Code não abre a thread do Codex, nem o contrário. Sair para um GPT
  /// é abrir aba nova, na setinha do "+".
  ///
  /// Na conversa de um colega os dois viram texto: o processo é do Mac dele.
  private paintWith(info: Info) {
    const el = this.box.querySelector<HTMLElement>(".with")!;
    const label = info.model ? modelLabel(info.model, info.agent) : "";
    el.hidden = !label;
    if (el.hidden) return;
    const working = info.status === "rodando" || info.status === "querendo";
    // Sem workspace (a conversa ainda está subindo) não há a quem pedir a
    // troca; com colega, o processo é dele.
    const fixed = !!info.remote || !info.workspace;
    el.classList.toggle("ro", fixed);
    el.title = fixed ? "" : working ? t("chat.with.busy") : t("chat.with.pick");

    const model = el.querySelector<HTMLButtonElement>(".mdl")!;
    model.innerHTML = `${icon("sparkles", 13)}<span></span>`;
    model.querySelector("span")!.textContent = label;
    model.disabled = fixed || working;
    model.onclick = () => this.pickModel(model, info);

    const step = effortStep(info.model, info.effort, info.agent);
    const bars = el.querySelector<HTMLButtonElement>(".effort")!;
    bars.hidden = !step;
    if (!step) return;
    bars.classList.toggle("ultra", info.effort === "ultracode");
    bars.querySelector<HTMLElement>(".el")!.textContent = step.label;
    bars.querySelectorAll(".bars i").forEach((bar, n) => bar.classList.toggle("lit", n <= step.step));
    bars.disabled = fixed || working;
    bars.onclick = () =>
      this.retune(info, {
        agent: info.agent,
        model: info.model,
        effort: nextEffort(info.model, info.effort, info.agent),
      });
  }

  /// A lista de modelos desta conversa: a mesma do lançador, restrita ao CLI
  /// que está de pé, com o de agora marcado. O esforço vai junto porque cada
  /// modelo tem a sua escada — sair do Sol para um que para no xhigh cai no
  /// xhigh, como no "+".
  private pickModel(at: HTMLElement, info: Info) {
    const box = at.getBoundingClientRect();
    const blocks = modelGroups(info.agent);
    const items: menu.Item[] = [];
    blocks.forEach((block, n) => {
      if (n) items.push("sep");
      if (block.head && blocks.length > 1) items.push({ label: block.head, disabled: true });
      for (const [id, name] of block.items) {
        items.push({
          label: name,
          checked: id === info.model,
          run: () =>
            this.retune(info, {
              agent: info.agent,
              model: id,
              effort: fitsEffort(id, info.effort, info.agent),
            }),
        });
      }
    });
    menu.openAt({ x: box.left, y: box.bottom + 4 }, items);
  }

  /// Grava a escolha na aba e derruba o processo dela. Escolher o que já está
  /// não mexe em nada: não há por que desligar uma conversa para deixá-la
  /// igual.
  private retune(info: Info, choice: Choice) {
    if (choice.model === info.model && choice.effort === info.effort) return;
    if (!info.workspace || !this.key) return;
    void invoke("set_tab_choice", { id: info.workspace, tab: this.key, choice }).catch((e) =>
      this.ctx.say(fromBack(e), true),
    );
  }

  /// As ferramentas de MCP desta conversa, e o botão que as troca.
  ///
  /// Diferente do modelo, aqui se escolhe com a conversa andando: o MCP entra
  /// quando o processo sobe, e derrubá-lo não perde nada — a sessão é o
  /// transcript, e a próxima fala a retoma. Por isso o botão fecha enquanto o
  /// agente trabalha: derrubar no meio de um turno jogaria o turno fora.
  ///
  /// Some na conversa de um colega (não é o meu processo) e onde não
  /// há hub nem escolha — um botão que abre uma lista vazia é um botão que não
  /// faz nada.
  private paintMcp(info: Info) {
    const btn = this.box.querySelector<HTMLButtonElement>(".mcpbtn")!;
    const has = mcp.list().length > 0 || info.mcp !== null;
    btn.hidden =
      !!info.remote ||
      !info.workspace ||
      !capabilitiesOf(info.agent).workspaceMcpSelection ||
      !has;
    if (btn.hidden) return;
    const working = info.status === "rodando" || info.status === "querendo";
    btn.innerHTML = `${icon("plug", 13)}<span></span>`;
    btn.querySelector("span")!.textContent = mcp.label(info.mcp);
    btn.classList.toggle("on", !!info.mcp?.length);
    btn.title = t("mcp.title");
    btn.onclick = () => {
      const at = btn.getBoundingClientRect();
      const workspace = info.workspace!;
      mcp.openPicker({
        chosen: () => this.ctx.info().mcp,
        set: (ids) => {
          settleWrite("mcp", workspace, () => {
            void invoke("set_workspace_mcp", { id: workspace, mcp: ids }).catch((e) =>
              this.ctx.say(fromBack(e), true),
            );
          });
        },
        at: () => ({ x: at.left, y: at.bottom + 4 }),
        locked: () => (working ? t("mcp.busy") : ""),
      });
    };
  }

  /// Os plugins desta conversa, e o botão que os troca. Tudo o que vale para
  /// o de MCP vale aqui — inclusive derrubar o processo para a próxima fala
  /// subir com a lista nova.
  private paintPlugins(info: Info) {
    const btn = this.box.querySelector<HTMLButtonElement>(".plugbtn")!;
    const has = plugins.list().length > 0 || info.plugins !== null;
    btn.hidden =
      !!info.remote ||
      !info.workspace ||
      !has ||
      !capabilitiesOf(info.agent).workspacePluginSelection;
    if (btn.hidden) return;
    const working = info.status === "rodando" || info.status === "querendo";
    btn.innerHTML = `${icon("puzzle", 13)}<span></span>`;
    btn.querySelector("span")!.textContent = plugins.label(info.plugins);
    btn.classList.toggle("on", !!info.plugins?.length);
    btn.title = t("plugin.title");
    btn.onclick = () => {
      const at = btn.getBoundingClientRect();
      const workspace = info.workspace!;
      plugins.openPicker({
        chosen: () => this.ctx.info().plugins,
        set: (ids) => {
          settleWrite("plugins", workspace, () => {
            void invoke("set_workspace_plugins", { id: workspace, plugins: ids }).catch((e) =>
              this.ctx.say(fromBack(e), true),
            );
          });
        },
        at: () => ({ x: at.left, y: at.bottom + 4 }),
        locked: () => (working ? t("plugin.busy") : ""),
      });
    };
  }

  /// O botão "Comentar a seleção", que só existe com time e seleção.
  private paintQuoteButton() {
    if (!this.key) return;
    const b = this.box.querySelector<HTMLElement>(".quotesel");
    if (b) b.hidden = !this.ctx.comment || !this.ctx.info().team || !this.selection().trim();
  }

  /* ---------- comentários do time ancorados no transcript ---------- */

  private paintCommentPins() {
    const ws = this.ctx.info().workspace;
    for (const old of this.feed.querySelectorAll(".commentpin")) old.remove();
    if (!ws || !this.key || !this.ctx.info().team || !this.ctx.thread) return;
    const grouped = new Map<string, ReturnType<typeof notes.rootsOf>>();
    for (const note of notes.rootsOf(team.notesOf(ws), this.key)) {
      if (note.resolved || !note.anchor) continue;
      const list = grouped.get(note.anchor) ?? [];
      list.push(note);
      grouped.set(note.anchor, list);
    }
    for (const [anchor, list] of grouped) {
      const node = this.feed.querySelector<HTMLElement>(`[data-key="${CSS.escape(anchor)}"]`);
      if (!node) continue;
      const pin = h("button", "commentpin", `${list.length}`);
      pin.title = tn(list.length, "notes.onTurn");
      pin.onclick = () => this.ctx.thread?.(list[0].id);
      node.append(pin);
    }
  }

  focusAnchor(anchor: string) {
    const el = this.feed.querySelector<HTMLElement>(`[data-key="${CSS.escape(anchor)}"]`);
    if (!el) return;
    for (const old of this.feed.querySelectorAll(".commentfocus")) old.classList.remove("commentfocus");
    el.classList.add("commentfocus");
    el.scrollIntoView({ block: "center" });
    setTimeout(() => el.classList.remove("commentfocus"), 1800);
  }
}
