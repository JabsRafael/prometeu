import { open } from "@tauri-apps/plugin-dialog";
import { freshBranch } from "./branch";
import { avatar, icon } from "./icons";
import { paint, t } from "./i18n";
import * as issues from "./issues";
import * as menu from "./menu";
import { invoke } from "./ipc";
import { template } from "./util";
import type { Board, Issue, IssueRef } from "./types";

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
  /// Qual CLI roda nas abas: vazio é o Claude Code, `codex` é o Codex. Não é
  /// escolha à parte — sai do modelo, porque escolher um GPT é escolher o Codex.
  agent: string;
  /// O modelo: um alias do Claude Code (`opus`, `sonnet[1m]`…) ou um slug do
  /// Codex (`gpt-5.6-sol`). Vazio é deixar o CLI escolher. Vale para o
  /// workspace inteiro.
  model: string;
  /// `--effort`, `low`…`max` ou `ultracode`. O lançador sempre escolhe um;
  /// vazio (workspace antigo) é não passar. Também do workspace.
  effort: string;
  /// Nasce em plan mode: o agente lê e planeja, e o card "plano pronto" é o
  /// que o solta. Só desta primeira conversa.
  plan: boolean;
};

type Branches = { all: string[]; default: string };

/// Sempre solto (`--dangerously-skip-permissions`): não há chavinha. Agente
/// que para a cada `Write` não trabalha enquanto você olha outra coisa, e é
/// isso que permite acompanhar outras sessões enquanto ele trabalha.

/// Os aliases que o `--model` aceita, com o nome que aparece na tela. Alias e
/// não id completo de propósito: "opus" é sempre o Opus mais novo, e a lista
/// não envelhece a cada release. `[1m]` é a janela de um milhão.
const MODELS: [string, string][] = [
  ["", t("model.default")],
  ["fable", "Fable"],
  ["fable[1m]", "Fable · 1M"],
  ["opus", "Opus"],
  ["opus[1m]", "Opus · 1M"],
  ["sonnet", "Sonnet"],
  ["sonnet[1m]", "Sonnet · 1M"],
  ["haiku", "Haiku"],
];

/// Os agentes desta máquina. Os modelos do Codex não estão escritos aqui de
/// propósito: o `codex` mantém o catálogo dele em `models_cache.json`, e ler
/// dali é o que faz modelo novo da OpenAI aparecer no dropdown sem release do
/// Prometheus. O que não está instalado não aparece — oferecer o Claude Code a
/// quem só tem o Codex é oferecer uma sessão que morre ao subir.
type CodexModel = { slug: string; name: string; efforts: string[] };
type Agents = { claude: boolean; codex: CodexModel[] };

/// Enquanto a resposta não chega, o de antes: só o Claude Code. É o que o app
/// era, e o lançador não pode esperar por disco para desenhar.
let agents: Agents = { claude: true, codex: [] };

/// Carregado uma vez por sessão do app: nem CLI se instala, nem catálogo muda
/// enquanto a janela está aberta.
export async function loadAgents() {
  try {
    agents = await invoke<Agents>("agents");
  } catch {
    agents = { claude: true, codex: [] };
  }
}

const isCodex = (model: string) => agents.codex.some((m) => m.slug === model);

/// O modelo com que o lançador abre quando não há nada lembrado. Vazio é o
/// padrão do Claude Code; sem `claude` na máquina, é o primeiro do Codex —
/// senão o rodapé começaria apontando para um CLI que não existe.
const fallbackModel = () => (agents.claude ? "" : (agents.codex[0]?.slug ?? ""));

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
/// CLI que vai rodar.
function ladderOf(model: string): [string, string][] {
  const codex = agents.codex.find((m) => m.slug === model);
  if (!codex) return EFFORTS;
  return EFFORTS.filter(([id]) => codex.efforts.includes(id === "ultracode" ? "ultra" : id)).map(
    ([id, name]) => [id, id === "ultracode" ? t("effort.ultra") : name],
  );
}

/// O nome do modelo na tela — o mesmo do rodapé do lançador. É o que a caixa
/// de escrever mostra embaixo: quem está lendo a conversa quer saber com quem
/// está falando, e o alias (`opus[1m]`) não é isso.
export function modelLabel(model: string): string {
  const claude = MODELS.find(([id]) => id === model);
  if (claude) return claude[1];
  return agents.codex.find((m) => m.slug === model)?.name ?? model;
}

