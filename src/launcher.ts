import { dropdown, type Group } from "./ui";
export type { Group } from "./ui";
import { open } from "@tauri-apps/plugin-dialog";
import {
  capabilitiesOf,
  descriptors,
  effortsOf,
  installed,
  isKnownModel,
  modelLabelOf,
  modelsOf,
  providerOfModel,
  usesNativeUltraLabel,
} from "./agents";
import { freshBranch } from "./branch";
import { avatar, icon } from "./icons";
import { paint, t } from "./i18n";
import * as issues from "./issues";
import * as mcp from "./mcp";
import * as plugins from "./plugins";
import * as menu from "./menu";
import { invoke } from "./ipc";
import { template } from "./util";
import { branchTaken, type Board, type Issue, type IssueRef, type ProviderId, type Workspace } from "./types";

export type Draft = {
  project: string;
  /// Os outros repositórios do workspace, quando a funcionalidade atravessa
  /// mais de um: cada um ganha um worktree na mesma branch, ao lado do do
  /// `project`. Só com worktree — é a pasta que os reúne que o agente abre.
  extras: string[];
  branch: string;
  /// De onde a branch nova sai. Vazio só enquanto a lista não chegou.
  base: string;
  /// Ligado, a branch ganha um worktree só dela. Desligado, ela nasce no
  /// próprio repositório — o clone de sempre é que troca de branch.
  worktree: boolean;
  /// Desligado, não nasce branch nenhuma: a sessão abre no repositório do jeito
  /// que ele está. Só existe sem worktree — worktree sempre quer a sua branch.
  newBranch: boolean;
  title: string;
  stage: string;
  prompt: string;
  inject: string[];
  /// A issue do Linear de onde o workspace sai, quando sai de uma: o nome, a
  /// branch e a primeira fala nascem dela.
  issue: IssueRef | null;
  /// Qual CLI roda nas abas. Não é escolha à parte — sai do modelo, porque o
  /// catálogo já associa explicitamente cada modelo ao seu provider.
  agent: ProviderId;
  /// O modelo: um alias do Claude Code (`opus`, `sonnet[1m]`…) ou um slug do
  /// Codex (`gpt-5.6-sol`). Sempre um dos dois — não há "deixa o CLI escolher"
  /// para escolher. Vale para o workspace inteiro.
  model: string;
  /// `--effort`, `low`…`max` ou `ultracode`. O lançador sempre escolhe um;
  /// vazio (workspace antigo) é não passar. Também do workspace.
  effort: string;
  /// Nasce em plan mode: o agente lê e planeja, e o card "plano pronto" é o
  /// que o solta. Só desta primeira conversa.
  plan: boolean;
  /// Quais servidores de MCP as conversas deste workspace enxergam. `null` é
  /// não escolher — e aí o CLI decide, como decidia antes do hub existir. É o
  /// que vale para quem nunca abriu o seletor: ligar a escolha sozinho tiraria
  /// do agente o `~/.claude.json` que a pessoa já tinha.
  mcp: string[] | null;
  /// Quais plugins as conversas deste workspace carregam, pela mesma regra do
  /// MCP: `null` é não escolher, e aí o CLI carrega o que sempre carregou.
  plugins: string[] | null;
};

type Branches = { all: string[]; default: string };

/// Sempre solto (`--dangerously-skip-permissions`): não há chavinha. Agente
/// que para a cada `Write` não trabalha enquanto você olha outra coisa, e é
/// isso que permite acompanhar outras sessões enquanto ele trabalha.

/// Qual CLI um modelo escolhe: escolher um GPT é escolher o Codex, e não há
/// botão à parte para isso — nem no lançador, nem na barra de abas.
export const agentOf = providerOfModel;

/// Os blocos do dropdown de modelo: os do Claude Code de um lado, os do Codex
/// do outro, só os que esta máquina tem. A barra de abas abre a mesma lista —
/// escolher com quem a conversa nova fala é a mesma escolha que o lançador faz.
///
/// `only` restringe a um CLI: é o seletor da conversa de pé, onde trocar de
/// modelo é uma coisa e trocar de CLI é outra — o `--resume` do Claude Code
/// não abre a thread do Codex, e oferecer um GPT ali seria oferecer o fim da
/// conversa. Sem `only`, os dois blocos: é o do lançador e o do "+".
export function modelGroups(only?: ProviderId): Group[] {
  return installed()
    .filter((provider) => only === undefined || provider.id === only)
    .map((provider) => ({
      head: provider.label,
      items: modelsOf(provider.id).map((model) => [model.id, model.label] as [string, string]),
    }))
    .filter((group) => group.items.length > 0);
}

/// O degrau mais próximo que a escada deste modelo tem. Sair do Sol (que vai
/// até o `ultra`) para um modelo que para no `xhigh` não pode deixar para trás
/// um esforço que o CLI recusa.
export function fitsEffort(model: string, effort: string, provider = providerOfModel(model)): string {
  const stairs = ladderOf(model, provider);
  if (stairs.some(([id]) => id === effort)) return effort;
  return stairs[stairs.length - 1]?.[0] ?? "high";
}

