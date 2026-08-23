import { invoke } from "@tauri-apps/api/core";
import { Term } from "./term";
import type { Question } from "./types";
import { $ } from "./util";

/// A conversa: o terminal onde o `claude` de verdade está rodando, e os cards
/// que aparecem em cima dele quando o agente precisa de você.

const term = new Term({ fontSize: 13, foreground: "#eae8e6", scrollback: 8000 });
let fail: (m: string) => void = () => {};

/// Opções da pergunta aberta, para o atalho de teclado. Zero quando não há
/// pergunta na tela, ou quando ela tem mais de uma parte — aí não existe "a"
/// opção 1.
let liveOptions = 0;

export function initTerminal(onError: (m: string) => void) {
  fail = onError;
  term.open($("term"));
  window.addEventListener("resize", () => term.refit());

  // Ctrl+1..4 responde a pergunta aberta sem tirar a mão do teclado, como no
  // seletor do próprio Claude Code. O terminal não vê essas teclas.
  term.onKey((e) => {
    if (e.type !== "keydown" || !e.ctrlKey || !liveOptions) return true;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > liveOptions) return true;
    document.querySelectorAll<HTMLElement>(".ask .opt")[n - 1]?.click();
    return false;
  });
}

export async function attach(id: string) {
  cards().replaceChildren();
  liveOptions = 0;
  await term.attach(id);
  term.focus();
}

export function detach() {
  term.detach();
  liveOptions = 0;
}

export const currentSession = () => term.current();
export const focus = () => term.focus();
export const dims = () => term.dims();

/* ---------- cards de resposta ---------- */

const cards = () => $("cards");

function shell(kind: string, title: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "ask";
  el.innerHTML = `<span class="kind"></span><h3></h3>`;
  el.querySelector(".kind")!.textContent = kind;
  el.querySelector("h3")!.textContent = title;
  cards().append(el);
  return el;
}

/// Uma resposta por pergunta, na ordem em que vieram no payload. O back traduz
/// isto em teclas — ver `keystrokes` no `socket.rs`.
type Answer = { picks: number[]; options: number; multi: boolean; free: string | null };

/// Campo de texto livre. Um por pergunta: era um só para todas, escrevendo
/// sempre em `answers[0]`, então num AskUserQuestion de duas perguntas o texto
/// ia para a primeira e as outras seguiam sem resposta nenhuma.
function freeField(onSend: (text: string) => void, submits: boolean): HTMLElement {
  const box = document.createElement("div");
  box.className = "free";
  box.innerHTML = `<input placeholder="Digite ou cole uma resposta…" /><button>↵</button>`;
  const input = box.querySelector("input")!;
  const send = () => {
    if (input.value.trim()) onSend(input.value);
  };
  box.querySelector("button")!.addEventListener("click", send);
  // Com uma pergunta só, Enter responde e envia. Com várias, ele só guarda o
  // texto naquela pergunta — enviar é o botão embaixo, depois de responder
  // todas.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    send();
    if (!submits) input.blur();
  });
  return box;
}

