import { invoke } from "@tauri-apps/api/core";
import * as dock from "./dock";
import { icon } from "./icons";
import * as menu from "./menu";
import type { DockKind, DockState, Scripts } from "./types";
import { $ } from "./util";

/// A barra do dock: Setup, Run, Terminal, e o que cada aba oferece quando não
/// há processo nenhum na frente. Quem desenha o terminal é o `dock`; aqui mora
/// só o que o repositório declara, o que está de pé, e o que os botões fazem.

const NO_SCRIPTS: Scripts = { file: null, setup: null, runs: [], archive: null, port: null };

/// O que o repositório declara e o que existe no dock agora. Vem do back quando
/// o workspace abre e sempre que um script sobe ou morre — nada de polling.
let info: { scripts: Scripts; docks: DockState[] } = { scripts: NO_SCRIPTS, docks: [] };
/// Qual `[scripts.run.<nome>]` o botão dispara. Vazio é o padrão do repositório.
let runName: string | undefined;
let pane: DockKind | null = null;
let open = true;

type Ctx = {
  workspace: () => string | null;
  say: (m: string, err?: boolean) => void;
  /// Abre um arquivo do worktree no visualizador do centro.
  openFile: (path: string) => Promise<void>;
  /// Conversa nova já com uma primeira fala.
  newTab: (prompt: string) => Promise<void>;
};
let ctx: Ctx;

const isUp = (kind: DockKind) => info.docks.some((d) => d.kind === kind && d.alive);
/// Rodou e morreu: a rolagem ainda está lá, com o `✗ saiu com código` no fim.
const hasLog = (kind: DockKind) => info.docks.some((d) => d.kind === kind);
const declares = (kind: DockKind) =>
  kind === "setup" ? !!info.scripts.setup : info.scripts.runs.length > 0;

const TABS = [
  ["dock-setup", "setup"],
  ["dock-run", "run"],
  ["dock-term", "terminal"],
] as const;

export function init(context: Ctx) {
  ctx = context;

  for (const [id, kind] of TABS) {
    // Clicar na aba aberta recolhe: é assim que se some com a saída sem matar o
    // processo que a produziu.
    $(id).addEventListener("click", () => setDock(open && pane === kind ? null : kind));
  }
  $("run-go").addEventListener("click", toggleRun);
  $("run-pick").addEventListener("click", (e) => {
    const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const chosen = runName ?? info.scripts.runs[0]?.name;
    menu.openAt({ x: at.left - 40, y: at.bottom + 4 }, [
      ...info.scripts.runs.map((r) => ({
        label: r.name,
        hint: r.command.length > 36 ? `${r.command.slice(0, 35)}…` : r.command,
        checked: chosen === r.name,
        run: async () => {
          runName = r.name;
          const id = ctx.workspace();
          if (id && isUp("run")) await dock.kill(id, "run");
          setDock("run", true);
        },
      })),
      "sep",
      { label: "Abrir o settings.toml", glyph: icon("file", 14), run: writeScriptsFile },
    ]);
  });
  $("dock-again").addEventListener("click", () => setDock("setup", true));
  $("dock-toggle").addEventListener("click", () => {
    open = !open;
    draw();
  });
  $("dock-kill").addEventListener("click", async () => {
    const id = ctx.workspace();
    if (!id || !pane) return;
    await dock.kill(id, pane);
    refresh();
  });
  draw();
}

/// Trocar de workspace zera o painel — o processo do outro continua vivo, mas
/// o que a barra diz é do worktree que você está olhando.
export function reset() {
  pane = null;
  runName = undefined;
  info = { scripts: NO_SCRIPTS, docks: [] };
  dock.detach();
  draw();
  // Entrar num workspace cai no Setup: é a saída do que rodou quando o worktree
  // nasceu — inclusive o erro, quando ele falhou. Olhar não sobe processo
  // nenhum, e abrir sempre numa aba evita a tela que só repetia as três.
  void refresh().then(() => {
    if (pane === null) void setDock("setup");
  });
}

/// O que o repositório declara e o que está de pé, do back.
export async function refresh() {
  const id = ctx.workspace();
  if (!id) return;
  const [scripts, docks] = await Promise.all([
    invoke<Scripts>("workspace_scripts", { id }),
    invoke<DockState[]>("dock_state", { id }),
  ]);
  // Trocar de workspace no meio da ida ao back deixaria o painel falando do
  // repositório errado.
  if (ctx.workspace() !== id) return;
  info = { scripts, docks };
  draw();
}

/// Um dock deste workspace morreu sozinho — terminou, ou quebrou.
export function closed(key: string) {
  const id = ctx.workspace();
  if (id && key.startsWith(`${id}:`)) refresh();
}

/// Escolhe a aba. `start` é o único jeito de um script começar: abrir a aba só
/// anexa ao que já está de pé, senão olhar o log de ontem viraria subir servidor.
async function setDock(next: DockKind | null, start = false) {
  const id = ctx.workspace();
  if (!id) return;
  pane = next;
  open = true;
  draw();
  if (!next) return dock.detach();
  try {
    if (next === "terminal" || start || isUp(next)) {
      await dock.open(id, next, next === "run" ? runName : undefined);
      dock.focus();
    } else if (hasLog(next)) {
      // Morreu: só a rolagem, sem reiniciar. É aqui que o setup de ontem
      // continua dizendo que falhou.
      await dock.show(id, next);
    } else {
      dock.detach();
    }
  } catch (err) {
    ctx.say(String(err), true);
  }
  await refresh();
}