/// O modelo com que o lançador abre quando não há nada lembrado: o primeiro da
/// lista. Sem `claude` na máquina é o primeiro do Codex — senão o rodapé
/// começaria apontando para um CLI que não existe.
const fallbackModel = () =>
  installed().flatMap((provider) => modelsOf(provider.id))[0]?.id ?? "";

/// A escada do esforço, na ordem em que o clique sobe. É o botão do Conductor:
/// barras que acendem uma a uma, e depois da última volta ao Baixo — sem
/// lista, porque são seis degraus e subir um é um clique só. Não há "padrão":
/// o lançador sempre diz um, e o primeiro é Alto, que é o que o CLI faria
/// sozinho. `ultracode` o CLI traduz em `xhigh` mais a orquestração de
/// workflows (subagentes em paralelo); só existe para conta com workflows
/// liberados.
const EFFORTS: [string, string][] = [
  ["low", t("effort.low")],
  ["medium", t("effort.medium")],
  ["high", t("effort.high")],
  ["xhigh", t("effort.xhigh")],
  ["max", t("effort.max")],
  ["ultracode", t("effort.ultracode")],
];

/// A escada de degraus que um modelo aceita. O Codex chama `ultra` o que o
/// Claude Code chama `ultracode`; o degrau é o mesmo, e o nome na tela é o do
/// CLI que vai rodar. No catálogo do Claude Code, `ultracode` não é degrau que
/// o CLI liste — é o `xhigh` com orquestração por cima, e quem tem um tem o
/// outro. Modelo sem escada publicada (o Haiku de hoje, ou o catálogo que
/// ainda não chegou) fica com a escada inteira, como sempre ficou.
function ladderOf(model: string, provider = providerOfModel(model)): [string, string][] {
  const accepted = effortsOf(provider, model);
  if (!accepted.length) return EFFORTS;
  return EFFORTS.filter(([id]) => accepted.includes(id)).map(([id, name]) => [
    id,
    id === "ultracode" ? t(usesNativeUltraLabel(provider) ? "effort.ultra" : "effort.ultracode") : name,
  ]);
}

/// O nome do modelo na tela — o mesmo do rodapé do lançador. É o que a caixa
/// de escrever mostra embaixo: quem está lendo a conversa quer saber com quem
/// está falando, e o alias (`opus[1m]`) não é isso.
export function modelLabel(model: string, provider?: ProviderId): string {
  return modelLabelOf(model, provider);
}

/// O degrau seguinte da escada deste modelo, dando a volta depois do último:
/// é o clique do botão de esforço, no lançador e na conversa de pé. Esforço
/// que a escada não tem cai no primeiro degrau.
export function nextEffort(model: string, effort: string, provider = providerOfModel(model)): string {
  const stairs = ladderOf(model, provider);
  const step = stairs.findIndex(([id]) => id === effort);
  return stairs[(step + 1) % stairs.length]?.[0] ?? effort;
}

/// O esforço como as barrinhas o desenham: em que degrau está, e de quantos.
/// Esforço que a escada deste modelo não tem não acende barra nenhuma.
export function effortStep(
  model: string,
  effort: string,
  provider = providerOfModel(model),
): { label: string; step: number; total: number } | null {
  const stairs = ladderOf(model, provider);
  const step = stairs.findIndex(([id]) => id === effort);
  if (step === -1) return null;
  return { label: stairs[step][1], step, total: stairs.length };
}

/// A escolha do worktree gruda entre lançamentos: quem trabalha de um jeito
/// trabalha do mesmo jeito amanhã, e refazer o clique toda vez cansa. Plan mode
/// não — é decisão de uma tarefa, não de um jeito.
const WORKTREE_KEY = "prometeu:worktree";
const BRANCH_KEY = "prometeu:branch-nova";

/// Com que modelo, esforço, MCP e plugins o lançador abre. Isto é escolha, e
/// não lembrança: quem quiser mudar vai em Configurações → Padrões. Antes eles
/// grudavam sozinhos — a última escolha virava a próxima —, e experimentar um
/// modelo numa tarefa mudava calado o começo de todas as outras.
///
/// Trocar dentro do lançador vale para aquele workspace e mais nada. As chaves
/// são as mesmas de quando grudavam sozinhos: quem já usava o app começa com o
/// que estava usando como padrão.
const MODEL_KEY = "prometeu:model";
const EFFORT_KEY = "prometeu:effort";
const MCP_KEY = "prometeu:mcp";
const PLUGIN_KEY = "prometeu:plugins";

/// Arquivo solto em cima do lançador aberto entra como anexo. É o `main.ts`
/// quem vê o drop (o Tauri entrega caminho de verdade só pela webview), e é
/// aqui que ele cai enquanto a folha estiver na tela.
let takeFiles: { put: (paths: string[]) => void; wait: () => () => void } | null = null;
export const fileDropTarget = () => takeFiles;

