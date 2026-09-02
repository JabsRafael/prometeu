import { invoke } from "./ipc";
import { icon } from "./icons";
import { fromBack, t, tn, type Key } from "./i18n";
import * as menu from "./menu";
import type { McpCheck, McpServer, McpStep } from "./types";
import { $, h, template } from "./util";

/// O hub de MCP na tela: a lista de servidores em Configurações, e o seletor
/// que o lançador e a conversa abrem.
///
/// O que um servidor de MCP é, e por que a escolha existe, está em
/// `src-tauri/src/mcp.rs`. Aqui só o que é tela: o cadastro fica no back (o
/// arquivo tem chave de API dentro), esta é a cópia que a janela usa para
/// desenhar, e ela é refeita a cada gravação — o back devolve a lista inteira
/// depois de gravar, então nunca há duas verdades.
///
/// O seletor é o mesmo em três lugares (lançador, conversa, e o que vier
/// depois): um menu de marcar, aberto no botão. Marcar fecha o menu e abre de
/// novo — o menu do app é de uma escolha só, e reabrir custa nada numa lista
/// de meia dúzia de linhas.

let hub: McpServer[] = [];
/// Em quais servidores já se entrou pelo OAuth. Vem do back — o token nunca
/// chega aqui, só o nome de quem tem um.
let logins: string[] = [];
let loaded = false;
const watchers = new Set<() => void>();

/// A lista que a tela tem. Vazia antes de carregar — os seletores desenham
/// vazio e se refazem quando ela chega.
export const list = () => hub;

export const onChange = (fn: () => void) => {
  watchers.add(fn);
  return () => watchers.delete(fn);
};

function announce() {
  for (const fn of watchers) fn();
}

/// Carrega uma vez por sessão do app. O cadastro só muda por aqui, e quem o
/// muda já recebe a lista nova de volta.
export async function load() {
  if (loaded) return;
  loaded = true;
  try {
    hub = await invoke<McpServer[]>("mcp_hub");
    logins = await invoke<string[]>("mcp_logins");
    announce();
  } catch {
    // Sem back (ou back velho) a tela fica sem hub, e os seletores somem.
  }
}

/// O nome de um servidor que já não existe mais no hub continua gravado no
/// workspace — apagar do cadastro não pode mexer em quadro. A tela mostra o
/// que sobrou como escolhido e riscado, para o buraco ter explicação.
export const known = (id: string) => hub.some((s) => s.id === id);

/// Já entrou neste servidor. A linha de Configurações diz, e o formulário
/// troca "Entrar" por "Sair".
export const signedIn = (id: string) => logins.includes(id);

async function refreshLogins() {
  try {
    logins = await invoke<string[]>("mcp_logins");
    announce();
  } catch {
    // Sem back, a lista continua a de antes.
  }
}

/* ---------- o seletor ---------- */

type Pick = {
  /// Quem está marcado agora. `null` é workspace que nunca escolheu.
  chosen: () => string[] | null;
  /// Devolve a lista nova. `null` nunca sai daqui — escolher é escolher.
  set: (ids: string[]) => void;
  /// Onde o menu cai.
  at: () => { x: number; y: number };
  /// Desligado enquanto o agente trabalha: trocar de MCP derruba o processo, e
  /// no meio de um turno isso jogaria o turno fora.
  locked?: () => string;
};

