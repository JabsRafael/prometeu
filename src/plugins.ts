import { invoke } from "./ipc";
import { icon } from "./icons";
import { fromBack, t, type Key } from "./i18n";
import * as menu from "./menu";
import type { Plugin } from "./types";
import { $, h, template } from "./util";

/// O hub de plugins na tela: a lista em Configurações, e o seletor que o
/// lançador e a conversa abrem.
///
/// O que um plugin é, e por que a escolha existe, está em
/// `src-tauri/src/plugins.rs`. Aqui só o que é tela — e ela é a mesma do hub de
/// MCP de propósito: mesma lista, mesmo seletor, mesma folha de cadastro. São
/// duas escolhas do mesmo tipo (o que o agente tem na mão, e como ele
/// trabalha), e aprender uma tem que ser aprender a outra.
///
/// O cadastro mora no back e esta é a cópia que a janela desenha; ela é refeita
/// a cada gravação, porque o back devolve a lista inteira depois de gravar —
/// nunca há duas verdades.

let hub: Plugin[] = [];
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
    hub = await invoke<Plugin[]>("plugin_hub");
    announce();
  } catch {
    // Sem back (ou back velho) a tela fica sem hub, e os seletores somem.
  }
}

/// O nome de um plugin que já não existe mais no hub continua gravado no
/// workspace — apagar do cadastro não pode mexer em quadro. O seletor mostra o
/// que sobrou como escolhido, para o buraco ter explicação.
export const known = (id: string) => hub.some((p) => p.id === id);

/* ---------- o seletor ---------- */