/// Desenha o AskUserQuestion inteiro: todas as perguntas, não só a primeira.
/// Uma pergunta de escolha única e sem irmãs continua sendo um clique só — que
/// é o caso comum e não pode ficar mais lento por causa do caso raro.
export function showQuestion(session: string, questions: Question[]) {
  if (session !== currentSession() || !questions.length) return;

  const solo = questions.length === 1 && !questions[0].multiSelect;
  const first = questions[0];
  const el = shell(
    solo && first.header ? `pergunta · ${first.header}` : "pergunta",
    solo ? first.question : `${questions.length} perguntas`,
  );

  const answers: Answer[] = questions.map((q) => ({
    picks: [],
    options: q.options?.length ?? 0,
    multi: !!q.multiSelect,
    free: null,
  }));

  const send = () => {
    invoke("answer_questions", { session, answers }).catch((e) => fail(String(e)));
    dismiss(el);
  };

  questions.forEach((q, qi) => {
    if (!solo) {
      const head = document.createElement("div");
      head.className = "qhead";
      head.innerHTML = `<span class="qtag"></span><span class="qtext"></span>`;
      head.querySelector(".qtag")!.textContent = q.header ?? `${qi + 1}`;
      head.querySelector(".qtext")!.textContent = q.question;
      el.append(head);
    }

    const list = document.createElement("div");
    list.className = "opts";

    // O índice é o mesmo que a TUI numerou: os dois leem a lista que veio no
    // payload do hook. Nada é lido da tela.
    (q.options ?? []).forEach((opt, i) => {
      const b = document.createElement("button");
      b.className = "opt";
      b.innerHTML = `<span class="num"></span><span class="txt"><b></b><span></span></span><span class="key"></span>`;
      b.querySelector(".num")!.textContent = String(i + 1);
      b.querySelector("b")!.textContent = opt.label;
      b.querySelector(".txt span")!.textContent = opt.description ?? "";
      b.querySelector(".key")!.textContent = solo ? `^${i + 1}` : "";
      b.addEventListener("click", () => {
        if (solo) {
          answers[0].picks = [i];
          return send();
        }
        // multiSelect alterna; escolha única troca. Escolher uma opção apaga o
        // texto livre daquela pergunta: as duas coisas são a mesma resposta.
        const picks = answers[qi].picks;
        if (q.multiSelect) {
          const at = picks.indexOf(i);
          at === -1 ? picks.push(i) : picks.splice(at, 1);
        } else {
          answers[qi].picks = picks[0] === i ? [] : [i];
        }
        answers[qi].free = null;
        paint(list, answers[qi].picks);
      });
      list.append(b);
    });

    el.append(list);
    el.append(
      freeField((text) => {
        answers[qi].free = text;
        if (solo) return send();
        // Texto livre é resposta: apaga a opção que estava marcada, e a linha
        // marcada some junto para a tela não dizer duas coisas.
        answers[qi].picks = [];
        paint(list, []);
      }, solo),
    );
  });

  if (!solo) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<button class="ok">Enviar</button>`;
    row.querySelector(".ok")!.addEventListener("click", send);
    el.append(row);
  }

  liveOptions = solo ? (first.options?.length ?? 0) : 0;
}

function paint(list: HTMLElement, picks: number[]) {
  [...list.children].forEach((c, i) => c.classList.toggle("picked", picks.includes(i)));
}

export function showPermission(id: number, session: string, tool: string, input: unknown) {
  if (session !== currentSession()) return;
  const el = shell("quer permissão", tool);

  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(input ?? {}, null, 2);

  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<button class="ok">Permitir</button><button class="no">Negar</button>`;
  const decide = (decision: string) => {
    invoke("decide_permission", { id, decision }).catch((e) => fail(String(e)));
    dismiss(el);
  };
  row.querySelector(".ok")!.addEventListener("click", () => decide("allow"));
  row.querySelector(".no")!.addEventListener("click", () => decide("deny"));

  el.append(pre, row);
}

/// O plano está pronto e o "Would you like to proceed?" está na TUI. Executar
/// é o dígito 1 — "switch to BYPASS PERMISSIONS", o solto de sempre. Ajustar é
/// o 3: a TUI abre a caixa de texto, e o terminal ganha o foco para você dizer
/// o que muda. Nada é lido da tela: os dígitos são os do seletor (2.1.240).
export function showPlan(session: string, plan: string) {
  if (session !== currentSession()) return;
  const el = shell("plano pronto", "Executar do jeito que está?");

  const pre = document.createElement("pre");
  pre.className = "plan";
  pre.textContent = plan.trim() || "(o plano está no terminal)";

  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<button class="ok">Executar</button><button class="outline">Ajustar no terminal</button>`;
  const key = (digit: string) => {
    invoke("pty_write", { session, data: digit }).catch((e) => fail(String(e)));
    dismiss(el);
  };
  row.querySelector(".ok")!.addEventListener("click", () => key("1"));
  row.querySelector(".outline")!.addEventListener("click", () => key("3"));

  el.append(pre, row);
}

function dismiss(el: HTMLElement) {
  el.remove();
  liveOptions = 0;
  term.focus();
}
