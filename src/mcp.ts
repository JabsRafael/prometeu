import { invoke } from "./ipc";
import { icon } from "./icons";
import { fromBack, t } from "./i18n";
import * as menu from "./menu";
import type { McpProbe, McpServer } from "./types";
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

/// Um servidor, à mão. Dois formatos, porque são dois no CLI: um comando que
/// roda aqui, ou uma URL. O que se digita vira o objeto que o Claude Code
/// espera — quem escreve JSON é a tela, não a pessoa.
function editor(server: McpServer | null) {
  const veil = $("veil");
  const sheet = h("div", "sheet mcpedit");
  sheet.innerHTML = `
    <div class="sheettop"><b class="mt"></b></div>
    <label class="fld"><span class="fl"></span><input id="m-id" spellcheck="false" /></label>
    <div class="mkind">
      <button class="ghost sw" id="m-stdio" role="switch"><span></span><i class="knob"></i></button>
      <button class="ghost sw" id="m-url" role="switch"><span></span><i class="knob"></i></button>
    </div>
    <label class="fld" id="m-cmdfld"><span class="fl"></span><input id="m-cmd" spellcheck="false" /></label>
    <label class="fld" id="m-urlfld"><span class="fl"></span><input id="m-url-v" spellcheck="false" /></label>
    <label class="fld"><span class="fl"></span><textarea id="m-env" rows="3" spellcheck="false"></textarea></label>
    <label class="fld"><span class="fl"></span><input id="m-note" spellcheck="false" /></label>
    <div class="sheetbar">
      <button class="ghost" id="m-test"></button>
      <button class="ghost" id="m-login" hidden></button>
      <span class="hint" id="m-hint"></span>
      <button class="ghost" id="m-cancel"></button>
      <button class="pri" id="m-save"></button>
    </div>`;

  const q = <T extends HTMLElement>(id: string) => sheet.querySelector(`#${id}`) as T;
  const labels: [string, string][] = [
    ["m-id", "mcp.field.name"],
    ["m-cmdfld", "mcp.field.command"],
    ["m-urlfld", "mcp.field.url"],
    ["m-env", "mcp.field.env"],
    ["m-note", "mcp.field.note"],
  ];
  for (const [id, key] of labels) {
    const fld = q(id).closest(".fld") ?? q(id);
    fld.querySelector(".fl")!.textContent = t(key as Parameters<typeof t>[0]);
  }
  sheet.querySelector(".mt")!.textContent = t(server ? "mcp.title.edit" : "mcp.title.new");
  q("m-stdio").children[0].textContent = t("mcp.kind.stdio");
  q("m-url").children[0].textContent = t("mcp.kind.url");
  q("m-cancel").textContent = t("mcp.cancel");
  q("m-save").textContent = t("mcp.save");
  q("m-test").textContent = t("mcp.test");

  let stdio = server ? kind(server) === "stdio" : true;
  const drawKind = () => {
    q("m-stdio").setAttribute("aria-checked", String(stdio));
    q("m-stdio").classList.toggle("on", stdio);
    q("m-url").setAttribute("aria-checked", String(!stdio));
    q("m-url").classList.toggle("on", !stdio);
    q("m-cmdfld").hidden = !stdio;
    q("m-urlfld").hidden = stdio;
  };
  q("m-stdio").addEventListener("click", () => {
    stdio = true;
    drawKind();
  });
  q("m-url").addEventListener("click", () => {
    stdio = false;
    drawKind();
  });
  drawKind();

  const config = server?.config ?? {};
  q<HTMLInputElement>("m-id").value = server?.id ?? "";
  q<HTMLInputElement>("m-cmd").value = [config.command, ...((config.args as string[]) ?? [])]
    .filter(Boolean)
    .join(" ");
  q<HTMLInputElement>("m-url-v").value = String(config.url ?? "");
  q<HTMLTextAreaElement>("m-env").value = pairsToText(
    (config.env ?? config.headers ?? {}) as Record<string, string>,
  );
  q<HTMLInputElement>("m-note").value = server?.note ?? "";
  q<HTMLInputElement>("m-env").placeholder = t("mcp.field.env.hint");

  const hide = () => {
    veil.hidden = true;
    veil.replaceChildren();
  };
  q("m-cancel").addEventListener("click", hide);

  const hint = q("m-hint");
  const show = (text: string, bad: boolean, title = "") => {
    hint.textContent = text;
    hint.title = title;
    hint.classList.toggle("bad", bad);
  };

  /// O que está no formulário agora, na forma que o CLI entende. `null` é campo
  /// faltando — e aí nem testar nem salvar fazem sentido.
  const built = (): McpServer | null => {
    const id = q<HTMLInputElement>("m-id").value.trim();
    const pairs = textToPairs(q<HTMLTextAreaElement>("m-env").value);
    const parts = q<HTMLInputElement>("m-cmd").value.trim().split(/\s+/).filter(Boolean);
    const url = q<HTMLInputElement>("m-url-v").value.trim();
    if (!id || (stdio ? !parts.length : !url)) return null;
    return {
      id,
      config: stdio
        ? { type: "stdio", command: parts[0], args: parts.slice(1), env: pairs }
        : { type: "http", url, headers: pairs },
      note: q<HTMLInputElement>("m-note").value.trim(),
    };
  };

  // Entrar aparece quando o servidor pede login, e vira Sair depois que se
  // entrou. Fica escondido enquanto ninguém testou: oferecer login para um
  // servidor que não pede é oferecer um caminho que não existe.
  const login = q<HTMLButtonElement>("m-login");
  const drawLogin = (needs: boolean) => {
    // Pelo nome que está no campo, e não pelo servidor que abriu a folha:
    // cadastrar um novo e entrar nele acontece sem fechar isto aqui.
    const inside = signedIn(q<HTMLInputElement>("m-id").value.trim());
    login.hidden = !needs && !inside;
    login.textContent = t(inside ? "mcp.logout" : "mcp.login");
  };
  drawLogin(false);
  login.addEventListener("click", async () => {
    const built_ = built();
    if (!built_) return show(t("mcp.needFields"), true);
    if (signedIn(built_.id)) {
      await invoke("mcp_logout", { id: built_.id }).catch((e) => show(fromBack(e), true));
      await refreshLogins();
      drawLogin(true);
      return;
    }
    // O servidor precisa estar cadastrado antes: o login é gravado pelo nome
    // dele, e um nome que ainda não existe no hub viraria login órfão.
    login.disabled = true;
    show(t("mcp.login.doing"), false);
    try {
      await save(built_);
      await invoke("mcp_login", { server: built_ });
      await refreshLogins();
      show(t("mcp.login.ok"), false);
      drawLogin(false);
    } catch (e) {
      show(fromBack(e), true);
    }
    login.disabled = false;
  });

  // Testar antes de salvar: sobe o servidor (ou bate na URL) e conta quantas
  // ferramentas ele oferece. Quem responde é ele — não há agente no meio.
  q("m-test").addEventListener("click", async () => {
    const server = built();
    if (!server) return show(t("mcp.needFields"), true);
    const btn = q<HTMLButtonElement>("m-test");
    btn.disabled = true;
    show(t("mcp.testing"), false);
    try {
      const got = await invoke<McpProbe>("mcp_test", { server });
      show(...verdict(got));
      drawLogin(got.auth);
    } catch (e) {
      show(fromBack(e), true);
    }
    btn.disabled = false;
  });

  q("m-save").addEventListener("click", () => {
    const server = built();
    if (!server) return show(t("mcp.needFields"), true);
    save(server)
      .then(hide)
      .catch((e) => show(fromBack(e), true));
  });

  veil.replaceChildren(sheet);
  veil.hidden = false;
  q<HTMLInputElement>("m-id").focus();
}

/// O teste em uma linha. Conectar e não oferecer ferramenta nenhuma não é
/// sucesso na prática: o agente não ganha nada com isso, e a linha diz.
function verdict(got: McpProbe): [string, boolean, string] {
  if (got.auth) return [t("mcp.test.auth"), true, t("mcp.test.auth.title")];
  if (!got.ok) {
    const text = got.detail ? t("mcp.test.fail", { detail: got.detail }) : t("mcp.test.failBlank");
    // A causa crua costuma passar de uma linha; a linha mostra o começo, e o
    // resto fica onde não atrapalha.
    return [text, true, text];
  }
  if (!got.tools) return [t("mcp.test.empty"), true, ""];
  const n = String(got.tools);
  return [got.name ? t("mcp.test.okNamed", { name: got.name, n }) : t("mcp.test.ok", { n }), false, ""];
}

/// `CHAVE=valor` por linha, que é como se lê uma variável de ambiente em
/// qualquer lugar — e evita pedir JSON a quem só quer colar um token.
function pairsToText(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function textToPairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
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
