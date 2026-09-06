import { invoke } from "./ipc";
import * as dock from "./dock";
import { icon, wave } from "./icons";
import { fromBack, t } from "./i18n";
import * as menu from "./menu";
import { isTerm, termKind, termNumber, type DockKind, type DockState, type Scripts } from "./types";
import { $ } from "./util";

/// O dock, que mora em dois lugares. Setup e Run continuam no painel da
/// direita: é saída para acompanhar de canto enquanto se fala com o agente. O
/// terminal livre, não — ele é aba do centro, ao lado das conversas, porque é
/// onde se trabalha e trabalhar pede a tela.
///
/// Quem desenha os dois terminais é o `dock`; aqui mora só o que o repositório
/// declara, o que está de pé, e o que os botões fazem. A faixa da direita é
/// desenhada aqui; a do centro é do `workspace`, com o que `tabs()` conta.

const NO_SCRIPTS: Scripts = { file: null, inherited: false, setup: null, runs: [], archive: null, copy: [], port: null };

/// O que o repositório declara e o que existe no dock agora. Vem do back quando
/// o workspace abre e sempre que um script sobe ou morre — nada de polling.
let info: { scripts: Scripts; docks: DockState[] } = { scripts: NO_SCRIPTS, docks: [] };
/// Qual `[scripts.run.<nome>]` o botão dispara. Vazio é o padrão do repositório.
let runName: string | undefined;
/// Qual script está na frente do painel da direita.
let pane: DockKind | null = null;
/// Qual terminal livre está na aba do centro. `null` é o centro com outra
/// coisa — a conversa, um arquivo, o diff ou o navegador.
let shell: DockKind | null = null;
let open = true;
/// Terminais pedidos e ainda não confirmados pelo back. Dois cliques no + em
/// sequência disputariam o mesmo número sem isto: o segundo escolhe o próximo
/// livre antes de o primeiro aparecer no `dock_state`, e um dos dois sumiria.
const asked = new Set<DockKind>();

type Ctx = {
  workspace: () => string | null;
  say: (m: string, err?: boolean) => void;
  /// Abre um arquivo do worktree no visualizador do centro.
  openFile: (path: string) => Promise<void>;
  /// Conversa nova já com uma primeira fala.
  newTab: (prompt: string) => Promise<void>;
  /// A aba de navegador no centro, na porta do Run.
  openBrowser: () => Promise<void>;
  /// Traz o terminal para o centro, tirando de lá o que estava.
  enter: () => void;
  /// Devolve o centro à conversa: o último terminal fechou.
  exit: () => void;
  /// Redesenha a faixa de abas do centro, que é onde as de terminal moram.
  drawTabs: () => void;
};
let ctx: Ctx;

const isUp = (kind: DockKind) => info.docks.some((d) => d.kind === kind && d.alive);
/// Rodou e morreu: a rolagem ainda está lá, com o `✗ saiu com código` no fim.
const hasLog = (kind: DockKind) => info.docks.some((d) => d.kind === kind);
/// Setup conta a cópia do clone junto com o script: worktree que só recebe o
/// `.env` também tem o que mostrar na aba, e é ali que se vê o que veio.
const declares = (kind: DockKind) =>
  kind === "setup"
    ? !!info.scripts.setup || info.scripts.copy.length > 0
    : info.scripts.runs.length > 0;

/// As abas de shell abertas, em ordem. Não são fixas como Setup e Run: nascem
/// no +, somem no ✕, e é o back que sabe quais existem — trocar de workspace
/// tem que trazer de volta exatamente as do outro.
function terminals(): DockKind[] {
  const live = info.docks.map((d) => d.kind).filter(isTerm);
  // As recém-pedidas ainda não existem no back: sem elas a aba sumiria entre o
  // clique no + e a resposta do `dock_state`.
  return [...new Set([...live, ...asked])].sort((a, b) => termNumber(a) - termNumber(b));
}