export function openPicker(p: Pick) {
  const lock = p.locked?.() ?? "";
  const chosen = p.chosen() ?? [];
  const items: menu.Item[] = [];
  if (lock) {
    items.push({ label: lock, disabled: true }, "sep");
  }
  if (!hub.length) {
    items.push({ label: t("mcp.none"), disabled: true });
  }
  for (const server of hub) {
    const on = chosen.includes(server.id);
    items.push({
      label: server.id,
      checked: on,
      disabled: !!lock,
      run: () => {
        p.set(on ? chosen.filter((id) => id !== server.id) : [...chosen, server.id]);
        // O menu do app fecha ao escolher; marcar vários é reabrir.
        openPicker(p);
      },
    });
  }
  // Nomes gravados que o hub não tem mais: aparecem para poder sair.
  for (const id of chosen.filter((c) => !known(c))) {
    items.push({
      label: t("mcp.gone", { name: id }),
      checked: true,
      disabled: !!lock,
      run: () => {
        p.set(chosen.filter((c) => c !== id));
        openPicker(p);
      },
    });
  }
  if (hub.length && !lock) {
    items.push("sep", {
      label: t("mcp.clear"),
      disabled: !chosen.length,
      run: () => {
        p.set([]);
        openPicker(p);
      },
    });
  }
  menu.openAt(p.at(), items);
}

/// O que o botão escreve: quantos entram. Nenhum é escolha e se diz por
/// extenso — "sem MCP" não é o mesmo que não ter escolhido.
export function label(chosen: string[] | null): string {
  if (chosen === null) return t("mcp.default");
  if (!chosen.length) return t("mcp.zero");
  if (chosen.length === 1) return chosen[0];
  return t("mcp.count", { n: String(chosen.length) });
}

/* ---------- a lista em Configurações ---------- */

type Ctx = { say: (text: string, isError?: boolean) => void };
let ctx: Ctx;

export function init(context: Ctx) {
  ctx = context;
}

/// As linhas da página "Ferramentas": uma por servidor, e a primeira é o que
/// esta página é e o que se faz nela.
///
/// Cadastrar e importar ficam nessa primeira linha, e não no fim da lista: no
/// fim, uma linha com botões seria lida como mais um servidor.
export function settingsRows(): HTMLElement[] {
  return [aboutRow(), ...(hub.length ? hub.map(serverRow) : [emptyRow()])];
}

/// A linha de cima: o que são estes servidores, e por onde se põe um.
function aboutRow(): HTMLElement {
  const row = template(
    "div",
    "setrow head",
    `<div class="txt"><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".txt span")!.textContent = t("settings.mcp.body");

  const add = template("button", "outline md", `<span></span>`) as HTMLButtonElement;
  add.children[0].textContent = t("mcp.add");
  add.addEventListener("click", () => editor(null));

  const bring = template("button", "ghost md", `<span></span>`) as HTMLButtonElement;
  bring.children[0].textContent = t("mcp.import");
  bring.addEventListener("click", () => void importer(bring));

  row.querySelector(".act")!.append(add, bring);
  return row;
}

function emptyRow(): HTMLElement {
  const row = h("div", "setrow none", "");
  row.textContent = t("mcp.empty");
  return row;
}

function serverRow(server: McpServer): HTMLElement {
  const row = template(
    "div",
    "setrow",
    `<span class="glyph"></span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".glyph")!.innerHTML = icon(kind(server) === "stdio" ? "terminal" : "globe", 18);
  row.querySelector(".txt b")!.textContent = server.id;
  const sub = subtitle(server);
  row.querySelector(".txt span")!.textContent = signedIn(server.id) ? `${sub} · ${t("mcp.connected")}` : sub;

  const edit = template("button", "ghost md", `<span></span>`) as HTMLButtonElement;
  edit.children[0].textContent = t("mcp.edit");
  edit.addEventListener("click", () => editor(server));

  const drop = template("button", "ghost md", `<span></span>`) as HTMLButtonElement;
  drop.children[0].textContent = t("mcp.remove");
  drop.addEventListener("click", () => void remove(server));

  row.querySelector(".act")!.append(edit, drop);
  return row;
}

/// stdio (um processo aqui) ou remoto (uma URL). É o que muda o formulário e o
/// ícone da linha.
function kind(server: McpServer): "stdio" | "url" {
  return typeof server.config.command === "string" ? "stdio" : "url";
}

/// A linha de baixo: o que ele é, e de onde veio.
function subtitle(server: McpServer): string {
  const what =
    kind(server) === "stdio"
      ? [server.config.command, ...((server.config.args as string[]) ?? [])].join(" ")
      : String(server.config.url ?? "");
  const from = server.note.trim();
  return from ? `${what} · ${from}` : what;
}

