import { fileIcon, icon } from "./icons";
import { t, tn } from "./i18n";
import type { Change, RepoDiff } from "./types";
import { highlight } from "./highlight";

/// Tela de mudanças: o diff de todos os arquivos do workspace empilhado num
/// scroll só, como a review de um PR. Cabeçalho de arquivo gruda no topo,
/// clique nele recolhe. Com mais de um repositório, cada um é uma seção com
/// cabeçalho próprio, grudado acima do de arquivo — histórico separado é fato
/// do git, e a tela só o agrupa. Quem lê é você; quem edita é o agente — então
/// isto redesenha a cada evento do quadro, sem perder a rolagem nem o que você
/// recolheu.

const MAX_ROWS = 2500;

let signature = "";
const shut = new Set<string>();
const shutRepos = new Set<string>();

/// A chave de um arquivo na tela: o repositório na frente, porque dois repos
/// podem ter um `README.md` cada.
export const key = (repo: string, path: string) => `${repo}/${path}`;

export const keys = (repos: RepoDiff[]) => repos.flatMap((r) => r.files.map((f) => key(r.name, f.path)));

export const sum = (files: Change[], of: "added" | "removed") => files.reduce((n, c) => n + c[of], 0);

type View = {
  id: string;
  repos: RepoDiff[];
  /// Rola até o arquivo — é o clique na lista da direita. Nada muda no diff,
  /// nada é redesenhado: só a rolagem anda.
  focus?: string;
  /// O que dizer quando não há arquivo nenhum.
  empty: string;
  /// Você marcou um arquivo como visto: a lista da direita e a aba precisam
  /// saber, e quem as desenha é quem chamou.
  onSeen: () => void;
};

/// Reconstrói a tela — só quando algum patch mudou de verdade.
export function render(host: HTMLElement, view: View) {
  const { id, repos } = view;
  const sig = [id, ...repos.map((r) => r.name + r.files.map((c) => `${c.path}${c.patch}`).join(""))].join("\0");
  if (sig !== signature) {
    signature = sig;
    const some = repos.filter((r) => r.files.length);
    const multi = repos.length > 1;
    host.replaceChildren(...(some.length ? some.flatMap((r) => (multi ? [group(view, r)] : files(view, r))) : [none(view.empty)]));
  }
  if (view.focus) scrollTo(host, view.focus);
}

/// Apaga a assinatura: o próximo `render` desenha de novo mesmo sem patch
/// novo. É o que "visto em tudo" precisa — o que muda é o estado, não o diff.
export function invalidate() {
  signature = "";
}

/// Recolher todos / abrir todos, no botão da barra. Mexe no conjunto e apaga a
/// assinatura para o próximo `render` desenhar de novo.
export function foldAll(all: string[]) {
  const allShut = all.length > 0 && all.every((k) => shut.has(k));
  shut.clear();
  if (!allShut) for (const k of all) shut.add(k);
  signature = "";
}

function scrollTo(host: HTMLElement, k: string) {
  const target = host.querySelector(`[data-key="${CSS.escape(k)}"]`);
  target?.scrollIntoView({ block: "start" });
}

function none(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "none";
  el.textContent = text;
  return el;
}

/* ---------- visto ---------- */

/// O que você já leu, por workspace: a chave do arquivo e a marca do patch de
/// quando você leu. Patch que muda depois disso desmarca sozinho — é o que faz
/// "visto" servir para acompanhar o agente, e não só para arrumar a lista.
/// Fica no localStorage: fechar o app não pode apagar o que você já leu.
const seenOf = new Map<string, Record<string, string>>();
const seenKey = (id: string) => `prometheus:visto:${id}`;

function seenMap(id: string): Record<string, string> {
  let m = seenOf.get(id);
  if (!m) {
    try {
      m = JSON.parse(localStorage.getItem(seenKey(id)) ?? "{}") as Record<string, string>;
    } catch {
      m = {};
    }
    seenOf.set(id, m);
  }
  return m;
}

function saveSeen(id: string) {
  const m = seenMap(id);
  if (Object.keys(m).length) localStorage.setItem(seenKey(id), JSON.stringify(m));
  else localStorage.removeItem(seenKey(id));
}

/// A marca de um patch: curta, para não guardar o diff inteiro de novo. Um
/// patch pode ter centenas de KB e a pergunta chega a cada redesenho, então a
/// conta fica guardada por objeto — o back manda objetos novos quando o diff
/// muda, e aí a conta é refeita.
const stamps = new WeakMap<Change, string>();
function stamp(c: Change): string {
  let s = stamps.get(c);
  if (s === undefined) {
    let h = 5381;
    for (let i = 0; i < c.patch.length; i++) h = (Math.imul(h, 33) ^ c.patch.charCodeAt(i)) >>> 0;
    s = `${h.toString(36)}:${c.added}:${c.removed}`;
    stamps.set(c, s);
  }
  return s;
}

export const isSeen = (id: string, repo: string, c: Change) => seenMap(id)[key(repo, c.path)] === stamp(c);

export function setSeen(id: string, repo: string, c: Change, on: boolean) {
  const m = seenMap(id);
  if (on) m[key(repo, c.path)] = stamp(c);
  else delete m[key(repo, c.path)];
  saveSeen(id);
}

export function seeAll(id: string, repos: RepoDiff[]) {
  const m = seenMap(id);
  for (const r of repos) for (const c of r.files) m[key(r.name, c.path)] = stamp(c);
  saveSeen(id);
}

