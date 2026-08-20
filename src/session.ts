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

export function showQuestion(session: string, q: Question) {
  if (session !== current) return;
  const el = shell(q.header ? `pergunta · ${q.header}` : "pergunta", q.question);
  const options = q.options ?? [];
  liveOptions = options.length;

  const list = document.createElement("div");
  list.className = "opts";

  // O índice aqui é o mesmo que a TUI numerou: os dois leem a lista que veio
  // no payload do hook. Nada é lido da tela.
  options.forEach((opt, i) => {
    const b = document.createElement("button");
    b.className = "opt";
    b.innerHTML = `<span class="num"></span><span class="txt"><b></b><span></span></span><span class="key"></span>`;
    b.querySelector(".num")!.textContent = String(i + 1);
    b.querySelector("b")!.textContent = opt.label;
    b.querySelector(".txt span")!.textContent = opt.description ?? "";
    b.querySelector(".key")!.textContent = `^${i + 1}`;
    b.addEventListener("click", () => {
      invoke("answer_question", { session, index: i }).catch((e) => fail(String(e)));
      dismiss(el);
    });
    list.append(b);
  });

  const free = document.createElement("div");
  free.className = "free";
  free.innerHTML = `<input placeholder="Digite ou cole uma resposta…" /><button>↵</button>`;
  const input = free.querySelector("input")!;
  const send = () => {
    if (!input.value.trim()) return;
    // Texto livre entra pela opção "Type something", que fica logo depois da
    // última — daí o índice ser o número de opções + 1, calculado no Rust.
    invoke("answer_free", { session, options: options.length, text: input.value })
      .catch((e) => fail(String(e)));
    dismiss(el);
  };
  free.querySelector("button")!.addEventListener("click", send);
  input.addEventListener("keydown", (e) => e.key === "Enter" && send());

  el.append(list, free);
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