async function remove(server: McpServer) {
  try {
    hub = await invoke<McpServer[]>("mcp_remove", { id: server.id });
    announce();
  } catch (e) {
    ctx.say(fromBack(e), true);
  }
}

async function save(server: McpServer) {
  hub = await invoke<McpServer[]>("mcp_save", { server });
  announce();
}

/* ---------- o formulário ---------- */

/// O formulário enquanto está sendo preenchido. Vira `McpServer` na hora de
/// examinar ou de gravar, e não antes: campo pela metade no meio da digitação
/// é normal.
export type Draft = {
  stdio: boolean;
  id: string;
  cmd: string;
  url: string;
  /// Variáveis (stdio) ou cabeçalhos (remoto), na ordem em que a pessoa os
  /// pôs. Em objeto a ordem seria a do JSON, e linha que salta de lugar
  /// enquanto se digita é linha que se perde de vista.
  pairs: [string, string][];
  note: string;
};

export function toDraft(server: McpServer | null): Draft {
  const config = server?.config ?? {};
  return {
    stdio: server ? kind(server) === "stdio" : true,
    id: server?.id ?? "",
    cmd: [config.command, ...((config.args as string[]) ?? [])].filter(Boolean).join(" "),
    url: String(config.url ?? ""),
    pairs: Object.entries((config.env ?? config.headers ?? {}) as Record<string, string>),
    note: server?.note ?? "",
  };
}

/// O que está no formulário, na forma que o CLI entende — quem escreve JSON é
/// a tela, não a pessoa. `null` é campo faltando, e aí não há o que examinar
/// nem o que gravar.
export function toServer(d: Draft): McpServer | null {
  const id = d.id.trim();
  const parts = d.cmd.trim().split(/\s+/).filter(Boolean);
  const url = d.url.trim();
  if (!id || (d.stdio ? !parts.length : !url)) return null;
  const pairs = Object.fromEntries(
    d.pairs.map(([k, v]) => [k.trim(), v.trim()] as const).filter(([k]) => k),
  );
  return {
    id,
    config: d.stdio
      ? { type: "stdio", command: parts[0], args: parts.slice(1), env: pairs }
      : { type: "http", url, headers: pairs },
    note: d.note.trim(),
  };
}