/// O lançador é uma caixa de texto e um seletor de projeto — o "Create" do
/// Conductor. O que dá para deduzir é deduzido, sem campo para editar: o nome
/// sai da primeira frase (renomeia-se no card), a branch ganha o dia e o horário, a
/// etapa é a segunda da lista. Criar é Enter.
///
/// Com `seed`, o workspace nasce de uma issue do Linear: a branch é a que o
/// Linear sugere (é o que faz ele reconhecer o PR), o nome é o identificador
/// e o título, e a primeira fala começa com a issue inteira — o que você
/// digitar vem depois, como instrução extra.
export type Open = {
  /// O projeto já escolhido — o do workspace aberto, ou o do + na barra.
  preset?: string;
  seed?: Issue;
  /// O painel Git abre a base ou a branch escolhida em um worktree separado.
  git?: { base: string; branch?: string };
  go: (d: Draft) => void;
  /// "Configurar Linear" no seletor de issue: fecha o lançador e vai lá.
  toSettings: () => void;
};

export function openLauncher(board: Board, opts: Open) {
  const veil = document.getElementById("veil")!;
  if (!board.projects.length) return;
  const { preset, go, git } = opts;
  const project = preset ?? board.projects[0].id;
  let seed = opts.seed;

  const draft: Draft = {
    project,
    extras: [],
    // Sem a lista de branches do repo ainda: `loadBranches` refaz o nome
    // assim que ela chega, e é ela que sabe se este já é de alguém.
    branch: git?.branch || seed?.branch_name || freshBranch([]),
    base: git?.base ?? "",
    worktree: !!git || localStorage.getItem(WORKTREE_KEY) !== "0",
    newBranch: !!git || localStorage.getItem(BRANCH_KEY) !== "0",
    title: seed ? `${seed.identifier} · ${seed.title}` : "",
    stage: board.stages[1] ?? board.stages[0],
    prompt: "",
    inject: [],
    issue: seed ? { id: seed.id, identifier: seed.identifier, title: seed.title, url: seed.url } : null,
    agent: "claude",
    model: defaultModel(),
    effort: "",
    plan: false,
    mcp: defaultMcp(),
    plugins: defaultPlugins(),
  };
  draft.effort = defaultEffort(draft.model);
  // O modelo padrão traz o provider que o catálogo associou a ele.
  draft.agent = agentOf(draft.model);
  const conformCapabilities = () => {
    const capabilities = capabilitiesOf(draft.agent);
    if (!capabilities.initialPlanMode) draft.plan = false;
    if (!capabilities.workspaceMcpSelection) draft.mcp = null;
    if (!capabilities.workspacePluginSelection) draft.plugins = null;
    if (!capabilities.attachments) draft.inject = [];
  };
  conformCapabilities();

  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.innerHTML = `
    <div class="sheettop">
      <span class="who"><span id="d-avatar"></span><button id="d-project" class="ghost pick"><span></span>${icon("chevron-down", 12)}</button><button id="d-more" class="ico sm" data-t-title="launcher.addRepo">${icon("plus", 14)}</button></span>
      <button id="d-base" class="ghost base" data-t-title="launcher.base.title">
        ${icon("git-branch", 12)}<span id="d-basename"></span>${icon("chevron-down", 12)}
      </button>
      <button id="d-issuebtn" class="ghost base empty" data-t-title="launcher.issue.title">
        ${icon("linear", 12)}<span></span>${icon("chevron-down", 12)}
      </button>
      <span class="spacer"></span>
      <button id="d-nb" class="ghost sw" role="switch">
        <span data-t="launcher.newBranch"></span><i class="knob"></i>
      </button>
      <button id="d-wt" class="ghost sw" role="switch">
        <span data-t="launcher.worktree"></span><i class="knob"></i>
      </button>
    </div>
    <div class="picker" id="d-picker" hidden></div>
    <div class="picker" id="d-ipicker" hidden></div>
    <textarea id="d-prompt" rows="6"></textarea>
    <div class="attach" id="d-repos" hidden></div>
    <div class="attach" id="d-issue" hidden></div>
    <div class="attach" id="d-inj" hidden></div>
    <div class="sheetbar">
      <button id="d-model" class="ghost pick" data-t-title="launcher.model.title">${icon("sparkles", 14)}<span></span>${icon("chevron-down", 12)}</button>
      <button id="d-effort" class="ghost effort"><span class="bars"><i></i><i></i><i></i><i></i><i></i></span><span class="el"></span></button>
      <button id="d-plan" class="ghost">${icon("map", 14)}<span data-t="launcher.plan"></span></button>
      <button id="d-mcp" class="ghost pick" data-t-title="mcp.title">${icon("plug", 14)}<span></span></button>
      <button id="d-plugins" class="ghost pick" data-t-title="plugin.title">${icon("puzzle", 14)}<span></span></button>
      <span class="hint" id="d-hint"></span>
      <button id="d-add" class="ico" data-t-title="launcher.attach">${icon("paperclip", 16)}</button>
      <button id="d-go" class="pri"><span data-t="launcher.go"></span> <kbd>↵</kbd></button>
    </div>`;
  paint(sheet);

  const $ = <T extends HTMLElement>(id: string) => sheet.querySelector(`#${id}`) as T;
  const prompt = $<HTMLTextAreaElement>("d-prompt");
  const hint = $("d-hint");

  const nameOf = (id: string) => board.projects.find((p) => p.id === id)?.name ?? "";
  const projectName = () => nameOf(draft.project);
  // O workspace que já segurava a branch, quando há um: enquanto ele existir
  // não adianta criar, e o botão fica travado — o git recusaria o segundo
  // check-out, e recusar aqui é não perder o que já foi digitado.
  let taken: Workspace | null = null;
  let receiving = 0;
  const drawHint = () => {
    $("d-avatar").innerHTML = avatar(projectName());
    const from = draft.base ? ` ← ${draft.base}` : "";
    const onde = !draft.newBranch
      ? t("launcher.hint.here")
      : t(
          draft.extras.length ? "launcher.hint.multi" : draft.worktree ? "launcher.hint.worktree" : "launcher.hint.switch",
          { branch: draft.branch, from },
        );

    const names = [draft.project, ...draft.extras].map(nameOf).join(" + ");
    // A mesma branch em duas pastas o git recusa, e o lançador é onde ainda dá
    // para escolher outra: sair duas vezes da mesma issue do Linear pede a
    // branch que ela nomeia, e a pasta muda com os repositórios escolhidos.
    taken =
      draft.newBranch && draft.worktree
        ? branchTaken(board, [draft.project, ...draft.extras], draft.branch)
        : null;
    const aviso = taken ? t("launcher.hint.taken", { ws: taken.title }) : "";
    hint.classList.toggle("bad", !!aviso);
    hint.title = aviso || `${names} · ${onde}`;
    hint.textContent = aviso || onde;
    $<HTMLButtonElement>("d-go").disabled = !!aviso || receiving > 0;
  };
  drawHint();

  /* ---------- mais de um repositório ---------- */

  // Uma funcionalidade que atravessa dois repos é um workspace só: o agente
  // abre uma pasta com um worktree de cada, na mesma branch. Os outros repos
  // ficam à vista como chips, do lado do principal — e o + só oferece o que
  // ainda não está nele.
  const more = $<HTMLButtonElement>("d-more");
  const reposBox = $("d-repos");
  const others = () => board.projects.filter((p) => p.id !== draft.project && !draft.extras.includes(p.id));
  const drawExtras = () => {
    more.hidden = board.projects.length < 2;
    more.disabled = !others().length;
    more.title = t(others().length ? "launcher.addRepo" : "launcher.addRepo.none");
    reposBox.hidden = !draft.extras.length;
    reposBox.replaceChildren(
      ...draft.extras.map((id) => {
        const chip = template("span", "injchip repo", `${icon("git-branch", 12)}<span></span><button class="ico sm">${icon("x", 12)}</button>`);
        chip.children[1].textContent = nameOf(id);
        (chip.children[2] as HTMLElement).title = t("launcher.removeRepo", { name: nameOf(id) });
        chip.children[2].addEventListener("click", () => {
          draft.extras = draft.extras.filter((x) => x !== id);
          drawExtras();
          drawSwitches();
          prompt.focus();
        });
        return chip;
      }),
    );
  };
  more.addEventListener("click", () => {
    const at = more.getBoundingClientRect();
    menu.openAt(
      { x: at.left, y: at.bottom + 4 },
      others().map((p) => ({
        label: p.name,
        run: () => {
          draft.extras.push(p.id);
          // Dois repos só cabem num worktree: é a pasta que os reúne que o
          // agente abre, e clone espalhado não tem uma.
          draft.worktree = true;
          draft.newBranch = true;
          drawExtras();
          drawSwitches();
          prompt.focus();
        },
      })),
    );
  });

  /* ---------- worktree e branch: as duas chavinhas ---------- */

  // Três combinações que importam: worktree com branch nova (o normal), branch
  // nova no próprio repo, e nenhuma das duas — abrir a sessão onde o repo já
  // está. A quarta não existe: worktree sem branch própria não é worktree.
  const wt = $<HTMLButtonElement>("d-wt");
  const nb = $<HTMLButtonElement>("d-nb");

  const drawSwitches = () => {
    for (const [el, on] of [
      [wt, draft.worktree],
      [nb, draft.newBranch],
    ] as const) {
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", String(on));
    }
    nb.disabled = draft.worktree;
    nb.title = t(draft.worktree ? "launcher.nb.locked" : "launcher.nb.off");
    wt.disabled = !!git || draft.extras.length > 0;
    wt.title = t(draft.extras.length ? "launcher.wt.locked" : draft.worktree ? "launcher.wt.on" : "launcher.wt.off");
    // Sem branch nova não há de onde sair.
    baseBtn.disabled = !draft.newBranch || !branches.length;
    if (!draft.newBranch) basePick.close();
    drawHint();
  };

  wt.addEventListener("click", () => {
    draft.worktree = !draft.worktree;
    if (draft.worktree) draft.newBranch = true;
    localStorage.setItem(WORKTREE_KEY, draft.worktree ? "1" : "0");
    localStorage.setItem(BRANCH_KEY, draft.newBranch ? "1" : "0");
    drawSwitches();
  });
  nb.addEventListener("click", () => {
    draft.newBranch = !draft.newBranch;
    localStorage.setItem(BRANCH_KEY, draft.newBranch ? "1" : "0");
    drawSwitches();
  });

  /* ---------- modelo, esforço e plan mode: o rodapé do Conductor ---------- */

  // Escolher devolve o cursor ao texto: modelo e esforço são acessórios da
  // frase, e clicar neles não pode tirar você dela.
  const drawAttach = () => {
    const supported = capabilitiesOf(draft.agent).attachments;
    $<HTMLButtonElement>("d-add").hidden = !supported;
    if (!supported) {
      $("d-inj").hidden = true;
      $("d-inj").replaceChildren();
    }
  };
  const drawModel = dropdown(
    $("d-model"),
    modelGroups,
    () => draft.model,
    (id) => {
      draft.model = id;
      draft.agent = agentOf(id);
      // Trocar de provider/modelo pode invalidar features e esforço atuais.
      conformCapabilities();
      draft.effort = fits(draft.effort);
      drawEffort();
      drawPlan();
      drawMcp();
      drawPlugins();
      drawAttach();
      prompt.focus();
    },
  );

  // Esforço sobe um degrau por clique e dá a volta: as barras dizem onde está.
  // A escada é a do modelo escolhido — o Codex publica quais níveis cada um
  // aceita, e oferecer um que o CLI recusaria é oferecer um erro.
  const effort = $<HTMLButtonElement>("d-effort");
  const drawEffort = () => {
    const stairs = ladder();
    const step = Math.max(0, stairs.findIndex(([id]) => id === draft.effort));
    const ultra = stairs[step][0] === "ultracode";
    effort.querySelector(".el")!.textContent = stairs[step][1];
    effort.querySelectorAll(".bars i").forEach((bar, n) => bar.classList.toggle("lit", n <= step));
    effort.classList.toggle("ultra", ultra);
    effort.title = t(ultra ? "launcher.effort.ultra" : "launcher.effort.title");
  };
  effort.addEventListener("click", () => {
    const stairs = ladder();
    const step = stairs.findIndex(([id]) => id === draft.effort);
    draft.effort = stairs[(step + 1) % stairs.length][0];
    drawEffort();
    prompt.focus();
  });

  /// A escada de degraus que o modelo de agora aceita.
  const ladder = () => ladderOf(draft.model, draft.agent);

  const fits = (level: string) => fitsEffort(draft.model, level, draft.agent);

  draft.effort = fits(draft.effort);
  drawEffort();
  drawModel();

  const plan = $<HTMLButtonElement>("d-plan");
  const drawPlan = () => {
    plan.hidden = !capabilitiesOf(draft.agent).initialPlanMode;
    plan.classList.toggle("on", draft.plan);
    plan.setAttribute("aria-pressed", String(draft.plan));
    plan.title = t(draft.plan ? "launcher.plan.on" : "launcher.plan.off");
  };
  plan.addEventListener("click", () => {
    draft.plan = !draft.plan;
    drawPlan();
    prompt.focus();
  });
  drawPlan();
  drawAttach();

  // As ferramentas do agente. O botão só existe se houver hub: um seletor vazio
  // é um botão que não faz nada, e o caminho para cadastrar é Configurações.
  const mcpBtn = $<HTMLButtonElement>("d-mcp");
  const drawMcp = () => {
    mcpBtn.hidden =
      !capabilitiesOf(draft.agent).workspaceMcpSelection ||
      (!mcp.list().length && draft.mcp === null);
    mcpBtn.querySelector("span")!.textContent = mcp.label(draft.mcp);
    mcpBtn.classList.toggle("on", !!draft.mcp?.length);
  };
  mcpBtn.addEventListener("click", () => {
    const at = mcpBtn.getBoundingClientRect();
    mcp.openPicker({
      chosen: () => draft.mcp,
      set: (ids) => {
        draft.mcp = ids;
        drawMcp();
      },
      at: () => ({ x: at.left, y: at.bottom + 4 }),
    });
  });
  const forgetMcp = mcp.onChange(drawMcp);
  drawMcp();

  // Os plugins, do mesmo jeito e pelo mesmo motivo. O descriptor diz se o
  // runtime sabe receber a seleção por workspace.
  const plugBtn = $<HTMLButtonElement>("d-plugins");
  const drawPlugins = () => {
    plugBtn.hidden =
      !capabilitiesOf(draft.agent).workspacePluginSelection ||
      (!plugins.list().length && draft.plugins === null);
    plugBtn.querySelector("span")!.textContent = plugins.label(draft.plugins);
    plugBtn.classList.toggle("on", !!draft.plugins?.length);
  };
  plugBtn.addEventListener("click", () => {
    const at = plugBtn.getBoundingClientRect();
    plugins.openPicker({
      chosen: () => draft.plugins,
      set: (ids) => {
        draft.plugins = ids;
        drawPlugins();
      },
      at: () => ({ x: at.left, y: at.bottom + 4 }),
    });
  });
  const forgetPlugins = plugins.onChange(drawPlugins);
  drawPlugins();

  /* ---------- base da branch ---------- */

  // O repositório manda na lista, então trocar de projeto refaz a escolha: a
  // base do anterior quase nunca existe no seguinte.
  const baseBtn = $<HTMLButtonElement>("d-base");
  const baseName = $("d-basename");
  let branches: string[] = [];

  const setBase = (name: string) => {
    draft.base = name;
    baseName.textContent = name || t("launcher.base.none");
    baseBtn.classList.toggle("empty", !name);
    drawHint();
  };

  const basePick = picker({
    btn: baseBtn,
    el: $("d-picker"),
    placeholder: t("launcher.base.pick"),
    rows: () => branches.map((name) => ({ id: name, label: name, run: () => setBase(name) })),
    none: () => t(branches.length ? "launcher.base.noMatch" : "launcher.base.empty"),
    current: () => draft.base,
    after: () => prompt.focus(),
  });

  const loadBranches = async () => {
    const loadingProject = draft.project;
    const fromGit = loadingProject === project ? git : undefined;
    branches = [];
    baseBtn.disabled = true;
    baseName.textContent = t("launcher.loading");
    try {
      const got = await invoke<Branches>("list_branches", { project: draft.project });
      if (draft.project !== loadingProject) return;
      branches = got.all;
      // O repositório é que sabe quais nomes já existem, e ele acabou de
      // chegar (ou mudou, se trocaram de projeto). Git e issue preservam o nome escolhido.
      if (!seed) draft.branch = fromGit?.branch || freshBranch(branches);
      setBase(fromGit?.base ?? got.default);
    } catch {
      if (draft.project !== loadingProject) return;
      // Repo sem ref nenhuma (recém-init): cria a branch de onde o HEAD estiver.
      setBase(fromGit?.base ?? "");
    }
    baseBtn.disabled = !draft.newBranch || !branches.length;
  };

  /* ---------- a issue: "criar de…" ---------- */

  // A issue de origem fica à vista, como os anexos: é parte da primeira
  // fala. Escolher uma dá nome e branch ao workspace; o ✕ do chip desfaz.
  const issueBox = $("d-issue");
  const issueBtn = $<HTMLButtonElement>("d-issuebtn");
  const setSeed = (issue: Issue | undefined) => {
    seed = issue;
    draft.issue = issue ? { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url } : null;
    draft.branch = (draft.project === project ? git?.branch : undefined) || issue?.branch_name || freshBranch(branches);
    draft.title = issue ? `${issue.identifier} · ${issue.title}` : "";
    prompt.placeholder = t(issue ? "launcher.prompt.issue" : "launcher.prompt");
    issueBtn.querySelector("span")!.textContent = issue?.identifier ?? t("launcher.issue");
    issueBtn.classList.toggle("empty", !issue);
    issueBox.hidden = !issue;
    issueBox.replaceChildren();
    if (issue) {
      const chip = template(
        "span",
        "injchip issue",
        `${icon("linear", 12)}<b class="iid"></b><span class="it"></span><button class="ico sm">${icon("x", 12)}</button>`,
      );
      chip.children[1].textContent = issue.identifier;
      chip.children[2].textContent = issue.title;
      chip.title = `${issue.title}\n${issue.url}`;
      chip.children[3].addEventListener("click", () => {
        setSeed(undefined);
        prompt.focus();
      });
      issueBox.append(chip);
    }
    drawHint();
  };

  // O mesmo seletor, com as issues do Linear no seu nome. Sem Linear, a
  // única linha é o caminho para conectar — o "Set up Linear" do Conductor.
  const issuePick = picker({
    btn: issueBtn,
    el: $("d-ipicker"),
    placeholder: t("launcher.issue.pick"),
    rows: () => {
      const list = issues.list();
      if (list === null) {
        return [
          {
            id: "@configurar",
            label: t("launcher.issue.setup"),
            glyph: icon("arrow-right", 14),
            run: () => {
              hide();
              opts.toSettings();
            },
          },
        ];
      }
      return list.map((i) => ({ id: i.id, label: i.title, sub: i.identifier, run: () => setSeed(i) }));
    },
    none: () =>
      issues.busy()
        ? t("launcher.issue.busy")
        : t(issues.list()?.length ? "launcher.issue.noMatch" : "launcher.issue.empty"),
    current: () => draft.issue?.id ?? "",
    after: () => prompt.focus(),
  });
  // Abrir o seletor é o momento de buscar, se a lista está velha ou nunca veio.
  issueBtn.addEventListener("click", () => {
    if (issuePick.isOpen()) void issues.load().then(() => issuePick.isOpen() && issuePick.draw());
  });

  // Trocar de projeto refaz a base (é o repositório quem manda na lista) e o
  // nome no aviso.
  dropdown(
    $("d-project"),
    () => [{ items: board.projects.map((p) => [p.id, p.name] as [string, string]) }],
    () => draft.project,
    (id) => {
      draft.project = id;
      // O principal não pode estar também entre os outros.
      draft.extras = draft.extras.filter((x) => x !== id);
      basePick.close();
      loadBranches();
      drawExtras();
      drawHint();
      prompt.focus();
    },
  );
  drawExtras();
  drawSwitches();
  loadBranches();
  setSeed(seed);

  sheet.addEventListener("mousedown", (e) => {
    for (const p of [basePick, issuePick]) {
      if (p.isOpen() && !p.contains(e.target as Node)) p.close();
    }
  });

  // Anexos ficam à vista, entre o texto e o rodapé — não atrás de "Detalhes":
  // o que vai junto da primeira fala é parte da primeira fala.
  const injList = $("d-inj");
  const drawInject = () => {
    injList.hidden = !draft.inject.length;
    injList.replaceChildren(
      ...draft.inject.map((path, i) => {
        const row = document.createElement("span");
        row.className = "injchip";
        row.innerHTML = `<span></span><button class="ico sm">${icon("x", 12)}</button>`;
        row.children[0].textContent = path.split("/").pop() ?? path;
        row.children[0].setAttribute("title", path);
        row.children[1].addEventListener("click", () => {
          draft.inject.splice(i, 1);
          drawInject();
        });
        return row;
      }),
    );
  };
  const addFiles = (paths: string[]) => {
    if (!capabilitiesOf(draft.agent).attachments) return;
    for (const path of paths) if (path && !draft.inject.includes(path)) draft.inject.push(path);
    drawInject();
  };
  $("d-add").addEventListener("click", async () => {
    const picked = await open({ multiple: true, title: t("launcher.attach.dialog") });
    addFiles(Array.isArray(picked) ? picked : picked ? [picked] : []);
  });
  takeFiles = {
    put: addFiles,
    wait: () => {
      receiving++;
      drawHint();
      return () => { receiving--; drawHint(); };
    },
  };

  const hide = () => {
    forgetMcp();
    forgetPlugins();
    takeFiles = null;
    veil.replaceChildren();
    veil.hidden = true;
  };
  const submit = () => {
    if (taken || receiving) return;
    // Vazia é o que o back lê como "não cria branch, abre onde o repo está".
    if (!draft.newBranch) draft.branch = "";
    draft.prompt = seed ? issueBlock(seed, prompt.value) : prompt.value;
    // O nome sai da issue, senão da primeira frase — e por último da branch.
    draft.title = draft.title || summarize(prompt.value) || draft.branch || projectName();
    hide();
    go(draft);
  };

  $("d-go").addEventListener("click", submit);
  // Enter cria; Shift+Enter quebra linha. O texto é o campo principal.
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  // Clicar fora fecha, como no Conductor — não tem botão de cancelar. Decide no
  // mousedown: soltar uma seleção de texto em cima do véu não pode fechar.
  // Com chaves de propósito: handler `on*` que retorna `false` é
  // `preventDefault()`, e aí clique nenhum dentro da folha focaria nada.
  veil.onmousedown = (e) => {
    if (e.target === veil) hide();
  };

  veil.replaceChildren(sheet);
  veil.hidden = false;
  prompt.focus();
}

