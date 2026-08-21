import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Question } from "./types";

const term = new Terminal({
  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
  fontSize: 13,
  theme: { background: "#0e1116", foreground: "#e7ebf2", cursor: "#ff6b3d" },
  allowProposedApi: true,
  scrollback: 8000,
});
const fit = new FitAddon();
let current: string | null = null;
let fail: (m: string) => void = () => {};

/// Opções da pergunta aberta na sessão em foco, para o atalho de teclado.
let liveOptions = 0;

export function initTerminal(onError: (m: string) => void) {
  fail = onError;
  term.loadAddon(fit);
  term.open(document.getElementById("term")!);

  term.onData((data) => {
    if (current) invoke("pty_write", { session: current, data });
  });

  // Ctrl+1..4 responde a pergunta aberta sem tirar a mão do teclado, como no
  // seletor do próprio Claude Code. O terminal não vê essas teclas.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey || !liveOptions) return true;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > liveOptions) return true;
    document.querySelectorAll<HTMLElement>(".ask .opt")[n - 1]?.click();
    return false;
  });

  new ResizeObserver(() => refit()).observe(document.getElementById("term")!);
  window.addEventListener("resize", () => refit());

  const decoder = new TextDecoder("utf-8");
  listen<[string, number[]]>("pty", ({ payload: [session, bytes] }) => {
    // Outras abas seguem rodando por trás; só a aberta é desenhada.
    if (session !== current) return;
    term.write(decoder.decode(new Uint8Array(bytes), { stream: true }));
  });
}

/// Medir o terminal é o ponto frágil da tela: se a conta roda com a view ainda
/// escondida, ou antes de a barra de etapas assentar, sobram linhas e a última
/// fica cortada na borda de baixo. Daí esperar o próximo quadro e só medir
/// quando o elemento tem tamanho de verdade.
let pending = 0;
function refit(force = false) {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    const host = document.getElementById("term")!;
    if (!host.clientHeight || !host.clientWidth) return;
    const before = `${term.cols}x${term.rows}`;
    fit.fit();
    const changed = `${term.cols}x${term.rows}` !== before;
    if (current && (force || changed)) {
      invoke("pty_resize", { session: current, cols: term.cols, rows: term.rows });
    }
  });
}

/// Troca o terminal para outra sessão, redesenhando a rolagem guardada.
export async function attach(id: string) {
  current = id;
  cards().replaceChildren();
  liveOptions = 0;
  term.reset();
  const buf = await invoke<number[]>("pty_buffer", { session: id });
  term.write(new TextDecoder("utf-8").decode(new Uint8Array(buf)));
  refit(true);
  term.focus();
}

export function detach() {
  current = null;
  liveOptions = 0;
}

export function currentSession() {
  return current;
}

export function dims() {
  return { cols: term.cols, rows: term.rows };
}

/* ---------- cards de resposta ---------- */

function cards() {
  return document.getElementById("cards")!;
}

function shell(kind: string, title: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "ask";
  el.innerHTML = `<span class="kind"></span><h3></h3>`;
  el.querySelector(".kind")!.textContent = kind;
  el.querySelector("h3")!.textContent = title;
  cards().append(el);
  return el;
}

type Answer = { picks: number[]; options: number; multi: boolean; free: string | null };

/// Desenha o AskUserQuestion inteiro: todas as perguntas, não só a primeira.
/// Uma pergunta de escolha única e sem irmãs continua sendo um clique só — que
/// é o caso comum e não pode ficar mais lento por causa do caso raro.
export function showQuestion(session: string, questions: Question[]) {
  if (session !== current || !questions.length) return;

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
        // multiSelect alterna; escolha única troca.
        const picks = answers[qi].picks;
        if (q.multiSelect) {
          const at = picks.indexOf(i);
          at === -1 ? picks.push(i) : picks.splice(at, 1);
        } else {
          answers[qi].picks = picks[0] === i ? [] : [i];
        }
        [...list.children].forEach((c, ci) =>
          c.classList.toggle("picked", answers[qi].picks.includes(ci)),
        );
      });
      list.append(b);
    });

    el.append(list);
  });

  const free = document.createElement("div");
  free.className = "free";
  free.innerHTML = `<input placeholder="Digite ou cole uma resposta…" /><button>↵</button>`;
  const input = free.querySelector("input")!;
  const sendFree = () => {
    if (!input.value.trim()) return;
    // Texto livre entra pela opção "Type something", logo depois da última.
    answers[0].free = input.value;
    send();
  };
  free.querySelector("button")!.addEventListener("click", sendFree);
  input.addEventListener("keydown", (e) => e.key === "Enter" && sendFree());
  el.append(free);

  if (!solo) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<button class="ok">Enviar</button>`;
    row.querySelector(".ok")!.addEventListener("click", send);
    el.append(row);
  }

  liveOptions = solo ? (first.options?.length ?? 0) : 0;
}

export function showPermission(id: number, session: string, tool: string, input: unknown) {
  if (session !== current) return;
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

function dismiss(el: HTMLElement) {
  el.remove();
  liveOptions = 0;
  term.focus();
}
