import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { avatar, icon, stageIcon } from "./icons";
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
  /// Ligado, o agente roda solto: nenhuma ferramenta para para pedir. É o que
  /// faz o quadro valer a pena — mas só é aceitável porque o worktree é
  /// isolado. Desligado, cada permissão vira o card com Permitir e Negar.
  skipPermissions: boolean;
};

type Branches = { all: string[]; default: string };

/// A escolha do worktree gruda entre lançamentos: quem trabalha de um jeito
/// trabalha do mesmo jeito amanhã, e refazer o clique toda vez cansa.
const WORKTREE_KEY = "prometheus:worktree";
const BRANCH_KEY = "prometheus:branch-nova";
const SOLTO_KEY = "prometheus:solto";

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
    skipPermissions: localStorage.getItem(SOLTO_KEY) !== "0",
  };

  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.innerHTML = `
    <div class="sheettop">
      <span class="who"><span id="d-avatar"></span><select id="d-project" class="pick"></select></span>
      <button id="d-base" class="ghost base" title="De onde a branch nova sai">
        ${icon("git-branch", 12)}<span id="d-basename">carregando…</span>${icon("chevron-down", 12)}
      </button>
      <button id="d-more" class="ghost">Detalhes ${icon("chevron-down", 12)}</button>
      <span class="spacer"></span>
      <button id="d-solto" class="ghost sw" role="switch">
        <span>Solto</span><i class="knob"></i>
      </button>
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
    <div class="details" id="d-details" hidden>
      <label class="mini-row"><span>Nome</span><input id="d-title" placeholder="sai da primeira frase" /></label>
      <label class="mini-row"><span>Branch</span><input id="d-branch" spellcheck="false" /></label>
      <label class="mini-row"><span>Etapa</span><span class="chips" id="d-cols"></span></label>
      <label class="mini-row"><span>Injetar</span><span class="inj"><span id="d-inj"></span>
        <button id="d-add" class="outline">${icon("plus", 12)} arquivo</button></span></label>
    </div>
    <div class="sheetbar">
      <span class="hint" id="d-hint"></span>
      <span class="spacer"></span>
      <button id="d-go" class="pri">Criar <kbd>↵</kbd></button>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => sheet.querySelector(`#${id}`) as T;
  const projectSel = $<HTMLSelectElement>("d-project");
  const branch = $<HTMLInputElement>("d-branch");
  const prompt = $<HTMLTextAreaElement>("d-prompt");
  const hint = $("d-hint");

  for (const p of board.projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    projectSel.append(opt);
  }
  projectSel.value = draft.project;
  branch.value = draft.branch;

  const projectName = () => board.projects.find((p) => p.id === projectSel.value)?.name ?? "";
  const drawHint = () => {
    $("d-avatar").innerHTML = avatar(projectName());
    const from = draft.base ? ` · sai de ${draft.base}` : "";
    const onde = !draft.newBranch
      ? `no próprio repo ${projectName()} · na branch em que ele já está`
      : draft.worktree
        ? `worktree novo em ${projectName()} · ${branch.value}${from}`
        : `no próprio repo ${projectName()} — ele troca de branch · ${branch.value}${from}`;

    // Solto é aceitável porque o worktree é descartável. Sem worktree o agente
    // roda sem pedir nada no clone em que você trabalha — dá para querer isso,
    // mas não dá para não saber.
    //
    // O aviso vem na frente porque a linha é cortada no fim: se ele fosse o
    // rabo da frase, seria justamente ele a virar reticências.
    const risky = draft.skipPermissions && !draft.worktree;
    hint.classList.toggle("warn", risky);
    hint.textContent = risky ? `solto no seu clone, sem pedir permissão · ${onde}` : onde;
  };
  drawHint();
  projectSel.addEventListener("change", drawHint);
  branch.addEventListener("input", drawHint);

  /* ---------- worktree e branch: as duas chavinhas ---------- */

  // Três combinações que importam: worktree com branch nova (o normal), branch
  // nova no próprio repo, e nenhuma das duas — abrir a sessão onde o repo já
  // está. A quarta não existe: worktree sem branch própria não é worktree.
  const wt = $<HTMLButtonElement>("d-wt");
  const nb = $<HTMLButtonElement>("d-nb");
  const solto = $<HTMLButtonElement>("d-solto");

  const drawSwitches = () => {
    for (const [el, on] of [
      [wt, draft.worktree],
      [nb, draft.newBranch],
      [solto, draft.skipPermissions],
    ] as const) {
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", String(on));
    }
    solto.title = draft.skipPermissions
      ? "O agente não para para pedir permissão. Vale porque o worktree é isolado — repare no aviso quando ele não for"
      : "Cada permissão vira um card com Permitir e Negar, aqui na tela";
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
  solto.addEventListener("click", () => {
    draft.skipPermissions = !draft.skipPermissions;
    localStorage.setItem(SOLTO_KEY, draft.skipPermissions ? "1" : "0");
    drawSwitches();
  });

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
      const got = await invoke<Branches>("list_branches", { project: projectSel.value });
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
  projectSel.addEventListener("change", () => {
    closePicker();
    loadBranches();
  });
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

  const injList = $("d-inj");
  const drawInject = () => {
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
  $("d-add").addEventListener("click", async () => {
    const picked = await open({ multiple: true, title: "Arquivos para injetar no contexto" });
    draft.inject.push(...(Array.isArray(picked) ? picked : picked ? [picked] : []));
    drawInject();
  });

  const hide = () => {
    veil.replaceChildren();
    veil.hidden = true;
  };
  const submit = () => {
    draft.project = projectSel.value;
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
  veil.onmousedown = (e) => e.target === veil && hide();

  veil.replaceChildren(sheet);
  veil.hidden = false;
  prompt.focus();
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
