import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { avatar, icon } from "./icons";
import { LANGS, choose, chosen, fromBack, fromSystem, t, tn, type Lang } from "./i18n";
import * as menu from "./menu";
import * as team from "./team";
import type { LinearStatus } from "./types";
import { settingsRow } from "./update";
import { $, h } from "./util";

/// Configurações do app — o que não é do repositório (isso é o
/// `settings.toml`) nem de um workspace: a conexão com o Linear, a linha de
/// atualização (que mora em `update.ts`) e o idioma da tela. A página é a
/// uma das telas do app e entra no histórico ← → como as outras.
///
/// A conexão mora no back: o token nunca chega aqui. O que a tela sabe é o
/// `LinearStatus`, que chega no `init` e depois pelo evento `linear` toda vez
/// que muda — conectou, desconectou, começou a esperar o navegador. A linha
/// do Linear é quem diz em que pé está; a barra de cima só fala quando deu
/// erro, que é o que você precisa ler.

type Ctx = { say: (text: string, isError?: boolean) => void };

let ctx: Ctx;
let status: LinearStatus = { connected: false, who: null, busy: false };

export async function init(context: Ctx) {
  ctx = context;
  listen<LinearStatus>("linear", ({ payload }) => {
    status = payload;
    draw();
  });
  try {
    status = await invoke<LinearStatus>("linear_status");
  } catch {
    // Sem back (ou back velho) a tela continua de pé, só desconectada.
  }
  // Presença muda sozinha; a linha do time acompanha — menos enquanto você
  // digita num campo dela, que refazer a página apagaria.
  team.onChange(() => {
    if ($("settingsView").hidden) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && $("settingsView").contains(active)) return;
    draw();
  });
}

/// O que o resto do app pergunta: tem Linear para puxar issue?
export const linear = () => status;

export function draw() {
  const view = $("settingsView");
  const page = h("div", "setpage", `<h1></h1><h2></h2>`);
  page.children[0].textContent = t("settings.title");
  page.children[1].textContent = t("settings.integrations");
  page.append(linearRow());
  const crew = h("h2", "", "");
  crew.textContent = t("settings.team");
  page.append(crew, ...teamRows());
  const app = h("h2", "", "");
  app.textContent = t("settings.app");
  // A atualização vem antes do idioma: é o que se procura aqui com pressa.
  page.append(app, settingsRow(), langRow());
  view.replaceChildren(page);
}