/// O esforço como as barrinhas o desenham: em que degrau está, e de quantos.
/// Esforço que a escada deste modelo não tem não acende barra nenhuma.
export function effortStep(model: string, effort: string): { label: string; step: number; total: number } | null {
  const stairs = ladderOf(model);
  const step = stairs.findIndex(([id]) => id === effort);
  if (step === -1) return null;
  return { label: stairs[step][1], step, total: stairs.length };
}

/// A escolha do worktree gruda entre lançamentos: quem trabalha de um jeito
/// trabalha do mesmo jeito amanhã, e refazer o clique toda vez cansa. Modelo e
/// esforço também; plan mode não — é decisão de uma tarefa, não de um jeito.
const WORKTREE_KEY = "prometheus:worktree";
const BRANCH_KEY = "prometheus:branch-nova";
const MODEL_KEY = "prometheus:model";
const EFFORT_KEY = "prometheus:effort";

/// Arquivo solto em cima do lançador aberto entra como anexo. É o `main.ts`
/// quem vê o drop (o Tauri entrega caminho de verdade só pela webview), e é
/// aqui que ele cai enquanto a folha estiver na tela.
let takeFiles: ((paths: string[]) => void) | null = null;
export const dropFiles = (paths: string[]) => takeFiles?.(paths);

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
  go: (d: Draft) => void;
  /// "Configurar Linear" no seletor de issue: fecha o lançador e vai lá.
  toSettings: () => void;
};

