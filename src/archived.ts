import { attachMenu, type Hooks } from "./sidebar";
import { avatar, icon, stageIcon } from "./icons";
import { paint, stage as stageName, t, tn } from "./i18n";
import { hasWorktree, repoLabel, type Board, type Workspace } from "./types";
import { $, empty, h } from "./util";

/// Os arquivados, numa tela só — e não numa lista aberta na barra lateral.
/// Trabalho que você tirou da frente é o que se consulta de vez em quando:
/// reabrir para ler o que ficou escrito, desarquivar um que voltou, e devolver
/// ao disco os worktrees que ainda ocupam gigabyte. Na barra ele vira uma
/// linha com o número, e o resto mora aqui, com busca.
///
/// O mais recente fica em cima: o quadro guarda na ordem em que os workspaces
/// nasceram, e o que acabou de sair da frente é o que mais se procura.

type Ctx = {
  board: () => Board;
  hooks: () => Hooks;
};

let ctx: Ctx;
let visible = false;
let query = "";
let find: HTMLInputElement;

export function init(context: Ctx) {
  ctx = context;
  buildBar();
}

export function show() {
  visible = true;
  draw();
  find.focus();
}

export function hide() {
  visible = false;
}

/* ---------- a barra ---------- */

function buildBar() {
  const bar = $("abar");
  bar.innerHTML = `
    <label class="ifind">${icon("search", 14)}<input spellcheck="false" /></label>
    <span class="spacer"></span>
    <span class="imeta" id="ameta"></span>
    <button class="ghost md" id="aclean" data-t-title="rail.cleanup.title">${icon("trash", 14)}<span data-t="rail.cleanup"></span></button>`;
  paint(bar);
  find = bar.querySelector("input")!;
  find.placeholder = t("arch.search");
  find.addEventListener("input", () => {
    query = find.value.trim().toLowerCase();
    drawList();
  });
  find.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      find.value = "";
      query = "";
      drawList();
    }
  });
  bar.querySelector("#aclean")!.addEventListener("click", () => ctx.hooks().cleanup());
}

/* ---------- a lista ---------- */

export function draw() {
  if (!visible) return;
  drawList();
}

function drawList() {
  const list = $("alist");
  list.replaceChildren();
  const gone = ctx
    .board()
    .workspaces.filter((w) => w.archived)
    .reverse();

  // Devolver o disco só existe enquanto há o que devolver.
  const disk = gone.filter(hasWorktree).length;
  $("ameta").textContent = gone.length
    ? disk
      ? `${tn(gone.length, "arch.count")} · ${tn(disk, "arch.disk")}`
      : tn(gone.length, "arch.count")
    : "";
  ($("aclean") as HTMLButtonElement).hidden = !disk;

  if (!gone.length) {
    list.append(empty(t("arch.empty.title"), t("arch.empty.body")));
    return;
  }
  const hits = gone.filter(matches);
  if (!hits.length) {
    list.append(empty(t("arch.noMatch.title"), t("arch.noMatch.body")));
    return;
  }
  for (const ws of hits) list.append(row(ws));
}

function matches(ws: Workspace) {
  if (!query) return true;
  const hay = [ws.title, ws.branch, repoLabel(ws), stageName(ws.stage), ws.pr?.title ?? "", ws.issue?.identifier ?? ""]
    .join(" ")
    .toLowerCase();
  return query.split(/\s+/).every((word) => hay.includes(word));
}

function row(ws: Workspace): HTMLElement {
  const board = ctx.board();
  const hooks = ctx.hooks();
  const total = board.stages.length;
  const at = board.stages.indexOf(ws.stage);
  const el = h(
    "div",
    "arow" + (ws.cleaned ? " gone" : ""),
    `<span class="av"></span>` +
      `<span class="atitle"><b></b><span class="abranch"></span></span>` +
      `<span class="astage"></span>` +
      `<span class="apr"></span>` +
      `<span class="atag"></span>` +
      `<span class="iact"></span>`,
  );
  el.tabIndex = 0;
  el.querySelector(".av")!.innerHTML = avatar(ws.repo_name);
  (el.querySelector(".av") as HTMLElement).title = ws.repo_name;
  el.querySelector(".atitle b")!.textContent = ws.title;
  el.querySelector(".abranch")!.textContent = ws.branch;
  const stage = el.querySelector(".astage")!;
  stage.innerHTML = `${stageIcon(at, total, 13)}<span></span>`;
  stage.children[1].textContent = stageName(ws.stage);
  if (ws.pr) {
    const pr = el.querySelector(".apr")!;
    pr.textContent = `#${ws.pr.number}`;
    pr.classList.toggle("merged", ws.pr.state === "MERGED");
    (pr as HTMLElement).title = ws.pr.title;
  }
  // Worktree devolvido: o card ficou como histórico, e a linha diz isso em vez
  // de deixar você descobrir ao abrir.
  if (ws.cleaned) {
    el.querySelector(".atag")!.textContent = t("ws.menu.gone");
    (el.querySelector(".atag") as HTMLElement).title = t("card.cleaned.title", { path: ws.worktree });
  }

  const openIt = () => hooks.open(ws);
  el.addEventListener("click", openIt);
  el.addEventListener("keydown", (e) => e.key === "Enter" && openIt());
  attachMenu(el, ws, board, hooks, el.querySelector(".atitle b") as HTMLElement, "arow");

  const act = el.querySelector(".iact")!;
  const back = h("button", "ghost", `${icon("archive-restore", 14)}<span></span>`);
  back.children[1].textContent = t("ws.menu.unarchive");
  back.title = ws.cleaned ? t("ws.menu.gone") : t("ws.menu.unarchive");
  (back as HTMLButtonElement).disabled = ws.cleaned;
  back.addEventListener("click", (e) => {
    e.stopPropagation();
    hooks.archive(ws.id, false);
  });
  act.append(back);
  return el;
}
