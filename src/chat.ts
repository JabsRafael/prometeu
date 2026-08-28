import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { icon, type IconName } from "./icons";
import { fromBack, t, tn } from "./i18n";
import { diffHtml, isDiff } from "./highlight";
import { grouped, kilo, sectionTotal, type Report } from "./context";
import { md } from "./markdown";
import * as notes from "./notes";
import * as team from "./team";
import { summary, Timeline, type Ask, type Block, type Item } from "./timeline";
import type { Status } from "./types";
import { h } from "./util";

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
  /// Há time — e, portanto, notas.
  team: boolean;
};

export type Ctx = {
  say: (text: string, isError?: boolean) => void;
  info: () => Info;
};

/// Quanto de resultado de ferramenta o card mostra aberto. O resto está no
/// transcript; a tela não é o lugar de ler um arquivo de 4 mil linhas.
const RESULT_LINES = 120;

export class ChatView {
  private feed!: HTMLElement;
  private box!: HTMLElement;
  private area!: HTMLTextAreaElement;
  private ctx!: Ctx;
  private key: string | null = null;
  private remote = false;
  private tl = new Timeline();
  /// O nó de cada item, pelo índice no `Timeline`.
  private nodes: HTMLElement[] = [];
  /// O que ainda não fechou uma linha, na conversa de um colega: os bytes
  /// chegam em pedaços, e um pedaço pode cortar um JSON no meio.
  private partial = "";
  private decoder = new TextDecoder("utf-8");
  private mode: "agent" | "note" = "agent";
  private feedback: string | null = null;
  /// Itens que mudaram desde o último quadro. O stream manda uma linha por
  /// token; redesenhar a cada uma trava a tela — um quadro por vez basta.
  private dirty = new Set<number>();
  private raf = 0;
  private working = h("div", "working", "<i></i><i></i><i></i><span class=\"wlabel\"></span>");
  /// A fala guardada, esperando o setup: fica na tela como se tivesse ido,
  /// com o aviso de que ainda não foi.
  private waiting = h("div", "turn user wait", `<div class="bubble"></div><div class="working"><i></i><i></i><i></i><span class="wlabel"></span></div>`);

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
    team.onChange(() => {
      if (this.key) this.paintNotes();
      this.paintComposer();
    });
    // Link no texto do agente não navega: a janela é o app.
    this.feed.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a");
      if (a) e.preventDefault();
    });
    document.addEventListener("selectionchange", () => this.paintQuoteButton());
  }

  /* ---------- ligar e desligar ---------- */

  /// Uma conversa daqui: a rolagem que o back guardou, e daí em diante as
  /// linhas ao vivo.
  async attach(key: string) {
    this.key = key;
    this.remote = false;
    this.reset();
    const text = await invoke<string>("chat_buffer", { session: key });
    if (this.key !== key) return;
    this.tl.load(text);
    this.renderAll();
  }

  /// A conversa de um colega: as linhas que vieram dele. Daqui em diante os
  /// bytes chegam por `remoteWrite`.
  attachRemote(key: string, bytes: Uint8Array) {
    this.key = key;
    this.remote = true;
    this.reset();
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
    this.key = null;
    this.remote = false;
    this.reset();
    this.paintComposer();
  }

  private reset() {
    this.tl = new Timeline();
    this.nodes = [];
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
    for (const i of [...this.dirty].sort((a, b) => a - b)) this.renderOne(i);
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

  private renderAll() {
    this.nodes = [];
    this.feed.replaceChildren();
    if (!this.tl.items.length) this.feed.append(h("div", "nohint", t("chat.empty")));
    for (let i = 0; i < this.tl.items.length; i++) this.renderOne(i);
    this.paintNotes();
    this.paintWorking();
    this.paintComposer();
    this.feed.scrollTop = this.feed.scrollHeight;
  }

  private renderOne(i: number) {
    const item = this.tl.items[i];
    const old = this.nodes[i];
    // Mensagem chegando letra a letra: mexe no nó que está lá, em vez de
    // trocá-lo. Trocar o nó a cada quadro é o que dava o tremor — e apagava a
    // seleção de quem estava lendo.
    if (old && item.kind === "assistant" && old.classList.contains("bot") && this.patch(old, item)) return;
    const node = this.render(item, i);
    node.dataset.i = String(i);
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
    this.nodes[i] = node;
  }

  private render(item: Item, i: number): HTMLElement {
    switch (item.kind) {
      case "user": {
        const el = h("div", "turn user", `<div class="bubble"></div>`);
        (el.firstElementChild as HTMLElement).textContent = item.text;
        return el;
      }
      case "assistant": {
        const el = h("div", "turn bot" + (item.streaming ? " live" : ""));
        const last = item.blocks.length - 1;
        item.blocks.forEach((block, k) => {
          if (block) el.append(this.block(block, item.streaming && k === last));
        });
        return el;
      }
      case "ask":
        return this.askCard(item, i);
      case "result": {
        const el = h("div", "sys err");
        el.textContent = item.text || t("chat.result.error");
        return el;
      }
      case "context":
        return contextPanel(item.report);
      case "system": {
        if (item.what === "summary") {
          // O resumo com que o agente continua depois de compactar: é dele,
          // não da pessoa — e é longo. Fica dobrado, como o pensamento.
          const el = h("details", "think summary", `<summary></summary><div class="md"></div>`);
          el.querySelector("summary")!.textContent = t("chat.summary");
          (el.lastElementChild as HTMLElement).innerHTML = md(item.text);
          return el;
        }
        const el = h("div", "sys" + (item.error ? " err" : ""));
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

  /// Uma mensagem já na tela mudou. Bloco por bloco: o que é do mesmo tipo é
  /// atualizado no lugar, o que é novo entra no fim. `false` é "não deu, troca
  /// o nó inteiro" — um bloco mudou de tipo, o que não acontece no stream.
  private patch(el: HTMLElement, item: Extract<Item, { kind: "assistant" }>): boolean {
    const last = item.blocks.length - 1;
    for (let k = 0; k <= last; k++) {
      const block = item.blocks[k];
      if (!block) continue;
      const live = item.streaming && k === last;
      const node = el.children[k] as HTMLElement | undefined;
      if (!node) {
        el.append(this.block(block, live));
        continue;
      }
      if (node.dataset.kind !== block.kind) return false;
      if (block.kind === "text") {
        node.innerHTML = md(block.text);
        node.classList.toggle("typing", live);
      } else if (block.kind === "thinking") {
        node.querySelector("summary")!.textContent = t(live ? "chat.thinking" : "chat.thought");
        (node.lastElementChild as HTMLElement).textContent = block.text;
        node.classList.toggle("live", live);
        node.classList.toggle("bare", !block.text);
      } else {
        // Ferramenta: o card muda de estado (rodou, deu erro) — refeito, mas
        // aberto continua aberto.
        const fresh = this.block(block, live);
        if (node.classList.contains("open")) fresh.classList.add("open");
        node.replaceWith(fresh);
      }
    }
    el.classList.toggle("live", item.streaming);
    return true;
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
      const el = h("details", "think" + (live ? " live" : "") + (block.text ? "" : " bare"), `<summary></summary><div></div>`);
      el.dataset.kind = "thinking";
      el.querySelector("summary")!.textContent = t(live ? "chat.thinking" : "chat.thought");
      (el.lastElementChild as HTMLElement).textContent = block.text;
      return el;
    }
    // Ferramenta: uma linha fechada, e o que entrou e saiu quando aberta.
    const running = !block.done || block.background;
    const el = h("div", "tool" + (running ? " run" : block.error ? " bad" : " ok"));
    el.dataset.kind = "tool";
    el.dataset.tool = block.id;
    const head = h("button", "thead", `<span class="tic">${icon(toolIcon(block.name), 14)}</span><b></b><span class="sum"></span><span class="bgtag"></span><span class="st"></span>`);
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
    } else {
      body.append(inputView(block.name, block.input));
      if (block.result !== null) {
        const out = h("pre", "tout" + (block.error ? " bad" : ""));
        // Um diff que a ferramenta devolveu (o `git diff` no Bash) se lê
        // colorido, como o do Edit.
        if (!block.error && isDiff(block.result)) {
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
      const el = h("div", "sys done", `${icon("check", 12)}<span></span>`);
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
    const fb = h("div", "fb", `<textarea rows="3"></textarea><div class="row"><span class="spacer"></span><button class="pri md"></button></div>`);
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
          const b = h("button", "qtab" + (i === active ? " on" : "") + (has(q) ? " done" : ""), `<span></span>${icon("check", 11)}`);
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
        const b = h("button", "opt" + (on ? " on" : ""), `<b></b><span></span>`);
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
    for (const i of this.tl.answer(ask.id)) this.renderOne(i);
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
        <button class="ico sm at" hidden></button>
        <button class="outline md quotesel" hidden></button>
        <span class="hint"></span>
        <span class="spacer"></span>
        <button class="ghost md stop" hidden></button>
        <button class="pri md send"></button>
      </div>`;
    this.area = this.box.querySelector("textarea")!;
    const q = (sel: string) => this.box.querySelector<HTMLElement>(sel)!;
    q(".mode[data-mode=agent]").textContent = t("chat.mode.agent");
    q(".mode[data-mode=note]").textContent = t("chat.mode.note");
    q(".at").innerHTML = icon("at-sign", 13);
    q(".at").title = t("notes.mention");
    q(".quotesel").innerHTML = `${icon("message-square", 12)}<span></span>`;
    q(".quotesel span").textContent = t("notes.quoteSelection");
    q(".quotesel").title = t("notes.quoteSelection.title");
    q(".stop").innerHTML = `${icon("square", 12)}<span></span>`;
    q(".stop span").textContent = t("chat.stop");
    q(".send").textContent = t("chat.send");

    for (const b of this.box.querySelectorAll<HTMLElement>(".mode")) {
      b.addEventListener("click", () => this.setMode(b.dataset.mode as "agent" | "note"));
    }
    q(".at").addEventListener("click", () => notes.pickMention(this.area, () => this.keep()));
    q(".quotesel").addEventListener("click", () => this.quoteSelection());
    q(".stop").addEventListener("click", () => this.interrupt());
    q(".send").addEventListener("click", () => this.send());

    this.area.addEventListener("input", () => {
      this.keep();
      this.grow();
    });
    this.area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      } else if (e.key === "Escape" && this.tl.busy && !this.area.value) {
        e.preventDefault();
        this.interrupt();
      } else if (e.key === "@" && this.mode === "note") {
        e.preventDefault();
        notes.pickMention(this.area, () => this.keep());
      }
    });
  }

  /// O rascunho da nota sobrevive a trocar de aba; o da fala, não — a fala é
  /// da aba, e a aba é o processo.
  private keep() {
    const ws = this.ctx.info().workspace;
    if (this.mode === "note" && ws) notes.draftOf(ws).text = this.area.value;
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
    this.mode = mode;
    this.area.value = mode === "note" && ws ? notes.draftOf(ws).text : "";
    this.grow();
    this.paintComposer();
    this.area.focus();
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
      try {
        team.addNote(info.workspace, text, notes.mentionsIn(text), draft.quote);
      } catch (e) {
        return this.ctx.say(fromBack(e), true);
      }
      notes.dropDraft(info.workspace);
      this.area.value = "";
      this.grow();
      this.paintComposer();
      return;
    }
    if (info.remote && !info.remote.online) return this.ctx.say(t("err.team.offline"), true);
    if (this.remote) team.write(text);
    else invoke("chat_send", { session: this.key, text }).catch((e) => this.ctx.say(fromBack(e), true));
    this.area.value = "";
    this.grow();
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
    q(".send").textContent = t(note ? "notes.send" : "chat.send");

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
      if (at === -1 || !this.nodes[at]) this.feed.append(card);
      else this.nodes[at].before(card);
    }
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

/* ---------- pedaços ---------- */

/// O input de uma ferramenta, legível: chave por chave, strings como vieram
/// (é o comando, o caminho, o texto), o resto em JSON.
function inputView(name: string, input: unknown): HTMLElement {
  const box = h("div", "tin");
  const i = (input ?? {}) as Record<string, unknown>;
  const keys = Object.keys(i).filter((k) => k !== "description");
  if (name === "Edit" && typeof i.old_string === "string" && typeof i.new_string === "string") {
    const diff = h("pre", "tdiff");
    diff.append(
      ...i.old_string.split("\n").map((l) => Object.assign(h("span", "del"), { textContent: `- ${l}\n` })),
      ...i.new_string.split("\n").map((l) => Object.assign(h("span", "add"), { textContent: `+ ${l}\n` })),
    );
    box.append(Object.assign(h("div", "tk"), { textContent: String(i.file_path ?? "") }), diff);
    return box;
  }
  for (const k of keys) {
    const v = i[k];
    const row = h("div", "trow", `<span class="tk"></span><pre></pre>`);
    row.querySelector(".tk")!.textContent = k;
    row.querySelector("pre")!.textContent = capLines(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    box.append(row);
  }
  return box;
}

/// O `/context` desenhado: quanto da janela está em uso, dividido por
/// categoria numa barra e em linhas; e cada seção do relatório (ferramentas
/// MCP, skills, memória) dobrada, com o total — e, quando é uma lista
/// comprida, agrupada pelo servidor ou origem, porque 250 linhas de nomes de
/// ferramenta não são para ler.
const CTX_COLORS = ["#ff6b3d", "#f5a623", "#e3c84a", "#7cc576", "#4fb3bf", "#5b8def", "#9b6bd6", "#d66bb0", "#8a8a8a"];

function contextPanel(r: Report): HTMLElement {
  const el = h("div", "ctx");
  const head = h("div", "ctxhead", `<b></b><span class="model"></span><span class="use"></span>`);
  head.querySelector("b")!.textContent = t("chat.ctx.title");
  head.querySelector(".model")!.textContent = r.model;
  head.querySelector(".use")!.textContent = `${r.used} / ${r.total} · ${t("chat.ctx.used", { pct: r.pct })}`;
  el.append(head);

  const used = r.categories.filter((c) => !/^free space$/i.test(c.name));
  const free = r.categories.find((c) => /^free space$/i.test(c.name));
  const sum = used.reduce((a, c) => a + c.n, 0) || 1;
  const bar = h("div", "ctxbar");
  used.forEach((c, i) => {
    const seg = h("i", "");
    seg.style.width = `${(c.n / sum) * 100}%`;
    seg.style.background = CTX_COLORS[i % CTX_COLORS.length];
    seg.title = `${c.name} · ${c.tokens}`;
    bar.append(seg);
  });
  el.append(bar);
  const rows = h("div", "ctxrows");
  used.forEach((c, i) => {
    const row = h("div", "ctxrow", `<i class="dot"></i><span class="name"></span><span class="n"></span><span class="pct"></span>`);
    (row.querySelector(".dot") as HTMLElement).style.background = CTX_COLORS[i % CTX_COLORS.length];
    row.querySelector(".name")!.textContent = c.name;
    row.querySelector(".n")!.textContent = c.tokens;
    row.querySelector(".pct")!.textContent = `${c.pct}%`;
    rows.append(row);
  });
  if (free) {
    const row = h("div", "ctxrow free", `<i class="dot"></i><span class="name"></span><span class="n"></span><span class="pct"></span>`);
    row.querySelector(".name")!.textContent = t("chat.ctx.free");
    row.querySelector(".n")!.textContent = free.tokens;
    row.querySelector(".pct")!.textContent = `${free.pct}%`;
    rows.append(row);
  }
  el.append(rows);

  for (const s of r.sections) {
    const sec = h("details", "ctxsec", `<summary><span class="title"></span><span class="count"></span><span class="n"></span></summary>`);
    sec.querySelector(".title")!.textContent = s.title;
    sec.querySelector(".count")!.textContent = String(s.rows.length);
    sec.querySelector(".n")!.textContent = kilo(sectionTotal(s));
    const groups = grouped(s);
    if (groups) {
      for (const g of groups) {
        const grp = h("details", "ctxgrp", `<summary><span class="title"></span><span class="count"></span><span class="n"></span></summary>`);
        grp.querySelector(".title")!.textContent = g.name;
        grp.querySelector(".count")!.textContent = String(g.rows.length);
        grp.querySelector(".n")!.textContent = kilo(g.n);
        grp.append(contextTable(g.rows.map((row) => [row[0] ?? "", row[2] ?? ""])));
        sec.append(grp);
      }
    } else {
      sec.append(contextTable(s.rows));
    }
    el.append(sec);
  }
  return el;
}

function contextTable(rows: string[][]): HTMLElement {
  const table = h("div", "ctxtable");
  for (const row of rows) {
    const line = h("div", "ctxline");
    row.forEach((cell, i) => {
      const span = h("span", i === row.length - 1 ? "n" : i === 0 ? "name" : "src");
      span.textContent = cell;
      line.append(span);
    });
    table.append(line);
  }
  return table;
}

function capLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= RESULT_LINES) return text;
  return lines.slice(0, RESULT_LINES).join("\n") + "\n" + t("chat.more", { n: lines.length - RESULT_LINES });
}

function toolIcon(name: string): IconName {
  switch (name) {
    case "Read":
    case "Glob":
    case "Grep":
      return "search";
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return "pencil";
    case "Bash":
      return "terminal";
    case "Task":
    case "Agent":
      return "users";
    case "ExitPlanMode":
    case "EnterPlanMode":
      return "map";
    case "AskUserQuestion":
      return "message-square";
    case "WebFetch":
    case "WebSearch":
      return "globe";
    default:
      return "sparkles";
  }
}

/// O nome da ferramenta como a pessoa a lê. MCP vem `mcp__servidor__tool`.
function toolLabel(name: string): string {
  if (name.startsWith("mcp__")) return name.split("__").slice(1).join(" · ");
  return name;
}