type Pick = {
  /// Quem está marcado agora. `null` é workspace que nunca escolheu.
  chosen: () => string[] | null;
  /// Devolve a lista nova. `null` nunca sai daqui — escolher é escolher.
  set: (ids: string[]) => void;
  /// Onde o menu cai.
  at: () => { x: number; y: number };
  /// Desligado enquanto o agente trabalha: plugin entra quando a sessão sobe, e
  /// derrubá-la no meio de um turno jogaria o turno fora.
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
    items.push({ label: t("plugin.none"), disabled: true });
  }
  for (const plugin of hub) {
    const on = chosen.includes(plugin.id);
    items.push({
      label: plugin.id,
      hint: plugin.note.trim(),
      checked: on,
      disabled: !!lock,
      run: () => {
        p.set(on ? chosen.filter((id) => id !== plugin.id) : [...chosen, plugin.id]);
        // O menu do app fecha ao escolher; marcar vários é reabrir.
        openPicker(p);
      },
    });
  }
  // Nomes gravados que o hub não tem mais: aparecem para poder sair.
  for (const id of chosen.filter((c) => !known(c))) {
    items.push({
      label: t("plugin.gone", { name: id }),
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
      label: t("plugin.clear"),
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
/// extenso — "sem plugin" não é o mesmo que não ter escolhido.
export function label(chosen: string[] | null): string {
  if (chosen === null) return t("plugin.default");
  if (!chosen.length) return t("plugin.zero");
  if (chosen.length === 1) return chosen[0];
  return t("plugin.count", { n: String(chosen.length) });
}

/* ---------- a lista em Configurações ---------- */

type Ctx = { say: (text: string, isError?: boolean) => void };
let ctx: Ctx;

export function init(context: Ctx) {
  ctx = context;
}

/// As linhas da página "Plugins": uma por plugin, e a primeira é o que esta
/// página é e o que se faz nela.
export function settingsRows(): HTMLElement[] {
  return [aboutRow(), ...(hub.length ? hub.map(pluginRow) : [emptyRow()])];
}

function aboutRow(): HTMLElement {
  const row = template(
    "div",
    "setrow head",
    `<div class="txt"><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".txt span")!.textContent = t("settings.plugins.body");

  const add = template("button", "outline md", `<span></span>`) as HTMLButtonElement;
  add.children[0].textContent = t("plugin.add");
  add.addEventListener("click", () => editor(null));

  const bring = template("button", "ghost md", `<span></span>`) as HTMLButtonElement;
  bring.children[0].textContent = t("plugin.import");
  bring.addEventListener("click", () => void importer(bring));

  row.querySelector(".act")!.append(add, bring);
  return row;
}

function emptyRow(): HTMLElement {
  const row = h("div", "setrow none", "");
  row.textContent = t("plugin.empty");
  return row;
}

function pluginRow(plugin: Plugin): HTMLElement {
  const row = template(
    "div",
    "setrow",
    `<span class="glyph"></span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".glyph")!.innerHTML = icon(remote(plugin.source) ? "globe" : "puzzle", 18);
  row.querySelector(".txt b")!.textContent = plugin.id;
  row.querySelector(".txt span")!.textContent = subtitle(plugin);

  const edit = template("button", "ghost md", `<span></span>`) as HTMLButtonElement;
  edit.children[0].textContent = t("plugin.edit");
  edit.addEventListener("click", () => editor(plugin));

  const drop = template("button", "ghost md", `<span></span>`) as HTMLButtonElement;
  drop.children[0].textContent = t("plugin.remove");
  drop.addEventListener("click", () => void remove(plugin));

  row.querySelector(".act")!.append(edit, drop);
  return row;
}

const remote = (source: string) => /^https?:\/\//.test(source.trim());

/// A linha de baixo: de onde ele vem, e para que serve.
function subtitle(plugin: Plugin): string {
  const note = plugin.note.trim();
  return note ? `${plugin.source} · ${note}` : plugin.source;
}

async function remove(plugin: Plugin) {
  try {
    hub = await invoke<Plugin[]>("plugin_remove", { id: plugin.id });
    announce();
  } catch (e) {
    ctx.say(fromBack(e), true);
  }
}

async function save(plugin: Plugin) {
  hub = await invoke<Plugin[]>("plugin_save", { plugin });
  announce();
}

/* ---------- o formulário ---------- */

/// Cadastrar um plugin é dizer onde ele está — o resto o próprio plugin já
/// declara. Por isso a origem vem primeiro e sair dela manda o Prometheus ler o
/// `plugin.json`: o nome e a descrição aparecem preenchidos, e quem quiser
/// muda. Uma folha só, e não os dois passos do MCP: aqui não há processo para
/// subir nem rede para atravessar.
function editor(plugin: Plugin | null) {
  const veil = $("veil");
  const sheet = template(
    "div",
    "sheet hubedit",
    `<div class="sheettop"><b class="mt"></b></div><div class="mbody"></div><div class="sheetbar"></div>`,
  );
  const at = <T extends HTMLElement>(sel: string) => sheet.querySelector(sel) as T;
  const draft: Plugin = { id: plugin?.id ?? "", source: plugin?.source ?? "", note: plugin?.note ?? "" };

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

  /// Ler o que a origem declara. Origem inválida já se diz aqui — descobrir
  /// no fim, depois de tudo digitado, é descobrir tarde.
  async function look() {
    if (!draft.source.trim()) return;
    say(t("plugin.looking"));
    try {
      const found = await invoke<Plugin>("plugin_look", { source: draft.source });
      // O que a pessoa escreveu manda: preencher é para o campo vazio.
      if (!draft.id.trim()) draft.id = found.id;
      if (!draft.note.trim()) draft.note = found.note;
      say("");
      paint();
    } catch (e) {
      say(fromBack(e), true);
    }
  }

  function paint() {
    at(".mt").textContent = t(plugin ? "plugin.title.edit" : "plugin.title.new");
    at(".mbody").replaceChildren(
      h("p", "msay", t("plugin.intro")),
      field({
        label: "plugin.field.source",
        hint: "plugin.field.source.hint",
        value: draft.source,
        on: (v) => (draft.source = v),
        done: look,
      }),
      field({
        label: "plugin.field.name",
        hint: "plugin.field.name.hint",
        value: draft.id,
        on: (v) => (draft.id = v),
      }),
      field({
        label: "plugin.field.note",
        hint: "plugin.field.note.hint",
        value: draft.note,
        on: (v) => (draft.note = v),
      }),
    );
    const back = h("button", "ghost", t("plugin.cancel"));
    back.addEventListener("click", hide);
    const go = h("button", "pri", t("plugin.save"));
    go.addEventListener("click", store);
    at(".sheetbar").replaceChildren(back, hint, go);
  }

  function store() {
    if (!draft.id.trim() || !draft.source.trim()) return say(t("plugin.needFields"), true);
    save({ id: draft.id.trim(), source: draft.source.trim(), note: draft.note.trim() })
      .then(hide)
      .catch((e) => say(fromBack(e), true));
  }

  paint();
  veil.replaceChildren(sheet);
  veil.hidden = false;
  if (!plugin) at<HTMLInputElement>("input")?.focus();
}

/// Um campo com o rótulo em cima e a explicação embaixo — o mesmo do hub de
/// MCP, e pelo mesmo motivo: `placeholder` some justamente quando serviria.
function field(o: {
  label: Key;
  hint: Key;
  value: string;
  on: (v: string) => void;
  /// Saiu do campo tendo mudado o que estava escrito.
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

/* ---------- importar ---------- */

/// O que o `claude plugin install` já pôs nesta máquina e ainda não está no
/// hub. Vem do back, que lê o cadastro do CLI — e não mexe nele.
async function importer(btn: HTMLElement) {
  let found: Plugin[] = [];
  try {
    found = await invoke<Plugin[]>("plugin_found");
  } catch (e) {
    ctx.say(fromBack(e), true);
    return;
  }
  const at = btn.getBoundingClientRect();
  if (!found.length) {
    menu.openAt({ x: at.left, y: at.bottom + 4 }, [{ label: t("plugin.import.none"), disabled: true }]);
    return;
  }
  menu.openAt(
    { x: at.left, y: at.bottom + 4 },
    found.map((plugin) => ({
      label: plugin.id,
      hint: plugin.note.trim() || t("plugin.origin.local"),
      run: () => {
        save(plugin).catch((e) => ctx.say(fromBack(e), true));
      },
    })),
  );
}