export function draw() {
  $("dock").classList.toggle("closed", !open);
  $("dock-toggle").innerHTML = icon(open ? "chevron-down" : "chevron-right");
  $("dock-toggle").title = open ? "Recolher" : "Expandir";
  for (const [id, kind] of TABS) {
    $(id).classList.toggle("on", pane === kind);
    // Ponto na aba do que está rodando: o run continua de pé com o painel em
    // Setup, e sem isto não haveria como saber que ele está lá.
    $(id).classList.toggle("live", isUp(kind));
  }

  // O botão de Run mora na barra e não na aba: ⌘R é o mesmo esteja qual estiver
  // na frente, e é a mesma pergunta com as duas respostas.
  const up = isUp("run");
  $("runsplit").hidden = !info.scripts.runs.length;
  $("run-pick").hidden = info.scripts.runs.length < 2;
  $("run-go").innerHTML =
    `${icon(up ? "square" : "play", 13)}<span>${up ? "Parar" : "Run"}</span><kbd>⌘R</kbd>`;

  const live = pane !== null && (pane === "terminal" || isUp(pane) || hasLog(pane));
  $("dockwrap").hidden = !live;
  $("dockempty").hidden = live;
  // No painel de Run quem encerra é o "Parar" ao lado: dois botões para a mesma
  // coisa, e a barra fica larga demais para caber os três nomes de aba.
  const alive = pane !== null && isUp(pane);
  $("dock-kill").hidden = !alive || pane === "run";
  // Setup que rodou e morreu: a rolagem fica na frente, e rodar de novo é este
  // botão — o de Run já é o da barra.
  $("dock-again").hidden = !(pane === "setup" && hasLog("setup") && !isUp("setup"));
  if (!live) drawEmpty();
}

/// O que a aba diz quando não há processo na frente. Muda com o que falta: um
/// repositório que não declara nada precisa de um script; um que declara
/// precisa de um clique. Um botão só chama a ação — o outro, quando existe, é
/// a saída alternativa, e por isso não disputa o olho com ele.
function drawEmpty() {
  const row = $("empty-row");
  row.replaceChildren();
  const glyph = $("empty-glyph");
  glyph.hidden = true;
  glyph.className = "glyph";
  $("dockempty").classList.toggle("idle", pane === null);

  const button = (label: string, cls: string, run: () => void, key?: string) => {
    const b = document.createElement("button");
    b.className = cls;
    b.innerHTML = `<span></span>${key ? `<kbd>${key}</kbd>` : ""}`;
    b.firstElementChild!.textContent = label;
    b.addEventListener("click", run);
    row.append(b);
  };
  const title = (text: string) => {
    $("empty-title").textContent = text;
    $("empty-title").hidden = !text;
  };

  // Sem aba na frente — só se acontece depois de clicar na aba aberta para
  // sumir com a saída. As três abas estão logo acima; repetir os nomes aqui
  // era desenhar o mesmo botão duas vezes na mesma tela.
  if (pane === null) {
    title("");
    $("empty-sub").textContent = "Setup prepara o worktree, Run sobe o projeto, Terminal é um shell aqui dentro.";
    return;
  }

  if (!declares(pane)) {
    title(pane === "setup" ? "Sem script de setup" : "Sem script de run");
    $("empty-sub").textContent =
      pane === "setup"
        ? "Comandos que rodam quando um worktree nasce, para instalar dependências e preparar o ambiente."
        : "O comando que sobe o projeto, para você testar a mudança sem sair daqui.";
    button("Perguntar ao agente", "outline", askForScripts);
    button("Escrever à mão", "ghost", writeScriptsFile);
    return;
  }

  // Há script e não há processo: falta o clique.
  const setup = pane === "setup";
  const port = info.scripts.port;
  glyph.hidden = false;
  glyph.className = setup ? "glyph" : "glyph solid";
  glyph.innerHTML = icon(setup ? "rotate" : "play", 56);
  title(setup ? "Sem saída do setup" : "Nada rodando");
  // O ⌘R é do Run e só dele: escrevê-lo no botão do setup seria prometer um
  // atalho que dispara outra coisa.
  button(setup ? "Rodar setup" : "Iniciar Run", "outline", () => setDock(pane, true), setup ? undefined : "⌘R");
  $("empty-sub").textContent = setup
    ? "O setup já rodou quando este worktree nasceu. Rodar de novo é seguro se ele for idempotente."
    : `Teste sua mudança aqui.${port ? ` $PROMETHEUS_PORT é ${port}.` : ""}`;
}

/// Manda o próprio agente ler o repositório e escrever o settings.toml. Conversa
/// nova, e não a que está aberta: o assunto é outro, e o contexto de agora não
/// tem que pagar por isto.
async function askForScripts() {
  const id = ctx.workspace();
  if (!id) return;
  try {
    await ctx.newTab(await invoke<string>("scripts_prompt", { id }));
  } catch (err) {
    ctx.say(String(err), true);
  }
}

/// Cria o arquivo com o exemplo comentado e abre no visualizador — que é onde
/// se vê o que dá para escrever antes de ir para o editor.
async function writeScriptsFile() {
  const id = ctx.workspace();
  if (!id) return;
  try {
    await ctx.openFile(await invoke<string>("create_scripts_file", { id }));
    await refresh();
  } catch (err) {
    ctx.say(String(err), true);
  }
}

/// ⌘R. Sem script declarado, leva para a aba que pede um — que é a resposta
/// certa para "eu quis rodar e não dá".
export async function toggleRun() {
  const id = ctx.workspace();
  if (!id) return;
  if (!info.scripts.runs.length) return setDock("run");
  if (!isUp("run")) return setDock("run", true);
  await dock.kill(id, "run");
  await refresh();
}