/// Cadastrar um servidor em dois passos, como um assistente.
///
/// No primeiro, o que ninguém descobre por você: se é um programa daqui ou um
/// endereço lá, o nome, e onde ele está. Sair do campo do endereço já manda o
/// Prometheus falar com ele — subir o programa (ou bater na URL), apresentar-se,
/// contar as ferramentas, e num remoto que pede login ver se dá para se
/// autorizar nele. Cada uma dessas tentativas é uma linha na tela.
///
/// No segundo, o que depende do que o exame achou: entrar, os cabeçalhos ou as
/// variáveis, e para que ele serve. Era tudo um formulário só, e o resultado
/// do teste cabia numa linha do rodapé — "não conectou" e "conectou e pede
/// login" apareciam no mesmo lugar, depois de tudo digitado, sem dizer em que
/// ponto tinha parado.
///
/// Editar um servidor que já existe abre direto no segundo passo: o nome e o
/// endereço já estão certos, e quem quiser mexer neles clica no resumo lá em
/// cima e volta.
function editor(server: McpServer | null) {
  const veil = $("veil");
  const sheet = template(
    "div",
    "sheet hubedit",
    `<div class="sheettop"><b class="mt"></b></div><div class="mbody"></div><div class="sheetbar"></div>`,
  );
  const at = <T extends HTMLElement>(sel: string) => sheet.querySelector(sel) as T;
  const draft = toDraft(server);
  /// O último exame do que está no formulário, e `null` enquanto ninguém
  /// examinou. Trocar de tipo joga fora: ele era sobre outro servidor.
  let check: McpCheck | null = null;
  let checking = false;
  /// O botão da direita do rodapé, qualquer que seja o passo. Fica desligado
  /// enquanto o exame corre — andar no meio dele seria andar sem o resultado.
  let go: HTMLButtonElement | null = null;

  const hide = () => {
    veil.hidden = true;
    veil.replaceChildren();
  };

  const hint = h("span", "hint");
  const say = (text: string, bad = false) => {
    hint.textContent = text;
    hint.title = text;
    hint.classList.toggle("bad", bad);
  };

  /// O rodapé: sair à esquerda, o recado no meio, seguir à direita. Os dois
  /// passos têm o mesmo desenho, e é o mesmo `hint` nos dois.
  function foot(left: [Key, () => void], right: [Key, () => void]): HTMLButtonElement {
    const back = h("button", "ghost", t(left[0]));
    back.addEventListener("click", left[1]);
    go = h("button", "pri", t(right[0])) as HTMLButtonElement;
    go.addEventListener("click", right[1]);
    go.disabled = checking;
    at(".sheetbar").replaceChildren(back, hint, go);
    return go;
  }

  /* ---------- primeiro passo: quem é, e onde ---------- */

  /// Onde os passos do exame aparecem. Refeito por conta própria, e não com o
  /// passo inteiro: redesenhar os campos tiraria o foco de quem acabou de sair
  /// de um deles.
  const checkBox = h("div", "mcheck");
  const paintCheck = () => {
    checkBox.hidden = !checking && !check;
    checkBox.replaceChildren(...checkRows(draft, check, checking));
  };

  async function examine() {
    const built = toServer(draft);
    if (!built) return;
    checking = true;
    check = null;
    say("");
    if (go) go.disabled = true;
    paintCheck();
    try {
      check = await invoke<McpCheck>("mcp_check", { server: built });
    } catch (e) {
      say(fromBack(e), true);
    }
    checking = false;
    if (go) go.disabled = false;
    paintCheck();
    // O resultado nasce embaixo do que se acabou de digitar, e num corpo que
    // rola isso é fora da tela — trazê-lo à vista é o que faz o exame ter
    // servido para alguma coisa.
    checkBox.scrollIntoView({ block: "end" });
  }

  function first() {
    at(".mt").textContent = t(server ? "mcp.title.edit" : "mcp.title.new");
    // Um servidor é um programa aqui ou um endereço lá — nunca os dois. A
    // escolha troca o campo de baixo e o exame inteiro.
    const kinds = h("div", "mkind");
    const sw = (on: boolean, key: Key, pick: () => void) => {
      const b = template("button", `ghost sw${on ? " on" : ""}`, `<span></span><i class="knob"></i>`);
      b.setAttribute("role", "switch");
      b.setAttribute("aria-checked", String(on));
      b.children[0].textContent = t(key);
      b.addEventListener("click", () => {
        pick();
        check = null;
        first();
      });
      return b;
    };
    kinds.append(
      sw(draft.stdio, "mcp.kind.stdio", () => (draft.stdio = true)),
      sw(!draft.stdio, "mcp.kind.url", () => (draft.stdio = false)),
    );
    at(".mbody").replaceChildren(
      h("p", "msay", t("mcp.intro")),
      kinds,
      field({
        label: "mcp.field.name",
        hint: "mcp.field.name.hint",
        value: draft.id,
        on: (v) => (draft.id = v),
      }),
      draft.stdio
        ? field({
            label: "mcp.field.command",
            hint: "mcp.field.command.hint",
            value: draft.cmd,
            on: (v) => (draft.cmd = v),
            done: examine,
          })
        : field({
            label: "mcp.field.url",
            hint: "mcp.field.url.hint",
            value: draft.url,
            on: (v) => (draft.url = v),
            done: examine,
          }),
      checkBox,
    );
    // Trocar de passo começa do começo: o corpo rola, e herdar a rolagem do
    // passo anterior deixaria o alto do novo escondido.
    at(".mbody").scrollTop = 0;
    paintCheck();
    foot(["mcp.cancel", hide], ["mcp.next", advance]);
  }

  /// Continuar: quem ainda não examinou examina agora, porque o segundo passo
  /// é escrito com o que o exame achou. Exame que deu errado não tranca o
  /// caminho — pode ser a rede, e cadastrar para consertar depois é legítimo.
  async function advance() {
    if (!toServer(draft)) return say(t("mcp.needFields"), true);
    if (!check) await examine();
    second();
  }

  /* ---------- segundo passo: o que o exame deixou para decidir ---------- */

  function second() {
    at(".mt").textContent = t(server ? "mcp.title.edit" : "mcp.title.new");
    at(".mbody").replaceChildren(
      resume(),
      // Login só existe em servidor remoto: um programa que roda aqui recebe
      // o segredo por variável de ambiente, e não há a quem pedir consentimento.
      ...(draft.stdio ? [] : [auth()]),
      pairsSection(),
      field({
        label: "mcp.field.note",
        hint: "mcp.field.note.hint",
        value: draft.note,
        on: (v) => (draft.note = v),
      }),
    );
    at(".mbody").scrollTop = 0;
    // Cancelar nos dois passos, e não "Voltar": voltar e corrigir é o resumo
    // lá em cima, e fechar a folha tem que ser possível de onde se está —
    // quem abriu para editar entra por aqui e não passou pelo primeiro passo.
    foot(["mcp.cancel", hide], ["mcp.save", store]);
  }

  /// O que já foi decidido, no alto: o nome, onde ele está, e o que ele
  /// respondeu. É botão porque voltar e corrigir tem que ser um clique.
  function resume(): HTMLElement {
    const row = template(
      "button",
      "mhead",
      `<div class="txt"><b></b><span class="addr"></span><span class="said"></span></div><span class="pen"></span>`,
    );
    row.querySelector("b")!.textContent = draft.id.trim();
    row.querySelector(".addr")!.textContent = (draft.stdio ? draft.cmd : draft.url).trim();
    const said = check?.probe.ok
      ? [check.probe.name, tn(check.probe.tools, "mcp.found.tools")].filter(Boolean).join(" · ")
      : "";
    row.querySelector(".said")!.textContent = said;
    row.querySelector(".pen")!.innerHTML = icon("pencil", 14);
    row.addEventListener("click", first);
    return row;
  }

  /// Autenticação: o estado, e o botão que o muda. Não é uma escolha — quem
  /// decide se pede login é o servidor, e o exame já perguntou. O que sobra
  /// para a pessoa é entrar, ou sair.
  function auth(): HTMLElement {
    const inside = signedIn(draft.id.trim());
    const asks = check?.probe.auth ?? false;
    // Servidor que pede login mas não registra clientes na hora não tem
    // entrada por aqui; o passo que falhou é que explica.
    const open = asks && check!.steps.every((s) => s.ok);
    const body: Key = inside
      ? "mcp.auth.in"
      : asks
        ? open
          ? "mcp.auth.needed"
          : "mcp.auth.blocked"
        : check?.probe.ok
          ? "mcp.auth.no"
          : "mcp.auth.unknown";
    const box = section("mcp.auth", body);
    // Entrar aparece para quem pediu login, e para quem ninguém examinou —
    // tentar é barato, e o erro que vier diz mais do que esconder o botão.
    if (inside || open || !check) {
      const btn = h("button", "outline md", t(inside ? "mcp.logout" : "mcp.login")) as HTMLButtonElement;
      btn.addEventListener("click", () => void enter(btn));
      box.append(btn);
    }
    return box;
  }

  async function enter(btn: HTMLButtonElement) {
    const built = toServer(draft);
    if (!built) return say(t("mcp.needFields"), true);
    if (signedIn(built.id)) {
      try {
        await invoke("mcp_logout", { id: built.id });
      } catch (e) {
        return say(fromBack(e), true);
      }
      await refreshLogins();
      return second();
    }
    // O servidor precisa estar cadastrado antes: o login é gravado pelo nome
    // dele, e um nome que ainda não existe no hub viraria login órfão.
    btn.disabled = true;
    say(t("mcp.login.doing"));
    try {
      await save(built);
      await invoke("mcp_login", { server: built });
      await refreshLogins();
      say(t("mcp.login.ok"));
      // O exame de antes dizia "pede login", e agora diria outra coisa:
      // refazê-lo é o que faz a folha contar a verdade nova.
      await examine();
      second();
    } catch (e) {
      say(fromBack(e), true);
      btn.disabled = false;
    }
  }

  /// Variáveis (stdio) ou cabeçalhos (remoto): uma linha por par, o nome de um
  /// lado e o valor do outro. Era um `CHAVE=valor` por linha num campo de
  /// texto, que é rápido de colar e fácil de errar — e remover um par era
  /// editar texto.
  function pairsSection(): HTMLElement {
    const box = section(
      draft.stdio ? "mcp.pairs.env" : "mcp.pairs.headers",
      draft.stdio ? "mcp.pairs.env.body" : "mcp.pairs.headers.body",
    );
    const rows = h("div", "mpairs");
    const paint = () => {
      rows.replaceChildren(
        ...draft.pairs.map((pair, i) =>
          pairRow(pair, () => {
            draft.pairs.splice(i, 1);
            paint();
          }),
        ),
      );
    };
    paint();
    const add = template("button", "ghost md", `${icon("plus", 14)}<span></span>`);
    add.children[1].textContent = t("mcp.pairs.add");
    add.addEventListener("click", () => {
      draft.pairs.push(["", ""]);
      paint();
      (rows.lastElementChild?.querySelector("input") as HTMLInputElement | null)?.focus();
    });
    box.append(rows, add);
    return box;
  }

  /// Gravar. O que está escrito é o que vale — inclusive de um servidor que
  /// não respondeu ao exame.
  function store() {
    const built = toServer(draft);
    if (!built) return say(t("mcp.needFields"), true);
    save(built)
      .then(hide)
      .catch((e) => say(fromBack(e), true));
  }

  if (server) second();
  else first();
  veil.replaceChildren(sheet);
  veil.hidden = false;
  // Só quem está cadastrando começa com o cursor no primeiro campo. Editar
  // abre no segundo passo, e ali o primeiro campo é um que já está preenchido.
  if (!server) at<HTMLInputElement>("input")?.focus();
}

