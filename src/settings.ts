import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { icon } from "./icons";
import { LANGS, choose, chosen, fromBack, fromSystem, t, type Lang } from "./i18n";
import * as menu from "./menu";
import type { LinearStatus } from "./types";
import { settingsRow } from "./update";
import { $, h } from "./util";

/// Configurações do app — o que não é do repositório (isso é o
/// `settings.toml`) nem de um workspace: a conexão com o Linear, a linha de
/// atualização (que mora em `update.ts`) e o idioma da tela. A página é a
/// terceira tela do app, ao lado do quadro e do workspace, e entra no
/// histórico ← → como as outras.
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
}

/// O que o resto do app pergunta: tem Linear para puxar issue?
export const linear = () => status;

export function draw() {
  const view = $("settingsView");
  const page = h("div", "setpage", `<h1></h1><h2></h2>`);
  page.children[0].textContent = t("settings.title");
  page.children[1].textContent = t("settings.integrations");
  page.append(linearRow());
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