type Row = { id: string; label: string; sub?: string; glyph?: string; run: () => void };

/// Uma lista com busca pendurada num botão: setas, Enter, Esc, e clicar fora
/// fecha. Serve à base da branch e à issue — o mesmo comportamento, duas
/// listas. A linha marcada com ✓ é a escolha atual; `sub` é o identificador
/// em mono, quando há.
function picker(o: {
  btn: HTMLButtonElement;
  el: HTMLElement;
  placeholder: string;
  rows: () => Row[];
  none: () => string;
  current: () => string;
  /// Depois de escolher ou desistir: devolve o cursor ao texto.
  after: () => void;
}) {
  const { btn, el } = o;
  el.innerHTML = `<label class="pfind">${icon("search", 14)}<input spellcheck="false" /></label><div class="plist"></div>`;
  const find = el.querySelector("input")!;
  find.placeholder = o.placeholder;
  const list = el.querySelector<HTMLElement>(".plist")!;
  let marked = 0;

  const close = () => {
    el.hidden = true;
    btn.classList.remove("open");
  };
  const choose = (row: Row) => {
    row.run();
    close();
    o.after();
  };
  const draw = () => {
    const q = find.value.trim().toLowerCase();
    const hits = o.rows().filter((r) => `${r.sub ?? ""} ${r.label}`.toLowerCase().includes(q));
    marked = Math.min(marked, Math.max(hits.length - 1, 0));
    list.replaceChildren(
      ...hits.slice(0, 300).map((row, i) => {
        const b = document.createElement("button");
        b.className = "prow" + (i === marked ? " on" : "");
        b.innerHTML =
          `<span class="pc">${row.id === o.current() ? icon("check", 14) : (row.glyph ?? "")}</span>` +
          (row.sub === undefined ? "" : `<span class="iid"></span>`) +
          `<span></span>`;
        if (row.sub !== undefined) b.children[1].textContent = row.sub;
        b.lastElementChild!.textContent = row.label;
        b.addEventListener("mousemove", () => {
          if (marked === i) return;
          marked = i;
          [...list.children].forEach((c, ci) => c.classList.toggle("on", ci === i));
        });
        b.addEventListener("click", () => choose(row));
        return b;
      }),
    );
    if (!hits.length) {
      const none = document.createElement("div");
      none.className = "none";
      none.textContent = o.none();
      list.append(none);
    }
    list.querySelector(".prow.on")?.scrollIntoView({ block: "nearest" });
  };
  const open = () => {
    marked = Math.max(o.rows().findIndex((r) => r.id === o.current()), 0);
    find.value = "";
    // Ancorada no botão, mas sempre contida na folha. O botão de issue fica
    // perto da direita, e uma lista cheia também não pode atravessar o rodapé.
    el.hidden = false;
    const sheet = el.offsetParent as HTMLElement;
    const edge = 12;
    const width = Math.min(420, sheet.clientWidth - edge * 2);
    el.style.left = `${Math.max(edge, Math.min(btn.offsetLeft, sheet.clientWidth - width - edge))}px`;
    el.style.width = `${width}px`;
    const foot = sheet.querySelector<HTMLElement>(".sheetbar")!;
    el.style.maxHeight = `${Math.min(320, foot.offsetTop - el.offsetTop)}px`;
    btn.classList.add("open");
    draw();
    find.focus();
  };

  btn.addEventListener("click", () => (el.hidden ? open() : close()));
  find.addEventListener("input", () => {
    marked = 0;
    draw();
  });
  find.addEventListener("keydown", (e) => {
    const rows = [...list.querySelectorAll<HTMLElement>(".prow")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      marked = Math.min(Math.max(marked + (e.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1);
      rows.forEach((r, i) => r.classList.toggle("on", i === marked));
      rows[marked]?.scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") {
      e.preventDefault();
      rows[marked]?.click();
    }
    // Esc fecha só a lista; o lançador inteiro só some no segundo Esc.
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      o.after();
    }
  });

  return { open, close, draw, isOpen: () => !el.hidden, contains: (n: Node) => el.contains(n) || btn.contains(n) };
}

/* ---------- os padrões, que Configurações escolhe ---------- */

/// Os MCP padrão, filtrados pelo que o hub ainda tem: servidor removido do
/// cadastro não pode voltar como escolha morta. Sem nada escolhido é `null`,
/// que é não escolher — e aí o CLI decide, como decidia antes do hub existir.
export function defaultMcp(): string[] | null {
  return storedList(MCP_KEY, mcp.known);
}

export function setDefaultMcp(ids: string[] | null) {
  store(MCP_KEY, ids);
}

/// Os plugins padrão, pela mesma regra do MCP e pelo mesmo motivo.
export function defaultPlugins(): string[] | null {
  return storedList(PLUGIN_KEY, plugins.known);
}

export function setDefaultPlugins(ids: string[] | null) {
  store(PLUGIN_KEY, ids);
}

function storedList(key: string, known: (id: string) => boolean): string[] | null {
  const saved = localStorage.getItem(key);
  if (saved === null) return null;
  try {
    const ids = JSON.parse(saved) as string[];
    return Array.isArray(ids) ? ids.filter(known) : null;
  } catch {
    return null;
  }
}

/// `null` apaga a escolha: volta a ser o CLI quem decide.
function store(key: string, ids: string[] | null) {
  if (ids === null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(ids));
}

/// O modelo padrão, seja de qual agente for. Fora das duas listas ele não vale:
/// um alias que saiu de circulação, ou um GPT escolhido numa máquina onde o
/// Codex não está mais, não pode virar modelo inválido por lembrança — e aí
/// vale o primeiro da lista.
export function defaultModel(): string {
  const saved = localStorage.getItem(MODEL_KEY) ?? "";
  const provider = providerOfModel(saved);
  const known = descriptors().some(
    (candidate) => candidate.id === provider && candidate.installed && isKnownModel(candidate.id, saved),
  );
  return known ? saved : fallbackModel();
}

export function setDefaultModel(id: string) {
  localStorage.setItem(MODEL_KEY, id);
}

/// O esforço padrão, no degrau mais próximo que a escada deste modelo tem: o
/// padrão é um só, e o modelo com que se abre pode não chegar até ele.
export function defaultEffort(model: string): string {
  const saved = localStorage.getItem(EFFORT_KEY) ?? "";
  return fitsEffort(model, EFFORTS.some(([id]) => id === saved) ? saved : "high");
}

export function setDefaultEffort(id: string) {
  localStorage.setItem(EFFORT_KEY, id);
}

/// A escada de degraus deste modelo, para quem desenha um seletor de esforço
/// fora do lançador — a página de Padrões.
export const effortLadder = ladderOf;

/// A primeira fala de um workspace que nasce de uma issue: a issue inteira,
/// e depois o que você digitou. O agente lê a descrição como o pedido, e a
/// sua frase como o jeito de fazer.
export function issueBlock(issue: Issue, extra: string): string {
  const head = [t("launcher.issueBlock", { id: issue.identifier, title: issue.title }), issue.url];
  const body = issue.description?.trim();
  const parts = [head.join("\n"), body, extra.trim() ? `---\n\n${extra.trim()}` : ""];
  return parts.filter(Boolean).join("\n\n");
}

function summarize(prompt: string) {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 46 ? line.slice(0, 45) + "…" : line;
}
