import changelog from "../CHANGELOG.md?raw";
import { getVersion } from "@tauri-apps/api/app";
import { icon } from "./icons";
import { current as locale, t, type Key } from "./i18n";
import { md } from "./markdown";
import { h, template } from "./util";

/// O que mudou no app, dentro do app. Até aqui a única forma de saber era abrir
/// a página de releases no navegador — e ninguém abre.
///
/// A fonte é o `CHANGELOG.md` deste repositório, o mesmo arquivo de onde o CI
/// tira o corpo de cada release. Ele entra no bundle como texto (`?raw`), então
/// a lista existe sem rede, sem API do GitHub e sem depender de ter atualizado
/// pelo app — quem instalou pelo `.dmg` vê a mesma coisa. Em troca, ele só
/// conta até a versão instalada, que é exatamente o que se quer saber aqui.
///
/// Aparece em dois momentos: sozinho, uma vez, quando o app abre numa versão
/// mais nova do que a última que você viu; e em Configurações, sempre, com o
/// histórico inteiro.

export type Release = { version: string; date: string; body: string };

/// A versão instalada. Sem ela não dá para saber o que é novidade, então tudo
/// que a usa espera o `init`.
let version = "";

/// Onde fica a última versão cujas novidades você já viu. Neste Mac e em mais
/// lugar nenhum, como o idioma.
const KEY = "prometeu:novidades";
const seen = () => localStorage.getItem(KEY);
const markSeen = (v: string) => localStorage.setItem(KEY, v);

/* ---------- ler o changelog ---------- */

/// O cabeçalho de uma versão no arquivo do git-cliff: `## [0.4.8] - 2026-08-31`.
const HEAD = /^## \[(\d[^\]]*)\](?:\s*-\s*(\S+))?\s*$/;

export function parse(src: string): Release[] {
  const out: Release[] = [];
  let at: Release | null = null;
  for (const line of src.split("\n")) {
    const head = HEAD.exec(line);
    if (head) {
      at = { version: head[1], date: head[2] ?? "", body: "" };
      out.push(at);
    } else if (at) {
      at.body += `${line}\n`;
    }
  }
  // O preâmbulo do arquivo não é versão nenhuma, e versão sem corpo não tem o
  // que mostrar.
  return out.map((r) => ({ ...r, body: r.body.trim() })).filter((r) => r.body);
}

/// Qual das duas é a mais nova. Só as três partes do número: no 0.x não existe
/// pré-lançamento, e o que vier depois de um `-` não muda a ordem de nada que
/// esteja neste arquivo.
export function cmp(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < 3; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/// O que contar agora: as versões que saíram depois da última que você viu, até
/// a que está instalada.
///
/// Sem nada guardado — instalação nova, ou a primeira vez que o app tem esta
/// tela — mostra só a versão de agora. O histórico inteiro na cara de quem
/// acabou de instalar seria uma parede; quem quiser está em Configurações.
export function unseen(all: Release[], current: string, from: string | null): Release[] {
  const upTo = all.filter((r) => cmp(r.version, current) <= 0);
  if (!from) return upTo.slice(0, 1);
  return upTo.filter((r) => cmp(r.version, from) > 0);
}

/// Os títulos que o git-cliff escreve em português (`cliff.toml`). O que está
/// escrito nos commits é conteúdo e fica como está — estes três são tela, e a
/// tela fala o idioma de quem lê.
const SECTIONS: Record<string, Key> = {
  Novidades: "news.sec.feat",
  Correções: "news.sec.fix",
  Desempenho: "news.sec.perf",
  Revertido: "news.sec.revert",
  Outros: "news.sec.other",
};

export function localize(body: string): string {
  return body.replace(/^### (.+)$/gm, (line, name: string) => {
    const key = SECTIONS[name.trim()];
    return key ? `### ${t(key)}` : line;
  });
}

/// Tudo que este bundle sabe contar, da mais nova para a mais velha.
export const all = (): Release[] =>
  parse(changelog).filter((r) => !version || cmp(r.version, version) <= 0);

/* ---------- a folha ---------- */

/// A data como quem lê. Data quebrada não vira "Invalid Date" na tela: some, e
/// a versão continua lá.
function when(date: string): string {
  const at = new Date(`${date}T00:00:00`);
  if (!date || Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
}

export function openNews(releases: Release[], sub: string) {
  const veil = document.getElementById("veil")!;
  const sheet = h("div", "sheet news");
  sheet.append(
    template(
      "div",
      "sheettop",
      `<span class="who"><b></b></span><span class="spacer"></span><span class="sub"></span>`,
    ),
  );
  sheet.querySelector(".sheettop b")!.textContent = t("news.title");
  sheet.querySelector(".sheettop .sub")!.textContent = sub;

  const list = h("div", "newslist");
  if (!releases.length) list.append(h("div", "newsempty", t("news.empty")));
  for (const rel of releases) {
    const box = h("div", "newsrel");
    const head = template("div", "newsver", `<b></b><span></span>`);
    head.children[0].textContent = `v${rel.version}`;
    head.children[1].textContent = when(rel.date);
    // O corpo é markdown gerado pelo nosso CI, mas passa pelo mesmo `md` da
    // conversa: HTML cru vira texto e link nenhum navega.
    box.append(head, template("div", "md", md(localize(rel.body))));
    list.append(box);
  }
  sheet.append(list);

  const bar = template("div", "sheetbar", `<span class="spacer"></span>`);
  const close = h("button", "pri md", t("news.close")) as HTMLButtonElement;
  bar.append(close);
  sheet.append(bar);

  const hide = () => {
    veil.replaceChildren();
    veil.hidden = true;
    window.removeEventListener("keydown", key);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") hide();
  };
  close.addEventListener("click", hide);
  window.addEventListener("keydown", key);

  veil.replaceChildren(sheet);
  veil.hidden = false;
  close.focus();
}

/// As notas de uma versão que ainda não está aqui: é o que o updater tem em
/// mãos quando encontra uma atualização, antes de baixar.
export function openNotes(next: string, body: string) {
  openNews([{ version: next, date: "", body }], t("news.sub.next", { version: `v${next}` }));
}

/* ---------- os dois lugares ---------- */

/// A linha de Configurações: o histórico inteiro, sempre à mão.
export function settingsRow(): HTMLElement {
  const row = template(
    "div",
    "setrow",
    `<span class="glyph">${icon("sparkles", 18)}</span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".txt b")!.textContent = t("settings.news");
  row.querySelector(".txt span")!.textContent = t("settings.news.body");
  const btn = h("button", "outline md", t("settings.news.open")) as HTMLButtonElement;
  btn.addEventListener("click", () =>
    openNews(all(), t("news.sub.app", { version: version ? `v${version}` : "" })),
  );
  row.querySelector(".act")!.append(btn);
  return row;
}

/// No boot: se o app abriu numa versão mais nova do que a última que você viu,
/// conte o que entrou. Uma vez por versão.
///
/// A versão é marcada como vista ao abrir a folha, e não ao fechá-la: fechar
/// tem mais de um caminho (o botão, o Esc, o Esc do app), e uma folha que
/// volta amanhã porque você a fechou "errado" é pior do que uma que você não
/// leu.
export async function init() {
  version = await getVersion();
  const fresh = unseen(all(), version, seen());
  markSeen(version);
  if (fresh.length) openNews(fresh, t("news.sub.fresh", { version: `v${version}` }));
}