export const unseen = (id: string, repos: RepoDiff[]) =>
  repos.reduce((n, r) => n + r.files.filter((c) => !isSeen(id, r.name, c)).length, 0);

/// Workspace que saiu do quadro leva junto o que você tinha lido nele.
export function pruneSeen(alive: Set<string>) {
  const gone: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("prometheus:visto:") && !alive.has(k.slice("prometheus:visto:".length))) gone.push(k);
  }
  for (const k of gone) {
    localStorage.removeItem(k);
    seenOf.delete(k.slice("prometheus:visto:".length));
  }
}

/* ---------- um repositório ---------- */

/// A seção de um repositório: cabeçalho grudado no topo com o nome, de onde a
/// branch saiu e a soma, e os arquivos dele embaixo. Clique no cabeçalho
/// recolhe o repo inteiro.
function group(view: View, r: RepoDiff): HTMLElement {
  const box = document.createElement("div");
  box.className = "drepo";

  const head = document.createElement("button");
  head.className = "drhead";
  head.title = r.name;
  head.innerHTML =
    `<span class="dtw"></span>${icon("folder", 14)}<span class="nm"></span>` +
    `<span class="cnt"></span><span class="a"></span><span class="r"></span>`;
  head.children[2].textContent = r.name;
  const ahead = r.base ? tn(r.ahead, "diff.ahead", { base: r.base }) : tn(r.ahead, "diff.commits");
  head.children[3].textContent = `${ahead} · ${tn(r.files.length, "diff.files")}`;
  const added = sum(r.files, "added");
  const removed = sum(r.files, "removed");
  head.children[4].textContent = added ? `+${added}` : "";
  head.children[5].textContent = removed ? `−${removed}` : "";

  const body = document.createElement("div");
  body.append(...files(view, r));

  const k = `${view.id}/${r.name}`;
  const glyph = () => {
    head.children[0].innerHTML = icon(shutRepos.has(k) ? "chevron-right" : "chevron-down", 14);
    body.hidden = shutRepos.has(k);
  };
  head.addEventListener("click", () => {
    shutRepos.has(k) ? shutRepos.delete(k) : shutRepos.add(k);
    glyph();
  });
  glyph();
  box.append(head, body);
  return box;
}

const files = (view: View, r: RepoDiff) => r.files.map((c) => file(view, r.name, c));

/* ---------- um arquivo ---------- */

function file(view: View, repo: string, change: Change): HTMLElement {
  const k = key(repo, change.path);
  const box = document.createElement("div");
  box.className = "dfile";
  box.dataset.key = k;

  const body = document.createElement("div");
  body.className = "dbody";

  const head = document.createElement("button");
  head.className = "dhead";
  head.title = change.path;
  const cut = change.path.lastIndexOf("/");
  head.innerHTML =
    `<span class="dtw"></span>${fileIcon(change.path.slice(cut + 1), 14)}` +
    `<span class="dpath"><span class="dir"></span><span class="nm"></span></span>` +
    `<span class="new"></span><span class="dot"></span><span class="a"></span><span class="r"></span>` +
    `<span class="dseen" role="button"></span>`;
  const path = head.children[2];
  path.children[0].textContent = cut === -1 ? "" : change.path.slice(0, cut + 1);
  path.children[1].textContent = change.path.slice(cut + 1);
  head.children[3].textContent = change.new_file ? t("diff.new") : change.deleted ? t("diff.deleted") : "";
  const dot = head.children[4] as HTMLElement;
  dot.hidden = !change.dirty;
  dot.title = t("diff.dirty");
  head.children[5].textContent = change.added ? `+${change.added}` : "";
  head.children[6].textContent = change.removed ? `−${change.removed}` : "";

  // Visto: o check da ponta. Clique nele não recolhe o arquivo.
  const seen = head.children[7] as HTMLElement;
  seen.innerHTML = icon("check", 13);
  const paintSeen = () => {
    const on = isSeen(view.id, repo, change);
    box.classList.toggle("seen", on);
    seen.title = t(on ? "diff.seen" : "diff.unseen");
  };
  seen.addEventListener("click", (e) => {
    e.stopPropagation();
    setSeen(view.id, repo, change, !isSeen(view.id, repo, change));
    paintSeen();
    view.onSeen();
  });
  paintSeen();

  const glyph = () => {
    head.children[0].innerHTML = icon(shut.has(k) ? "chevron-right" : "chevron-down", 14);
    body.hidden = shut.has(k);
  };
  head.addEventListener("click", () => {
    shut.has(k) ? shut.delete(k) : shut.add(k);
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
    el.textContent = t("diff.binary");
    return [el];
  }

  const all = rows(change.patch);
  const out = all.slice(0, MAX_ROWS).map((r) => row(r, change.path));
  if (all.length > MAX_ROWS) {
    const el = document.createElement("div");
    el.className = "dnote";
    el.textContent = t("diff.truncated", { n: all.length - MAX_ROWS });
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

export type Row = { kind: "hunk" | "ctx" | "add" | "del"; no: number; text: string };

/// O número mostrado é o da linha no arquivo de agora; em linha apagada, o do
/// arquivo de antes — é o único que existe para ela.
///
/// Exportada para o teste: é a única parte desta tela que é conta, e o que ela
/// erra sai como número de linha errado — que ninguém confere de olho.
export function rows(patch: string): Row[] {
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
