import * as dock from "./dock";
import { icon } from "./icons";
import { $ } from "./util";

/// A barra do dock: Run, Terminal, recolher e encerrar. Quem desenha o
/// terminal é o `dock`; aqui mora só qual painel está aberto e o que os botões
/// fazem.

type Pane = "run" | "terminal";

let pane: Pane | null = null;
let open = true;
let workspace: () => string | null = () => null;
let fail: (m: string) => void = () => {};

export function init(ctx: { workspace: () => string | null; say: (m: string, err?: boolean) => void }) {
  workspace = ctx.workspace;
  fail = (m) => ctx.say(m, true);

  $("dock-run").addEventListener("click", () => show("run"));
  $("dock-term").addEventListener("click", () => show("terminal"));
  $("empty-run").addEventListener("click", () => show("run"));
  $("empty-term").addEventListener("click", () => show("terminal"));
  $("dock-toggle").addEventListener("click", () => {
    open = !open;
    draw();
  });
  $("dock-kill").addEventListener("click", () => {
    const id = workspace();
    if (!id || !pane) return;
    dock.kill(id, pane);
    pane = null;
    draw();
  });
  draw();
}

/// Trocar de workspace fecha o painel — o processo do outro continua vivo, mas
/// o terminal na tela é do worktree que você está olhando.
export function reset() {
  pane = null;
  dock.detach();
  draw();
}

async function show(next: Pane) {
  const id = workspace();
  if (!id) return;
  // Clicar no painel que já está aberto fecha, como uma gaveta.
  pane = open && pane === next ? null : next;
  open = true;
  draw();
  if (!pane) return dock.detach();
  try {
    await dock.open(id, next);
    dock.focus();
  } catch (err) {
    pane = null;
    draw();
    fail(String(err));
  }
}

export function draw() {
  $("dock").classList.toggle("closed", !open);
  $("dock-toggle").innerHTML = icon(open ? "chevron-down" : "chevron-right");
  $("dock-toggle").title = open ? "Recolher" : "Expandir";
  $("dock-run").classList.toggle("on", pane === "run");
  $("dock-term").classList.toggle("on", pane === "terminal");
  $("dockwrap").hidden = pane === null;
  $("dockempty").hidden = pane !== null;
  $("dock-kill").hidden = pane === null;
}
