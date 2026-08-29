import { marked, type Tokens } from "marked";
import { diffHtml, highlight } from "./highlight";

/// O que o agente escreve é markdown, e é assim que a tela o mostra. O
/// `marked` faz a conta; aqui só o que é deste app: HTML cru que o texto
/// trouxer vira texto (o agente não desenha na nossa tela), código passa pelo
/// mesmo colorizador do viewer, e link não navega — a janela é o app, não um
/// navegador.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const safeHref = (href: string) => {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "#";
  } catch {
    return "#";
  }
};

/// O nome que o `highlight` entende, a partir do que veio depois do ```.
const LANG: Record<string, string> = {
  typescript: "ts", javascript: "js", rust: "rs", python: "py", shell: "sh", bash: "sh", zsh: "sh",
  ruby: "rb", yml: "yaml", jsonc: "json", console: "sh", text: "txt", plaintext: "txt",
};

marked.use({
  gfm: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return esc(text);
    },
    code({ text, lang }: Tokens.Code) {
      const raw = (lang ?? "").trim().split(/\s+/)[0].toLowerCase();
      if (raw === "diff" || raw === "patch") return `<pre class="code tdiff">${diffHtml(text)}</pre>\n`;
      const ext = LANG[raw] ?? raw ?? "txt";
      return `<pre class="code"><code>${highlight(text, `x.${ext || "txt"}`)}</code></pre>\n`;
    },
    link({ href, tokens }: Tokens.Link) {
      return `<a class="lnk" href="${esc(safeHref(href))}" rel="noreferrer noopener">${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      return `<span class="img">${esc(text || href)}</span>`;
    },
  },
});

export function md(src: string): string {
  return marked.parse(src, { async: false }) as string;
}