function pairRow(pair: [string, string], drop: () => void): HTMLElement {
  const row = h("div", "mpair");
  const cell = (which: 0 | 1, place: Key) => {
    const input = h("input", "") as HTMLInputElement;
    input.spellcheck = false;
    input.placeholder = t(place);
    input.value = pair[which];
    input.addEventListener("input", () => (pair[which] = input.value));
    return input;
  };
  const x = template("button", "ico sm", icon("x", 14));
  x.title = t("mcp.pairs.drop");
  x.addEventListener("click", drop);
  row.append(cell(0, "mcp.pairs.key"), cell(1, "mcp.pairs.value"), x);
  return row;
}

/// Um campo com o rótulo em cima e a explicação embaixo. A explicação fica
/// escrita, e não num `placeholder`: `placeholder` desaparece justamente
/// quando se digita, que é quando ele serviria.
function field(o: {
  label: Key;
  hint: Key;
  value: string;
  on: (v: string) => void;
  /// Saiu do campo tendo mudado o que estava escrito — o momento de examinar.
  /// Não a cada tecla: o exame sobe processo e atravessa a rede.
  done?: () => void;
}): HTMLElement {
  const box = template(
    "label",
    "fld",
    `<span class="fl"></span><input spellcheck="false" /><span class="fh"></span>`,
  );
  box.querySelector(".fl")!.textContent = t(o.label);
  box.querySelector(".fh")!.textContent = t(o.hint);
  const input = box.querySelector("input")!;
  input.value = o.value;
  input.addEventListener("input", () => o.on(input.value));
  if (o.done) input.addEventListener("change", o.done);
  return box;
}