export function openLauncher(board: Board, opts: Open) {
  const veil = document.getElementById("veil")!;
  if (!board.projects.length) return;
  const { preset, go } = opts;
  let seed = opts.seed;

  const draft: Draft = {
    project: preset ?? board.projects[0].id,
    extras: [],
    // Sem a lista de branches do repo ainda: `loadBranches` refaz o nome
    // assim que ela chega, e é ela que sabe se este já é de alguém.
    branch: seed?.branch_name || freshBranch([]),
    base: "",
    worktree: localStorage.getItem(WORKTREE_KEY) !== "0",
    newBranch: localStorage.getItem(BRANCH_KEY) !== "0",
    title: seed ? `${seed.identifier} · ${seed.title}` : "",
    stage: board.stages[1] ?? board.stages[0],
    prompt: "",
    inject: [],
    issue: seed ? { id: seed.id, identifier: seed.identifier, title: seed.title, url: seed.url } : null,
    agent: "",
    model: rememberedModel(),
    effort: remembered(EFFORT_KEY, EFFORTS, "high"),
    plan: false,
  };
  // O modelo lembrado pode ser do Codex — e aí o agente vem com ele.
  draft.agent = isCodex(draft.model) ? "codex" : "";

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
    hint.title = `${names} · ${onde}`;
    hint.textContent = onde;
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
    wt.disabled = draft.extras.length > 0;
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
  const drawModel = dropdown(
    $("d-model"),
    () => {
      const groups: Group[] = [];
      if (agents.claude) groups.push({ head: t("model.claude"), items: MODELS });
      if (agents.codex.length) {
        groups.push({
          head: t("model.codex"),
          items: agents.codex.map((m) => [m.slug, m.name] as [string, string]),
        });
      }
      return groups;
    },
    () => draft.model,
    (id) => {
      draft.model = id;
      draft.agent = isCodex(id) ? "codex" : "";
      localStorage.setItem(MODEL_KEY, id);
      // O Codex não tem plan mode por linha de comando, e cada modelo tem a
      // sua escada de esforço: trocar de modelo pode invalidar as duas coisas.
      if (draft.agent === "codex") draft.plan = false;
      draft.effort = fits(draft.effort);
      drawEffort();
      drawPlan();
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
    localStorage.setItem(EFFORT_KEY, draft.effort);
    drawEffort();
    prompt.focus();
  });

  /// A escada de degraus que o modelo de agora aceita.
  const ladder = () => ladderOf(draft.model);

  /// O degrau mais próximo que a escada de agora tem. Sair do Sol (que vai até
  /// o `ultra`) para um modelo que para no `xhigh` não pode deixar para trás um
  /// esforço que o CLI recusa.
  function fits(level: string): string {
    const stairs = ladder();
    if (stairs.some(([id]) => id === level)) return level;
    return stairs[stairs.length - 1]?.[0] ?? "high";
  }

  draft.effort = fits(draft.effort);
  drawEffort();
  drawModel();

  const plan = $<HTMLButtonElement>("d-plan");
  const drawPlan = () => {
    // O Codex não nasce em plan mode por flag: o botão sai da tela em vez de
    // ficar ali prometendo o que não acontece.
    plan.hidden = draft.agent === "codex";
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
    branches = [];
    baseBtn.disabled = true;
    baseName.textContent = t("launcher.loading");
    try {
      const got = await invoke<Branches>("list_branches", { project: draft.project });
      branches = got.all;
      // O repositório é que sabe quais nomes já existem, e ele acabou de
      // chegar (ou mudou, se trocaram de projeto). Issue manda no nome dela.
      if (!seed) draft.branch = freshBranch(branches);
      setBase(got.default);
    } catch {
      // Repo sem ref nenhuma (recém-init): cria a branch de onde o HEAD estiver.
      setBase("");
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
    draft.branch = issue?.branch_name || freshBranch(branches);
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
    draft.inject.push(...paths.filter((p) => p && !draft.inject.includes(p)));
    drawInject();
  };
  $("d-add").addEventListener("click", async () => {
    const picked = await open({ multiple: true, title: t("launcher.attach.dialog") });
    addFiles(Array.isArray(picked) ? picked : picked ? [picked] : []);
  });
  takeFiles = addFiles;

  const hide = () => {
    takeFiles = null;
    veil.replaceChildren();
    veil.hidden = true;
  };
  const submit = () => {
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
    // Ancorada no botão, não na folha: a lista cai de onde ela foi aberta.
    el.style.left = `${btn.offsetLeft}px`;
    el.hidden = false;
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

/// Um seletor com cara de botão, como o do Conductor — e sem `<select>`. O
/// popup nativo do WKWebView não abre nesta janela (o clique chega no elemento,
/// o menu não vem), e mesmo quando abre é a lista clara do sistema no meio de
/// um app escuro. A lista é o menu do próprio app, o mesmo do botão direito no
/// card, aberto logo abaixo do botão. O botão mostra o rótulo da escolha.
/// Um bloco do dropdown: os modelos do Claude Code de um lado, os do Codex do
/// outro. O `head` só aparece quando há mais de um bloco — com um agente só na
/// máquina, um título sobre a lista inteira não separa nada.
type Group = { head?: string; items: [string, string][] };

/// A lista pode mudar entre dois cliques (o catálogo do Codex chega depois do
/// primeiro desenho), então é uma função, e não um array.
function dropdown(
  btn: HTMLButtonElement,
  groups: () => Group[],
  get: () => string,
  set: (id: string) => void,
) {
  const label = btn.querySelector("span")!;
  const draw = () => {
    const all = groups().flatMap((g) => g.items);
    label.textContent = all.find(([id]) => id === get())?.[1] ?? "";
  };
  btn.addEventListener("click", () => {
    const at = btn.getBoundingClientRect();
    const blocks = groups();
    const items: menu.Item[] = [];
    blocks.forEach((block, n) => {
      if (n) items.push("sep");
      if (block.head && blocks.length > 1) items.push({ label: block.head, disabled: true });
      for (const [id, name] of block.items) {
        items.push({
          label: name,
          checked: id === get(),
          run: () => {
            set(id);
            draw();
          },
        });
      }
    });
    menu.openAt({ x: at.left, y: at.bottom + 4 }, items);
  });
  draw();
  return draw;
}

/// O modelo da última vez, seja de qual agente for. Fora das duas listas ele não
/// vale: um alias que saiu de circulação, ou um GPT lembrado numa máquina onde o
/// Codex não está mais, não pode virar modelo inválido por lembrança.
function rememberedModel(): string {
  const saved = localStorage.getItem(MODEL_KEY) ?? "";
  const known = (agents.claude && MODELS.some(([id]) => id === saved)) || isCodex(saved);
  return known ? saved : fallbackModel();
}

/// O que ficou gravado da última vez — desde que ainda exista na lista. Um
/// alias que saiu de circulação não pode virar `--model` inválido por
/// lembrança.
function remembered(key: string, list: [string, string][], fallback = "") {
  const saved = localStorage.getItem(key) ?? "";
  return list.some(([id]) => id === saved) ? saved : fallback;
}

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