/// O idioma da tela. Guardado neste Mac e em mais lugar nenhum; sem escolha, o
/// app segue o computador — e a linha diz em que isso dá, para "do sistema"
/// não ser uma resposta que esconde a pergunta.
function langRow(): HTMLElement {
  const row = h(
    "div",
    "setrow",
    `<span class="glyph">${icon("globe", 18)}</span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".txt b")!.textContent = t("settings.lang");
  row.querySelector(".txt span")!.textContent = t("settings.lang.body");

  const system = LANGS.find(([id]) => id === fromSystem())?.[1] ?? fromSystem();
  const options: [Lang | null, string][] = [
    [null, t("settings.lang.system", { name: system })],
    ...LANGS.map(([id, name]) => [id, name] as [Lang, string]),
  ];
  const picked = chosen();

  const btn = h("button", "ghost md pick", `<span></span>${icon("chevron-down", 12)}`) as HTMLButtonElement;
  btn.children[0].textContent = options.find(([id]) => id === picked)![1];
  btn.addEventListener("click", () => {
    const at = btn.getBoundingClientRect();
    menu.openAt(
      { x: at.left, y: at.bottom + 4 },
      options.map(([id, name]) => ({
        label: name,
        checked: id === chosen(),
        run: () => choose(id),
      })),
    );
  });
  row.querySelector(".act")!.append(btn);
  return row;
}

function linearRow() {
  const row = h(
    "div",
    "setrow",
    `<span class="glyph">${icon("linear", 18)}</span><div class="txt"><b>Linear</b><span></span></div><div class="act"></div>`,
  );
  const text = row.querySelector(".txt span")!;
  const act = row.querySelector(".act")!;

  if (status.connected && status.who) {
    const { name, org } = status.who;
    text.innerHTML = `<span class="ok"></span> <span class="as"></span> <b></b> · <b></b>`;
    text.querySelector(".ok")!.textContent = t("linear.connected");
    text.querySelector(".as")!.textContent = t("linear.asWord");
    text.querySelectorAll("b")[0].textContent = name || status.who.email;
    text.querySelectorAll("b")[1].textContent = org || status.who.org_key;

    const off = h("button", "ghost md", t("linear.disconnect")) as HTMLButtonElement;
    off.title = t("linear.disconnect.title");
    off.addEventListener("click", async () => {
      off.disabled = true;
      try {
        status = await invoke<LinearStatus>("linear_disconnect");
      } catch (e) {
        ctx.say(fromBack(e), true);
      }
      draw();
    });
    act.append(off);
    return row;
  }

  text.textContent = t(status.busy ? "linear.waiting" : "linear.pitch");

  const on = h("button", "outline md", `<span></span> ${icon("external-link", 12)}`) as HTMLButtonElement;
  on.children[0].textContent = t("linear.connect");
  on.disabled = status.busy;
  on.title = t("linear.connect.title");
  on.addEventListener("click", async () => {
    on.disabled = true;
    status = { ...status, busy: true };
    draw();
    try {
      status = await invoke<LinearStatus>("linear_connect");
    } catch (e) {
      status = { ...status, busy: false };
      ctx.say(fromBack(e), true);
    }
    draw();
  });
  act.append(on);
  return row;
}

/* ---------- time ---------- */

/// O formulário aberto na linha do time: criar, entrar, ou nenhum. O que foi
/// digitado sobrevive a um redesenho — presença chega a qualquer hora.
type Mode = "idle" | "create" | "join";
let mode: Mode = "idle";
const draft = { name: "", code: "", relay: null as string | null };

function field(placeholder: string, value: string, onInput: (v: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "field";
  input.placeholder = placeholder;
  input.value = value;
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

/// Uma ação do time: o que der errado vai para a barra, e a página é refeita
/// de qualquer jeito — o estado mudou, ou o formulário tem que voltar.
async function run(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    ctx.say(fromBack(e), true);
  }
  draw();
}

function sub(label: string): { row: HTMLElement; txt: HTMLElement; act: HTMLElement } {
  const row = h("div", "setrow sub", `<div class="txt"><b></b></div><div class="act"></div>`);
  row.querySelector("b")!.textContent = label;
  return { row, txt: row.querySelector(".txt")!, act: row.querySelector(".act")! };
}

function teamRows(): HTMLElement[] {
  const st = team.status();
  const rows: HTMLElement[] = [];
  const row = h(
    "div",
    "setrow",
    `<span class="glyph">${icon("users", 18)}</span><div class="txt"><b></b><span></span></div><div class="act"></div>`,
  );
  row.querySelector(".txt b")!.textContent = t("team.title");
  const text = row.querySelector(".txt span")!;
  const act = row.querySelector(".act")!;
  rows.push(row);


  if (!st.config) {
    text.textContent = t("team.pitch");
    if (mode === "idle") {
      const create = h("button", "outline md", t("team.create"));
      create.addEventListener("click", () => {
        mode = "create";
        draw();
      });
      const join = h("button", "ghost md", t("team.join"));
      join.addEventListener("click", () => {
        mode = "join";
        draw();
      });
      act.append(create, join);
    } else {
      const form = sub(mode === "create" ? t("team.create") : t("team.join"));
      form.row.classList.add("form");
      form.act.classList.add("form");
      const name = field(t("team.yourName"), draft.name || st.defaultName, (v) => (draft.name = v));
      const code = field(t("team.code"), draft.code, (v) => (draft.code = v));
      code.classList.add("wide");
      const go = h("button", "pri md", t(mode === "create" ? "team.go.create" : "team.go.join"));
      const cancel = h("button", "ghost md", t("team.cancel"));
      const submit = () =>
        run(async () => {
          if (mode === "create") await team.create(name.value);
          else await team.join(code.value, name.value);
          mode = "idle";
          draft.name = "";
          draft.code = "";
        });
      go.addEventListener("click", submit);
      for (const input of [name, code]) {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") cancel.click();
        });
      }
      cancel.addEventListener("click", () => {
        mode = "idle";
        draw();
      });
      if (mode === "join") form.act.append(code);
      form.act.append(name, go, cancel);
      rows.push(form.row);
      queueMicrotask(() => (mode === "join" ? code : name).focus());
    }
    rows.push(relayRow(st));
    return rows;
  }

  const online = st.members.filter((m) => m.online).length;
  if (st.phase === "online") {
    text.innerHTML = `<span class="ok"></span> <span class="as"></span> <b></b> · <span class="n"></span>`;
    text.querySelector(".ok")!.textContent = t("team.connected");
    text.querySelector(".as")!.textContent = t("team.asWord");
    text.querySelector("b")!.textContent = st.config.name;
    text.querySelector(".n")!.textContent = tn(online, "team.online");
  } else if (!st.relayEffective) {
    text.innerHTML = `<span class="bad"></span>`;
    text.querySelector(".bad")!.textContent = t("team.noRelay");
  } else {
    text.textContent = t("team.connecting");
  }

  const copy = h("button", "ghost md", `${icon("copy", 12)} <span></span>`);
  copy.querySelector("span")!.textContent = t("team.copyInvite");
  copy.title = t("team.copyInvite.title");
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(team.invite() ?? "");
    ctx.say(t("team.copied"));
  });
  const leave = h("button", "ghost md", t("team.leave"));
  leave.title = t("team.leave.title");
  leave.addEventListener("click", () => run(() => team.leave()));
  act.append(copy, leave);

  // Quem está no time, com quem está aí agora aceso.
  const who = sub(t("team.members"));
  const list = h("div", "members");
  for (const m of st.members) {
    const chip = h("span", "mem" + (m.online ? "" : " off"), `${avatar(m.name)}<span class="nm"></span><i class="dot"></i>`);
    chip.querySelector(".nm")!.textContent = m.id === st.you ? `${m.name} (${t("team.you")})` : m.name;
    chip.title = m.online ? "" : t("team.offline");
    list.append(chip);
  }
  who.txt.append(list);
  rows.push(who.row);

  const me = sub(t("team.yourName"));
  const name = field(t("team.yourName"), st.config.name, () => {});
  name.title = t("team.rename.title");
  const save = () => {
    if (name.value.trim() && name.value.trim() !== st.config!.name) run(() => team.setName(name.value));
  };
  name.addEventListener("keydown", (e) => e.key === "Enter" && save());
  name.addEventListener("blur", save);
  me.act.append(name);
  rows.push(me.row);

  rows.push(relayRow(st));
  return rows;
}

/// Onde o time se encontra. Quase ninguém mexe: é para quem hospeda o próprio
/// relay, e para o dev apontar para o `wrangler dev`.
function relayRow(st: team.TeamStatus): HTMLElement {
  const r = sub(t("team.relay"));
  const body = h("span", "", "");
  body.textContent = st.relayDefault ? t("team.relay.body", { url: st.relayDefault }) : t("team.relay.none");
  r.txt.append(body);
  const url = field(t("team.relay.placeholder"), draft.relay ?? st.relay, (v) => (draft.relay = v));
  url.classList.add("wide");
  const save = h("button", "ghost md", t("team.relay.save"));
  const go = () =>
    run(async () => {
      await team.setRelay(url.value);
      draft.relay = null;
    });
  save.addEventListener("click", go);
  url.addEventListener("keydown", (e) => e.key === "Enter" && go());
  r.act.append(url, save);
  return r.row;
}