/// Uma seção do segundo passo: o título, uma frase do que ela é, e o que ela
/// tem dentro.
function section(title: Key, body: Key): HTMLElement {
  const box = template("div", "msect", `<b></b><span class="sb"></span>`);
  box.children[0].textContent = t(title);
  box.children[1].textContent = t(body);
  return box;
}

/// A ordem em que o exame tenta as coisas. Serve para desenhar as linhas
/// enquanto ele corre: o back devolve tudo de uma vez, e uma lista que só
/// aparecesse no fim deixaria vinte segundos de tela parada. Os passos do
/// OAuth não estão aqui porque só existem se o servidor pedir login — eles
/// aparecem com a resposta.
const AHEAD: Record<"stdio" | "url", string[]> = {
  stdio: ["spawn", "handshake", "tools"],
  url: ["connect", "handshake", "tools"],
};

function checkRows(draft: Draft, check: McpCheck | null, running: boolean): HTMLElement[] {
  const keys = check ? check.steps.map((s) => s.key) : AHEAD[draft.stdio ? "stdio" : "url"];
  const rows = keys.map((key, i) => stepRow(key, check?.steps[i] ?? null));
  return [
    h("b", "ch", t(running ? "mcp.check.doing" : "mcp.check.done")),
    ...rows,
    ...(check ? [verdict(check)] : []),
  ];
}