/// A faixa da direita: só os scripts. Terminal livre é aba do centro.
const order = (): DockKind[] => ["setup", "run"];

const label = (kind: DockKind) => {
  if (kind === "setup") return t("dock.setup");
  if (kind === "run") return t("dock.run");
  const n = termNumber(kind);
  return n === 1 ? t("dock.terminal") : t("dock.terminalN", { n });
};

/// O menor número livre, e não o próximo de um contador: fechar o Terminal 2 e
/// pedir outro devolve o 2, em vez de deixar a barra virar uma fila com buracos
/// e números que só crescem.
function nextTerm(): DockKind {
  const taken = new Set(terminals().map(termNumber));
  let n = 1;
  while (taken.has(n)) n++;
  return termKind(n);
}

export function init(context: Ctx) {
  ctx = context;

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
      {
        // Herdado do clone: não há arquivo aqui para abrir. O que o clique faz
        // é trazer uma cópia — e o rótulo diz isso, para ninguém achar que
        // editou o do clone.
        label: t(info.scripts.inherited ? "dock.settings.copy" : "dock.settings.open"),
        glyph: icon("file", 14),
        run: writeScriptsFile,
      },
    ]);
  });
  // Clique abre a aba de navegador; ⌥-clique vai para o navegador de fora,
  // que é onde o agente enxerga a página e onde se confere o que só o Chrome faz.
  $("run-open").addEventListener("click", (e) => {
    const id = ctx.workspace();
    if (!id) return;
    if (e.altKey) invoke("open_run", { id }).catch((e) => ctx.say(fromBack(e), true));
    else void ctx.openBrowser();
  });
  $("dock-again").addEventListener("click", () => setDock("setup", true));
  $("dock-toggle").addEventListener("click", () => {
    open = !open;
    draw();
  });
  draw();
}

