import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { avatar, icon, stageIcon } from "./icons";
import * as menu from "./menu";
import type { Board } from "./types";

export type Draft = {
  project: string;
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
  /// `--model`: um alias do Claude Code (`opus`, `sonnet[1m]`…). Vazio é
  /// deixar ele escolher. Vale para o workspace inteiro.
  model: string;
  /// `--effort`, `low`…`max` ou `ultracode`. O lançador sempre escolhe um;
  /// vazio (quadro antigo) é não passar. Também do workspace.
  effort: string;
  /// Nasce em plan mode: o agente lê e planeja, e o card "plano pronto" é o
  /// que o solta. Só desta primeira conversa.
  plan: boolean;
};

type Branches = { all: string[]; default: string };

/// Sempre solto (`--dangerously-skip-permissions`): não há chavinha. Agente
/// que para a cada `Write` não trabalha enquanto você olha outra coisa, e é
/// isso que faz o quadro valer a pena. Sem worktree o lançador avisa, porque
/// aí ele mexe sem pedir no clone em que você trabalha.

/// Os aliases que o `--model` aceita, com o nome que aparece na tela. Alias e
/// não id completo de propósito: "opus" é sempre o Opus mais novo, e a lista
/// não envelhece a cada release. `[1m]` é a janela de um milhão.
const MODELS: [string, string][] = [
  ["", "Modelo padrão"],
  ["fable", "Fable"],
  ["fable[1m]", "Fable · 1M"],
  ["opus", "Opus"],
  ["opus[1m]", "Opus · 1M"],
  ["sonnet", "Sonnet"],
  ["sonnet[1m]", "Sonnet · 1M"],
  ["haiku", "Haiku"],
];

