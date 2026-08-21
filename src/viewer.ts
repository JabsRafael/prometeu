import { invoke } from "@tauri-apps/api/core";
import { fileIcon, icon } from "./icons";

/// Viewer de arquivo no centro, como o editor do Conductor: migalha com o
/// caminho, gutter com número de linha, código colorido. Só leitura — quem
/// edita é o agente; você lê, seleciona e copia.

const $ = (id: string) => document.getElementById(id)!;
let shown: { id: string; path: string; text: string } | null = null;
let request = 0;

export function init(onError: (m: string) => void) {
  $("vcopy").innerHTML = icon("copy");
  $("vcopy").addEventListener("click", () => {
    if (!shown) return;
    navigator.clipboard.writeText(shown.path).catch((e) => onError(String(e)));
  });
}

/// Desenha o arquivo. Chamado de novo a cada evento do quadro enquanto o
/// viewer está aberto, então o texto acompanha o agente editando; a rolagem
/// só é mexida quando o conteúdo mudou de verdade.
export async function show(id: string, path: string) {
  const currentRequest = ++request;
  const same = shown?.id === id && shown.path === path;
  let text: string;
  let error = "";
  try {
    text = await invoke<string>("read_file", { id, rel: path });
  } catch (e) {
    text = "";
    error = String(e);
  }
  if (currentRequest !== request) return;
  if (same && shown!.text === text && !error) return;
  shown = { id, path, text };

  const cut = path.lastIndexOf("/");
  const crumb = $("vcrumb");
  crumb.innerHTML = `${fileIcon(path.slice(cut + 1), 14)}<span class="dir"></span><span class="nm"></span>`;
  crumb.children[1].textContent = cut === -1 ? "" : path.slice(0, cut + 1);
  crumb.children[2].textContent = path.slice(cut + 1);

  const pre = $("vpre");
  const gutter = $("vgutter");
  if (error) {
    gutter.textContent = "";
    pre.innerHTML = `<span class="h-c"></span>`;
    pre.children[0].textContent = error;
    return;
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  gutter.textContent = lines.map((_, i) => i + 1).join("\n");
  pre.innerHTML = highlight(text, path);
  if (!same) $("vcode").scrollTo(0, 0);
}

export function current() {
  return shown;
}

/* ---------- highlight ---------- */

/// Um tokenizador por regex dá conta do visual: comentário, string, número,
/// símbolo/keyword-arg, método depois do ponto, palavra reservada, chamada,
/// Constante. Cobre as linguagens que aparecem nos repositórios daqui; o que
/// não tem gramática sai em texto puro.
type Lang = {
  line?: string; // comentário de linha
  block?: [string, string]; // comentário de bloco
  kw?: string;
  sym?: boolean; // :símbolo
  key?: boolean; // chave: (keyword-arg, propriedade css, chave yaml)
  tag?: boolean; // <tag>
  md?: boolean; // só título, código, negrito e link; nada de Constante amarela em prosa
};

const RB =
  "class module def end if elsif else unless while until for in do return yield begin rescue ensure raise self nil true false and or not then case when break next redo retry super lambda proc private protected public require require_relative include extend alias defined? loop";
const JS =
  "const let var function return if else for while do break continue new class extends import from export default async await try catch finally throw typeof instanceof in of this null undefined true false switch case interface type enum implements public private protected readonly static as keyof yield delete void declare namespace abstract satisfies";
const RS =
  "fn let mut pub use mod struct enum impl trait for in if else match while loop return self Self crate super as const static ref where move async await dyn type unsafe true false break continue extern";
const PY =
  "def class return if elif else for while in import from as with try except finally raise lambda pass break continue and or not is None True False yield async await self global nonlocal del assert";
const SH = "if then else elif fi for in do done while case esac function return exit export local echo set source";

const C: [string, string] = ["/*", "*/"];
const LANGS: Record<string, Lang> = {
  ruby: { line: "#", kw: RB, sym: true, key: true },
  ts: { line: "//", block: C, kw: JS },
  js: { line: "//", block: C, kw: JS },
  rust: { line: "//", block: C, kw: RS },
  py: { line: "#", kw: PY, key: true },
  sh: { line: "#", kw: SH },
  css: { block: C, key: true },
  json: { kw: "true false null" },
  yaml: { line: "#", kw: "true false null yes no", key: true },
  toml: { line: "#", kw: "true false" },
  env: { line: "#" },
  html: { block: ["<!--", "-->"], tag: true },
  md: { md: true },
};
const BY_EXT: Record<string, string> = {
  rb: "ruby", rake: "ruby", gemspec: "ruby", ru: "ruby", erb: "html",
  ts: "ts", tsx: "ts", mts: "ts", js: "js", jsx: "js", mjs: "js", cjs: "js",
  rs: "rust", py: "py", sh: "sh", zsh: "sh", bash: "sh", css: "css", json: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", html: "html", htm: "html", svg: "html", xml: "html", md: "md",
};
const BY_NAME: Record<string, string> = {
  gemfile: "ruby", rakefile: "ruby", "config.ru": "ruby", dockerfile: "sh", ".gitignore": "sh", ".dockerignore": "sh",
};

const cache = new Map<string, { re: RegExp; cls: string[] }>();

function rule(lang: Lang) {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const kw = (lang.kw ?? "").split(" ").filter(Boolean).map(esc).join("|");
  const on = (flag: unknown, cls: string, src: string): [string, string] | null => (flag ? [cls, src] : null);
  const parts = (
    lang.md
      ? [
          on(true, "k", "^#{1,6} .*$"),
          on(true, "s", "`[^`\\n]+`"),
          on(true, "t", "\\*\\*[^*\\n]+\\*\\*"),
          on(true, "f", "\\[[^\\]\\n]*\\]\\([^)\\n]*\\)"),
        ]
      : [
          on(lang.block, "c", lang.block ? `${esc(lang.block[0])}[\\s\\S]*?(?:${esc(lang.block[1])}|$(?![\\s\\S]))` : ""),
          on(lang.line, "c", `${esc(lang.line ?? "")}.*`),
          on(true, "s", "\"(?:[^\"\\\\\\n]|\\\\.)*\"?|'(?:[^'\\\\\\n]|\\\\.)*'?|`(?:[^`\\\\]|\\\\.)*`?"),
          on(lang.sym, "y", "(?<![:\\w]):[a-zA-Z_]\\w*[?!]?"),
          on(true, "n", "\\b\\d[\\w.]*\\b"),
          on(true, "f", "(?<=\\.)[a-zA-Z_]\\w*[?!]?"),
          on(kw, "k", `\\b(?:${kw})\\b`),
          on(true, "f", "\\b[a-zA-Z_]\\w*(?=\\()"),
          on(lang.key, "y", "(?<![\\w-])[a-zA-Z_-][\\w-]*:(?!:)"),
          on(true, "t", "\\b[A-Z][A-Za-z0-9_]*\\b"),
          on(lang.tag, "k", "</?[a-zA-Z][\\w-]*|/?>"),
        ]
  ).filter((p): p is [string, string] => p !== null);
  return {
    re: new RegExp(parts.map(([, src]) => `(${src})`).join("|"), "gm"),
    cls: parts.map(([cls]) => cls),
  };
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function highlight(code: string, path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const key = BY_NAME[name] ?? (name.startsWith(".env") ? "env" : BY_EXT[ext]);
  const lang = key ? LANGS[key] : null;
  if (!lang) return escHtml(code);

  let r = cache.get(key!);
  if (!r) cache.set(key!, (r = rule(lang)));

  let out = "";
  let last = 0;
  for (const m of code.matchAll(r.re)) {
    if (!m[0]) continue;
    out += escHtml(code.slice(last, m.index));
    const cls = r.cls[m.slice(1).findIndex((g) => g !== undefined)];
    out += `<span class="h-${cls}">${escHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escHtml(code.slice(last));
}
