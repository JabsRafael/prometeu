import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { icon } from "./icons";
import type { LinearStatus } from "./types";
import { settingsRow } from "./update";
import { $, h } from "./util";

/// Configurações do app — o que não é do repositório (isso é o
/// `settings.toml`) nem de um workspace: a conexão com o Linear e a linha de
/// atualização, que é quem mora em `update.ts`. A página é a terceira tela do
/// app, ao lado do quadro e do workspace, e entra no histórico ← → como as
/// outras.
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
  const page = h("div", "setpage", `<h1>Configurações</h1><h2>Integrações</h2>`);
  page.append(linearRow());
  page.append(h("h2", "", "Aplicativo"), settingsRow());
  view.replaceChildren(page);
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
    text.innerHTML = `<span class="ok">Conectado</span> como <b></b> · <b></b>`;
    text.querySelectorAll("b")[0].textContent = name || status.who.email;
    text.querySelectorAll("b")[1].textContent = org || status.who.org_key;

    const off = h("button", "ghost md", "Desconectar") as HTMLButtonElement;
    off.title = "Apaga a conexão deste Mac. As issues somem do lançador; nada muda no Linear";
    off.addEventListener("click", async () => {
      off.disabled = true;
      try {
        status = await invoke<LinearStatus>("linear_disconnect");
      } catch (e) {
        ctx.say(String(e), true);
      }
      draw();
    });
    act.append(off);
    return row;
  }

  text.textContent = status.busy
    ? "Esperando você aprovar no navegador…"
    : "Conecte para criar workspaces a partir das suas issues.";

  const on = h("button", "outline md", `Conectar Linear ${icon("external-link", 12)}`) as HTMLButtonElement;
  on.disabled = status.busy;
  on.title = "Abre o Linear no navegador para você autorizar o Prometheus. Só leitura, e só neste Mac";
  on.addEventListener("click", async () => {
    on.disabled = true;
    status = { ...status, busy: true };
    draw();
    try {
      status = await invoke<LinearStatus>("linear_connect");
    } catch (e) {
      status = { ...status, busy: false };
      ctx.say(String(e), true);
    }
    draw();
  });
  act.append(on);
  return row;
}