/// A escada do esforço, na ordem em que o clique sobe. É o botão do Conductor:
/// barras que acendem uma a uma, e depois da última volta ao Baixo — sem
/// lista, porque são seis degraus e subir um é um clique só. Não há "padrão":
/// o lançador sempre diz um, e o primeiro é Alto, que é o que o CLI faria
/// sozinho. `ultracode` o CLI traduz em `xhigh` mais a orquestração de
/// workflows (subagentes em paralelo); só existe para conta com workflows
/// liberados.
const EFFORTS: [string, string][] = [
  ["low", "Baixo"],
  ["medium", "Médio"],
  ["high", "Alto"],
  ["xhigh", "Muito alto"],
  ["max", "Máximo"],
  ["ultracode", "Ultracode"],
];

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
/// Conductor. Tudo que dá para deduzir fica atrás de "detalhes"; criar é Enter.
export function openLauncher(board: Board, preset: string | undefined, go: (d: Draft) => void) {
  const veil = document.getElementById("veil")!;
  if (!board.projects.length) return;

  const draft: Draft = {
    project: preset ?? board.projects[0].id,
    branch: `prometheus/${stamp()}`,
    base: "",
    worktree: localStorage.getItem(WORKTREE_KEY) !== "0",
    newBranch: localStorage.getItem(BRANCH_KEY) !== "0",
    title: "",
    stage: board.stages[1] ?? board.stages[0],
    prompt: "",
    inject: [],
    model: remembered(MODEL_KEY, MODELS),
    effort: remembered(EFFORT_KEY, EFFORTS, "high"),
    plan: false,
  };

  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.innerHTML = `
    <div class="sheettop">
      <span class="who"><span id="d-avatar"></span><button id="d-project" class="ghost pick"><span></span>${icon("chevron-down", 12)}</button></span>
      <button id="d-base" class="ghost base" title="De onde a branch nova sai">
        ${icon("git-branch", 12)}<span id="d-basename">carregando…</span>${icon("chevron-down", 12)}
      </button>
      <button id="d-more" class="ghost">Detalhes ${icon("chevron-down", 12)}</button>
      <span class="spacer"></span>
      <button id="d-nb" class="ghost sw" role="switch">
        <span>Branch nova</span><i class="knob"></i>
      </button>
      <button id="d-wt" class="ghost sw" role="switch">
        <span>Worktree</span><i class="knob"></i>
      </button>
    </div>
    <div class="picker" id="d-picker" hidden>
      <label class="pfind">${icon("search", 14)}<input id="d-find" placeholder="Escolher a base…" spellcheck="false" /></label>
      <div class="plist" id="d-list"></div>
    </div>
    <textarea id="d-prompt" rows="6" placeholder="No que você quer trabalhar?"></textarea>
    <div class="attach" id="d-inj" hidden></div>
    <div class="details" id="d-details" hidden>
      <label class="mini-row"><span>Nome</span><input id="d-title" placeholder="sai da primeira frase" /></label>
      <label class="mini-row"><span>Branch</span><input id="d-branch" spellcheck="false" /></label>
      <label class="mini-row"><span>Etapa</span><span class="chips" id="d-cols"></span></label>
    </div>
    <div class="sheetbar">
      <button id="d-model" class="ghost pick" title="Modelo das conversas deste workspace">${icon("sparkles", 14)}<span></span>${icon("chevron-down", 12)}</button>
      <button id="d-effort" class="ghost effort"><span class="bars"><i></i><i></i><i></i><i></i><i></i></span><span class="el"></span></button>
      <button id="d-plan" class="ghost">${icon("map", 14)}Plan</button>
      <span class="hint" id="d-hint"></span>
      <button id="d-add" class="ico" title="Anexar arquivos ao contexto — ou solte em cima">${icon("paperclip", 16)}</button>
      <button id="d-go" class="pri">Criar <kbd>↵</kbd></button>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => sheet.querySelector(`#${id}`) as T;
  const branch = $<HTMLInputElement>("d-branch");
  const prompt = $<HTMLTextAreaElement>("d-prompt");
  const hint = $("d-hint");
  branch.value = draft.branch;

  const projectName = () => board.projects.find((p) => p.id === draft.project)?.name ?? "";
  const drawHint = () => {
    $("d-avatar").innerHTML = avatar(projectName());
    const from = draft.base ? ` ← ${draft.base}` : "";
    const onde = !draft.newBranch
      ? `na branch em que o repo está`
      : draft.worktree
        ? `worktree novo · ${branch.value}${from}`
        : `o repo troca para ${branch.value}${from}`;

    // O agente roda sempre solto, e isso é aceitável porque o worktree é
    // descartável. Sem worktree ele roda sem pedir nada no clone em que você
    // trabalha — dá para querer isso, mas não dá para não saber.
    //
    // O aviso vem na frente porque a linha é cortada no fim: se ele fosse o
    // rabo da frase, seria justamente ele a virar reticências.
    hint.classList.toggle("warn", !draft.worktree);
    hint.title = `${projectName()} · ${onde}`;
    hint.textContent = draft.worktree ? onde : `solto no seu clone, sem pedir · ${onde}`;
  };
  drawHint();
  branch.addEventListener("input", drawHint);

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
    nb.title = draft.worktree
      ? "Worktree sempre nasce com uma branch só dele"
      : "Desligado, a sessão abre na branch em que o repositório já está";
    wt.title = draft.worktree
      ? "A branch ganha um worktree só dela, isolado do seu clone"
      : "A branch nasce no próprio repositório: o seu clone troca de branch";
    // Sem branch nova não há de onde sair, nem nome para dar.
    baseBtn.disabled = !draft.newBranch || !branches.length;
    branch.disabled = !draft.newBranch;
    if (!draft.newBranch) closePicker();
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
  dropdown($("d-model"), MODELS, () => draft.model, (id) => {
    draft.model = id;
    localStorage.setItem(MODEL_KEY, id);
    prompt.focus();
  });
  // Esforço sobe um degrau por clique e dá a volta: as barras dizem onde está.
  const effort = $<HTMLButtonElement>("d-effort");
  const drawEffort = () => {
    const step = Math.max(0, EFFORTS.findIndex(([id]) => id === draft.effort));
    const ultra = draft.effort === "ultracode";
    effort.querySelector(".el")!.textContent = EFFORTS[step][1];
    effort.querySelectorAll(".bars i").forEach((bar, n) => bar.classList.toggle("lit", n <= step));
    effort.classList.toggle("ultra", ultra);
    effort.title = ultra
      ? "Ultracode: esforço muito alto e orquestração de workflows — o agente abre subagentes em paralelo. Clique para voltar ao Baixo"
      : "Quanto o modelo pensa antes de responder. Cada clique sobe um degrau; depois do último volta ao Baixo";
  };
  effort.addEventListener("click", () => {
    const step = EFFORTS.findIndex(([id]) => id === draft.effort);
    draft.effort = EFFORTS[(step + 1) % EFFORTS.length][0];
    localStorage.setItem(EFFORT_KEY, draft.effort);
    drawEffort();
    prompt.focus();
  });
  drawEffort();

  const plan = $<HTMLButtonElement>("d-plan");
  const drawPlan = () => {
    plan.classList.toggle("on", draft.plan);
    plan.setAttribute("aria-pressed", String(draft.plan));
    plan.title = draft.plan
      ? "Nasce em plan mode: o agente só lê e planeja. Aprovar o plano no card é o que o solta"
      : "Nasce solto, mexendo desde a primeira fala. Ligue para ele planejar antes";
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
  const picker = $("d-picker");
  const find = $<HTMLInputElement>("d-find");
  let branches: string[] = [];
  let marked = 0;

  const setBase = (name: string) => {
    draft.base = name;
    baseName.textContent = name || "base indefinida";
    baseBtn.classList.toggle("empty", !name);
    drawHint();
  };

  const loadBranches = async () => {
    branches = [];
    baseBtn.disabled = true;
    baseName.textContent = "carregando…";
    try {
      const got = await invoke<Branches>("list_branches", { project: draft.project });
      branches = got.all;
      setBase(got.default);
    } catch {
      // Repo sem ref nenhuma (recém-init): cria a branch de onde o HEAD estiver.
      setBase("");
    }
    baseBtn.disabled = !draft.newBranch || !branches.length;
  };

  const drawList = () => {
    const q = find.value.trim().toLowerCase();
    const hits = branches.filter((b) => b.toLowerCase().includes(q));
    marked = Math.min(marked, Math.max(hits.length - 1, 0));
    const list = $("d-list");
    list.replaceChildren(
      ...hits.slice(0, 300).map((name, i) => {
        const row = document.createElement("button");
        row.className = "prow" + (i === marked ? " on" : "");
        row.innerHTML = `<span class="pc">${name === draft.base ? icon("check", 14) : ""}</span><span></span>`;
        row.children[1].textContent = name;
        row.addEventListener("mousemove", () => {
          if (marked === i) return;
          marked = i;
          [...list.children].forEach((c, ci) => c.classList.toggle("on", ci === i));
        });
        row.addEventListener("click", () => {
          setBase(name);
          closePicker();
        });
        return row;
      }),
    );
    if (!hits.length) {
      const none = document.createElement("div");
      none.className = "none";
      none.textContent = branches.length ? "nenhuma branch com esse nome" : "nenhuma branch neste repo";
      list.append(none);
    }
    list.querySelector(".prow.on")?.scrollIntoView({ block: "nearest" });
  };

  const closePicker = () => {
    picker.hidden = true;
    baseBtn.classList.remove("open");
  };
  const openPicker = () => {
    if (!branches.length) return;
    marked = Math.max(branches.indexOf(draft.base), 0);
    find.value = "";
    // Ancorada no botão, não na folha: a lista cai de onde ela foi aberta.
    picker.style.left = `${baseBtn.offsetLeft}px`;
    picker.hidden = false;
    baseBtn.classList.add("open");
    drawList();
    find.focus();
  };

  baseBtn.addEventListener("click", () => (picker.hidden ? openPicker() : closePicker()));
  find.addEventListener("input", () => {
    marked = 0;
    drawList();
  });
  find.addEventListener("keydown", (e) => {
    const rows = [...$("d-list").querySelectorAll<HTMLElement>(".prow")];
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
      closePicker();
      prompt.focus();
    }
  });
  // Trocar de projeto refaz a base (é o repositório quem manda na lista) e o
  // nome no aviso.
  dropdown(
    $("d-project"),
    board.projects.map((p) => [p.id, p.name]),
    () => draft.project,
    (id) => {
      draft.project = id;
      closePicker();
      loadBranches();
      drawHint();
      prompt.focus();
    },
  );
  drawSwitches();
  loadBranches();

  sheet.addEventListener("mousedown", (e) => {
    if (!picker.hidden && !picker.contains(e.target as Node) && !baseBtn.contains(e.target as Node)) {
      closePicker();
    }
  });

  $("d-more").addEventListener("click", () => {
    const box = $("d-details");
    box.hidden = !box.hidden;
    $("d-more").innerHTML = `Detalhes ${icon(box.hidden ? "chevron-down" : "chevron-up", 12)}`;
  });

  const cols = $("d-cols");
  for (const [i, name] of board.stages.entries()) {
    const b = document.createElement("button");
    b.className = "ghost" + (name === draft.stage ? " on" : "");
    b.innerHTML = `${stageIcon(i, board.stages.length, 14)}<span></span>`;
    b.children[1].textContent = name;
    b.addEventListener("click", () => {
      draft.stage = name;
      [...cols.children].forEach((c) => c.classList.toggle("on", c === b));
    });
    cols.append(b);
  }

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
    const picked = await open({ multiple: true, title: "Arquivos para anexar ao contexto" });
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
    draft.branch = draft.newBranch ? branch.value.trim() || `prometheus/${stamp()}` : "";
    draft.prompt = prompt.value;
    draft.title =
      $<HTMLInputElement>("d-title").value.trim() || summarize(prompt.value) || draft.branch || projectName();
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

/// Um seletor com cara de botão, como o do Conductor — e sem `<select>`. O
/// popup nativo do WKWebView não abre nesta janela (o clique chega no elemento,
/// o menu não vem), e mesmo quando abre é a lista clara do sistema no meio de
/// um app escuro. A lista é o menu do próprio app, o mesmo do botão direito no
/// card, aberto logo abaixo do botão. O botão mostra o rótulo da escolha.
function dropdown(btn: HTMLButtonElement, list: [string, string][], get: () => string, set: (id: string) => void) {
  const label = btn.querySelector("span")!;
  const draw = () => {
    label.textContent = list.find(([id]) => id === get())?.[1] ?? "";
  };
  btn.addEventListener("click", () => {
    const at = btn.getBoundingClientRect();
    menu.openAt(
      { x: at.left, y: at.bottom + 4 },
      list.map(([id, name]) => ({
        label: name,
        checked: id === get(),
        run: () => {
          set(id);
          draw();
        },
      })),
    );
  });
  draw();
}

/// O que ficou gravado da última vez — desde que ainda exista na lista. Um
/// alias que saiu de circulação não pode virar `--model` inválido por
/// lembrança.
function remembered(key: string, list: [string, string][], fallback = "") {
  const saved = localStorage.getItem(key) ?? "";
  return list.some(([id]) => id === saved) ? saved : fallback;
}

function summarize(prompt: string) {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 46 ? line.slice(0, 45) + "…" : line;
}

/// Uma branch por workspace. O horário basta para não colidir e já diz quando foi.
function stamp() {
  const d = new Date();
  return `${d.getHours()}`.padStart(2, "0") + `${d.getMinutes()}`.padStart(2, "0");
}