function stepRow(key: string, step: McpStep | null): HTMLElement {
  const row = template(
    "div",
    `crow${step ? (step.ok ? " ok" : " bad") : ""}`,
    `<span class="cg"></span><div class="txt"><b></b><span></span></div><span class="cc"></span>`,
  );
  row.querySelector(".cg")!.innerHTML = step ? icon(step.ok ? "check" : "x", 14) : `<i class="spin"></i>`;
  row.querySelector("b")!.textContent = t(`mcp.step.${key}` as Key);
  row.querySelector(".txt span")!.textContent = !step
    ? t("mcp.step.wait")
    : step.ok
      ? t("mcp.step.ok")
      : // Ferramenta nenhuma é a única falha que o servidor não explica: ele
        // respondeu, e a resposta estava vazia.
        step.detail || t(key === "tools" ? "mcp.step.tools.none" : "mcp.step.fail");
  row.querySelector(".cc")!.textContent = step?.note ?? "";
  return row;
}

/// O fecho do exame: o que ele quer dizer para o passo seguinte.
function verdict(check: McpCheck): HTMLElement {
  const { ok, auth } = check.probe;
  const box = template("div", `cnote${ok || auth ? "" : " bad"}`, `<span class="ic"></span><span></span>`);
  box.querySelector(".ic")!.innerHTML = icon(ok || auth ? "check" : "x", 14);
  box.children[1].textContent = t(ok ? "mcp.found.ok" : auth ? "mcp.found.auth" : "mcp.found.fail");
  return box;
}

/* ---------- importar ---------- */

/// O que já está configurado no CLI e ainda não está no hub. Vem do back, que
/// lê o `~/.claude.json` e os `.mcp.json` — e não mexe em nenhum deles.
async function importer(btn: HTMLElement) {
  let found: McpServer[] = [];
  try {
    found = await invoke<McpServer[]>("mcp_found");
  } catch (e) {
    ctx.say(fromBack(e), true);
    return;
  }
  const at = btn.getBoundingClientRect();
  if (!found.length) {
    menu.openAt({ x: at.left, y: at.bottom + 4 }, [{ label: t("mcp.import.none"), disabled: true }]);
    return;
  }
  menu.openAt(
    { x: at.left, y: at.bottom + 4 },
    found.map((server) => ({
      label: server.id,
      hint: server.note.trim() || t("mcp.origin.user"),
      run: () => {
        save(server).catch((e) => ctx.say(fromBack(e), true));
      },
    })),
  );
}
