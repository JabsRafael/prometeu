import { fileIcon, icon } from "./icons";
import type { Change } from "./types";
import { highlight } from "./viewer";

/// Tela de mudanças: o diff de todos os arquivos do worktree empilhado num
/// scroll só, como a review de um PR. Cabeçalho de arquivo gruda no topo,
/// clique nele recolhe. Quem lê é você; quem edita é o agente — então isto
/// redesenha a cada evento do quadro, sem perder a rolagem nem o que você
/// recolheu.

const MAX_ROWS = 2500;

let signature = "";
const shut = new Set<string>();

/// Reconstrói a tela. `focus` rola até o arquivo — é o clique na lista da
/// direita. Nada muda no diff, nada é redesenhado: só a rolagem anda.
export function render(host: HTMLElement, id: string, changes: Change[], focus?: string) {
  const sig = [id, ...changes.map((c) => `${c.path}${c.patch}`)].join("");
  if (sig !== signature) {
    signature = sig;
    host.replaceChildren(...(changes.length ? changes.map(file) : [none()]));
  }
  if (focus) scrollTo(host, focus);
}

/// Recolher todos / abrir todos, no botão da barra. Mexe no conjunto e apaga a
/// assinatura para o próximo `render` desenhar de novo.
export function foldAll(paths: string[]) {
  const allShut = paths.length > 0 && paths.every((p) => shut.has(p));
  shut.clear();
  if (!allShut) for (const p of paths) shut.add(p);
  signature = "";
}

function scrollTo(host: HTMLElement, path: string) {
  const target = host.querySelector(`[data-path="${CSS.escape(path)}"]`);
  target?.scrollIntoView({ block: "start" });
}

function none(): HTMLElement {
  const el = document.createElement("div");
  el.className = "none";
  el.textContent = "worktree limpo — nada mudou desde o HEAD";
  return el;
}

/* ---------- um arquivo ---------- */

function file(change: Change): HTMLElement {
  const box = document.createElement("div");
  box.className = "dfile";
  box.dataset.path = change.path;

  const body = document.createElement("div");
  body.className = "dbody";

  const head = document.createElement("button");
  head.className = "dhead";
  head.title = change.path;
  const cut = change.path.lastIndexOf("/");
  head.innerHTML =
    `<span class="dtw"></span>${fileIcon(change.path.slice(cut + 1), 14)}` +
    `<span class="dpath"><span class="dir"></span><span class="nm"></span></span>` +
    `<span class="new"></span><span class="a"></span><span class="r"></span>`;
  const path = head.children[2];
  path.children[0].textContent = cut === -1 ? "" : change.path.slice(0, cut + 1);
  path.children[1].textContent = change.path.slice(cut + 1);
  head.children[3].textContent = change.new_file ? "novo" : "";
  head.children[4].textContent = change.added ? `+${change.added}` : "";
  head.children[5].textContent = change.removed ? `−${change.removed}` : "";

  const glyph = () => {
    head.children[0].innerHTML = icon(shut.has(change.path) ? "chevron-right" : "chevron-down", 14);
    body.hidden = shut.has(change.path);
  };
  head.addEventListener("click", () => {
    shut.has(change.path) ? shut.delete(change.path) : shut.add(change.path);
    glyph();
  });

  body.append(...lines(change));
  box.append(head, body);
  glyph();
  return box;
}

/// Sem trechos: binário, ou patch cortado no back por ser grande demais. O
/// contador de linhas já está no cabeçalho, então aqui vai só o porquê.
function lines(change: Change): HTMLElement[] {
  if (!change.patch) {
    const el = document.createElement("div");
    el.className = "dnote";
    el.textContent = "sem diff para mostrar — arquivo binário ou muito grande";
    return [el];
  }

  const all = rows(change.patch);
  const out = all.slice(0, MAX_ROWS).map((r) => row(r, change.path));
  if (all.length > MAX_ROWS) {
    const el = document.createElement("div");
    el.className = "dnote";
    el.textContent = `… ${all.length - MAX_ROWS} linhas a mais, cortadas para a tela não travar`;
    out.push(el);
  }
  return out;
}

function row(r: Row, path: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `drow ${r.kind}`;
  if (r.kind === "hunk") {
    el.innerHTML = `<span class="dno"></span><span class="dsign"></span><code></code>`;
    el.children[2].textContent = r.text;
    return el;
  }
  el.innerHTML =
    `<span class="dno"></span><span class="dsign"></span>` +
    `<code>${highlight(r.text, path)}</code>`;
  el.children[0].textContent = String(r.no);
  el.children[1].textContent = r.kind === "add" ? "+" : r.kind === "del" ? "−" : "";
  return el;
}

/* ---------- patch unificado → linhas ---------- */

type Row = { kind: "hunk" | "ctx" | "add" | "del"; no: number; text: string };

/// O número mostrado é o da linha no arquivo de agora; em linha apagada, o do
/// arquivo de antes — é o único que existe para ela.
function rows(patch: string): Row[] {
  const out: Row[] = [];
  let before = 0;
  let after = 0;
  for (const line of patch.split("\n")) {
    if (!line || line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
      if (!m) continue;
      before = Number(m[1]);
      after = Number(m[2]);
      out.push({ kind: "hunk", no: 0, text: m[3] });
      continue;
    }
    const text = line.slice(1);
    if (line[0] === "+") out.push({ kind: "add", no: after++, text });
    else if (line[0] === "-") out.push({ kind: "del", no: before++, text });
    else {
      out.push({ kind: "ctx", no: after++, text });
      before++;
    }
  }
  return out;
}
