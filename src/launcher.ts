import { open } from "@tauri-apps/plugin-dialog";
import type { Board } from "./types";

export type Draft = {
  project: string;
  branch: string;
  title: string;
  column: string;
  prompt: string;
  inject: string[];
};

/// O lançador é uma caixa de texto e um seletor de projeto. Tudo que dá para
/// deduzir fica escondido atrás de "detalhes" — criar tem que ser Enter.
export function openLauncher(board: Board, preset: string | undefined, go: (d: Draft) => void) {
  const veil = document.getElementById("veil")!;
  if (!board.projects.length) return;

  const draft: Draft = {
    project: preset ?? board.projects[0].id,
    branch: `prometheus/${stamp()}`,
    title: "",
    column: board.columns[1] ?? board.columns[0],
    prompt: "",
    inject: [],
  };

  const sheet = document.createElement("div");
  sheet.className = "sheet compact";
  sheet.innerHTML = `
    <div class="sheettop">
      <select id="d-project"></select>
      <span class="spacer"></span>
      <button id="d-more" class="ghostbtn">detalhes ▾</button>
    </div>
    <textarea id="d-prompt" rows="5" placeholder="No que você quer trabalhar?"></textarea>
    <div class="details" id="d-details" hidden>
      <label class="mini-row"><span>Nome</span><input id="d-title" placeholder="sai da primeira frase" /></label>
      <label class="mini-row"><span>Branch</span><input id="d-branch" spellcheck="false" /></label>
      <label class="mini-row"><span>Coluna</span><span class="chips" id="d-cols"></span></label>
      <label class="mini-row"><span>Injetar</span><span class="inj"><span id="d-inj"></span>
        <button id="d-add" class="ghostbtn">+ arquivo</button></span></label>
    </div>
    <div class="sheetbar">
      <span class="hint" id="d-hint"></span>
      <span class="spacer"></span>
      <button id="d-cancel" class="ghostbtn">Cancelar</button>
      <button id="d-go" class="pri">Criar ⏎</button>
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

  const drawHint = () => {
    const name = board.projects.find((p) => p.id === projectSel.value)?.name ?? "";
    hint.textContent = `worktree novo em ${name} · ${branch.value}`;
  };
  drawHint();
  projectSel.addEventListener("change", drawHint);
  branch.addEventListener("input", drawHint);

  $("d-more").addEventListener("click", () => {
    const box = $("d-details");
    box.hidden = !box.hidden;
    $("d-more").textContent = box.hidden ? "detalhes ▾" : "detalhes ▴";
  });

  const cols = $("d-cols");
  for (const name of board.columns) {
    const b = document.createElement("button");
    b.className = "ghostbtn" + (name === draft.column ? " on" : "");
    b.textContent = name;
    b.addEventListener("click", () => {
      draft.column = name;
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
        row.innerHTML = `<span></span><button>×</button>`;
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
    draft.branch = branch.value.trim() || `prometheus/${stamp()}`;
    draft.prompt = prompt.value;
    draft.title = $<HTMLInputElement>("d-title").value.trim() || summarize(prompt.value) || draft.branch;
    hide();
    go(draft);
  };

  $("d-cancel").addEventListener("click", hide);
  $("d-go").addEventListener("click", submit);
  // Enter cria; Shift+Enter quebra linha. O texto é o campo principal.
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

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