/// Trocar de workspace zera o painel — o processo do outro continua vivo, mas
/// o que a barra diz é do worktree que você está olhando.
/// `panel` desligado é o projeto sem workspace: ali não há Setup nem Run —
/// nenhum script é do clone —, e o que sobra do dock é o terminal livre.
export function reset(panel = true) {
  pane = null;
  shell = null;
  asked.clear();
  runName = undefined;
  info = { scripts: NO_SCRIPTS, docks: [] };
  dock.detach();
  draw();
  // Entrar num workspace cai no Setup: é a saída do que rodou quando o worktree
  // nasceu — inclusive o erro, quando ele falhou. Olhar não sobe processo
  // nenhum, e abrir sempre numa aba evita a tela que só repetia as três.
  void refresh().then(() => {
    if (panel && pane === null) void setDock("setup");
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
  if (!id || !key.startsWith(`${id}:`)) return;
  const kind = key.slice(id.length + 1) as DockKind;
  // Shell que saiu no `exit` não deixa log que valha uma aba: ela some, como
  // num terminal de verdade. Script que morreu fica — a rolagem com o
  // `✗ saiu com código` no fim é justamente o que a aba dele tem para mostrar.
  if (isTerm(kind)) void closeTerm(kind);
  else void refresh();
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
    if (start || isUp(next)) {
      await dock.open(id, next, next === "run" ? runName : undefined);
      dock.focus("scripts");
    } else if (hasLog(next)) {
      // Morreu: só a rolagem, sem reiniciar. É aqui que o setup de ontem
      // continua dizendo que falhou.
      await dock.show(id, next);
    } else {
      dock.detach();
    }
  } catch (err) {
    ctx.say(fromBack(err), true);
  }
  await refresh();
}

/// O terminal livre na aba do centro. Escolher um que já existe não reinicia
/// nada: `open_dock` devolve o mesmo pty, e a rolagem guardada redesenha.
async function setShell(kind: DockKind) {
  const id = ctx.workspace();
  if (!id) return;
  shell = kind;
  asked.add(kind);
  ctx.enter();
  ctx.drawTabs();
  try {
    await dock.open(id, kind);
    dock.focus("shell");
  } catch (err) {
    ctx.say(fromBack(err), true);
  }
  await refresh();
  // Agora o `dock_state` já conhece esta aba — ou a abertura falhou, e ela não
  // pode ficar na barra pedindo um terminal que não existe.
  asked.delete(kind);
}

/// O que a faixa do centro precisa saber para desenhar as abas de terminal.
export type DockTab = { kind: DockKind; label: string; on: boolean };

export const tabs = (): DockTab[] =>
  terminals().map((kind) => ({ kind, label: label(kind), on: shell === kind }));

/// Qual terminal está no centro, para a faixa saber que nenhuma conversa é a
/// da frente.
export const front = () => shell;

export const select = (kind: DockKind) => void setShell(kind);
export const closeTab = (kind: DockKind) => void closeTerm(kind);
export const newTerm = () => void setShell(nextTerm());

/// Outra coisa foi para o centro. Nada morre: o processo segue, a rolagem
/// continua guardada, e a aba só deixa de estar na frente.
export function leave() {
  if (shell === null) return;
  shell = null;
  ctx.drawTabs();
}

/// Fecha uma aba de terminal: mata o shell e tira a aba da barra. Não é o mesmo
/// que encerrar um script — o Setup continua existindo depois de morrer, porque
/// a rolagem dele é o que a aba mostra; um shell que saiu não deixa nada.
async function closeTerm(kind: DockKind) {
  const id = ctx.workspace();
  if (!id) return;
  const bar = terminals();
  const at = bar.indexOf(kind);
  const wasOn = shell === kind;
  // Sai das duas listas antes de ir ao back: `terminals()` desenha a união
  // delas, e a aba piscaria de volta no desenho do meio do caminho.
  info.docks = info.docks.filter((d) => d.kind !== kind);
  asked.delete(kind);
  if (wasOn) shell = null;
  await dock.kill(id, kind);
  // Cai na vizinha da direita; sem vizinha, na da esquerda. Sem nenhuma das
  // duas, o centro volta para a conversa — que é de onde ele veio.
  if (wasOn) {
    const next = bar[at + 1] ?? bar[at - 1];
    if (next) await setShell(next);
    else ctx.exit();
  }
  ctx.drawTabs();
  await refresh();
}

/// ⌘W com o cursor dentro do terminal fecha o terminal, e não a conversa que
/// está atrás dele. Fora dele a tecla não é nossa: quem responde é o
/// `workspace`.
export function closeFocused(): boolean {
  if (!shell || !$("termview").contains(document.activeElement)) return false;
  void closeTerm(shell);
  return true;
}

/// Encerra o processo de uma aba fixa. Diferente de fechar terminal: a aba
/// continua na barra, agora pedindo para rodar de novo.
async function killPane(kind: DockKind) {
  const id = ctx.workspace();
  if (!id) return;
  await dock.kill(id, kind);
  await refresh();
}

export function draw() {
  $("dock").classList.toggle("closed", !open);
  $("dock-toggle").innerHTML = icon(open ? "chevron-down" : "chevron-right");
  $("dock-toggle").title = t(open ? "dock.collapse" : "dock.expand");
  drawStrip();
  // As abas de terminal são do centro, e mudam com o que o back conta aqui.
  ctx.drawTabs();

  // O botão de Run mora na barra e não na aba: ⌘R é o mesmo esteja qual estiver
  // na frente, e é a mesma pergunta com as duas respostas.
  const up = isUp("run");
  $("runsplit").hidden = !info.scripts.runs.length;
  $("run-pick").hidden = info.scripts.runs.length < 2;
  $("run-go").innerHTML = `${icon(up ? "square" : "play", 13)}<span></span><kbd>⌘R</kbd>`;
  $("run-go").querySelector("span")!.textContent = t(up ? "dock.stop" : "dock.run");

  // Abrir no navegador só existe com o run de pé e porta reservada: é quase
  // certeza de servidor em localhost — e sumir quando ele morre também é
  // informação.
  const goOpen = $("run-open");
  const port = info.scripts.port;
  goOpen.hidden = !up || !port;
  if (port && !goOpen.hidden) {
    goOpen.innerHTML = `${icon("globe", 13)}<span></span><span class="port">:${port}</span>`;
    goOpen.querySelector("span")!.textContent = t("dock.open");
    goOpen.title = t("dock.open.title", { port });
  }

  const filled = pane !== null && (isUp(pane) || hasLog(pane));
  $("dockwrap").hidden = !filled;
  $("dockempty").hidden = filled;
  // Setup que rodou e morreu: a rolagem fica na frente, e rodar de novo é este
  // botão — o de Run já é o da barra.
  $("dock-again").hidden = !(pane === "setup" && hasLog("setup") && !isUp("setup"));
  if (!filled) drawEmpty();
}

/// A faixa da direita: Setup e Run. Montada a cada desenho porque a onda e o
/// ✕ dependem do que está de pé.
function drawStrip() {
  const strip = $("dockstrip");
  strip.replaceChildren();

  for (const kind of order()) {
    const b = document.createElement("button");
    b.className = "docktab" + (pane === kind ? " on" : "");
    // A onda anda enquanto o script está de pé: o run continua rodando com o
    // painel em Setup, e sem isto não haveria como saber que ele está lá.
    if (isUp(kind)) b.insertAdjacentHTML("beforeend", wave());
    const name = document.createElement("span");
    name.textContent = label(kind);
    b.append(name);
    // Clicar na aba aberta recolhe: é assim que se some com a saída sem matar o
    // processo que a produziu.
    b.addEventListener("click", () => setDock(open && pane === kind ? null : kind));

    // Setup, enquanto vivo, encerra. A aba fica: a rolagem dele é o que ela
    // tem para mostrar depois.
    if (kind === "setup" && isUp(kind)) {
      const x = document.createElement("span");
      x.className = "tabx ico sm";
      x.innerHTML = icon("x", 12);
      x.title = t("dock.killSetup");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        void killPane(kind);
      });
      b.append(x);
    }
    strip.append(b);
  }
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
  // sumir com a saída. As abas estão logo acima; repetir os nomes aqui era
  // desenhar o mesmo botão duas vezes na mesma tela.
  if (pane === null) {
    title("");
    $("empty-sub").textContent = t("dock.idle");
    return;
  }

  if (!declares(pane)) {
    title(t(pane === "setup" ? "dock.noSetup.title" : "dock.noRun.title"));
    $("empty-sub").textContent = t(pane === "setup" ? "dock.noSetup.body" : "dock.noRun.body");
    button(t("dock.ask"), "outline", askForScripts);
    button(t("dock.write"), "ghost", writeScriptsFile);
    return;
  }

  // Há script e não há processo: falta o clique.
  const setup = pane === "setup";
  const port = info.scripts.port;
  glyph.hidden = false;
  glyph.className = setup ? "glyph" : "glyph solid";
  glyph.innerHTML = icon(setup ? "rotate" : "play", 56);
  title(t(setup ? "dock.setup.idle.title" : "dock.run.idle.title"));
  // O ⌘R é do Run e só dele: escrevê-lo no botão do setup seria prometer um
  // atalho que dispara outra coisa.
  button(
    t(setup ? "dock.setup.start" : "dock.run.start"),
    "outline",
    () => setDock(pane, true),
    setup ? undefined : "⌘R",
  );
  $("empty-sub").textContent = setup
    ? t("dock.setup.idle.body")
    : port
      ? t("dock.run.idle.port", { port })
      : t("dock.run.idle.body");
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
    ctx.say(fromBack(err), true);
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
    ctx.say(fromBack(err), true);
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
