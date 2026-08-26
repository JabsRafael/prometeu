import { invoke } from "@tauri-apps/api/core";
import { icon } from "./icons";
import { current as locale, fromBack, paint, t, tn } from "./i18n";
import type { Cleanable } from "./types";
import { h } from "./util";

/// Devolver worktrees ao disco: a folha que lista os arquivados que ainda
/// ocupam espaço, com o tamanho de cada um, e apaga os que você marcar.
///
/// É a única coisa no app que apaga trabalho do disco, então é em lote e à
/// vista: quem decide são as guardas do back — nada com mudança fora de commit
/// e nada que não tenha entrado no alvo aparece marcável —, e a lista mostra o
/// motivo de cada um que não pode. A branch local vai junto; o card fica.

/// Kilobytes como quem lê: é o número que decide se vale a pena, e 2,9 GB
/// decide melhor que 3 048 576.
function size(kb: number): string {
  const mb = kb / 1024;
  if (mb >= 1024) return `${(mb / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(mb).toLocaleString(locale())} MB`;
}

export function openCleanup(say: (text: string, isError?: boolean) => void) {
  const veil = document.getElementById("veil")!;
  const sheet = h("div", "sheet clean");
  sheet.innerHTML = `
    <div class="sheettop">
      <span class="who"><b data-t="clean.title"></b></span>
      <span class="spacer"></span>
      <span class="sub" id="c-sum"></span>
    </div>
    <div class="cleanlist" id="c-list"></div>
    <div class="cleanhint" data-t="clean.hint"></div>
    <div class="sheetbar">
      <span class="spacer"></span>
      <button id="c-cancel" class="ghost md" data-t="clean.cancel"></button>
      <button id="c-go" class="pri md" disabled></button>
    </div>`;
  paint(sheet);

  const pick = <T extends HTMLElement>(id: string) => sheet.querySelector(`#${id}`) as T;
  const list = pick("c-list");
  const go = pick<HTMLButtonElement>("c-go");

  let rows: Cleanable[] = [];
  const marked = new Set<string>();
  let running = false;

  const hide = () => {
    veil.replaceChildren();
    veil.hidden = true;
    window.removeEventListener("keydown", key);
  };
  // Enquanto está apagando, Esc não fecha: sair no meio esconderia o que ainda
  // está acontecendo com o disco.
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !running) hide();
  };

  function drawFoot() {
    const total = rows.filter((r) => marked.has(r.id)).reduce((n, r) => n + r.sizeKb, 0);
    go.textContent = marked.size ? t("clean.go", { n: marked.size, size: size(total) }) : t("clean.goEmpty");
    go.disabled = !marked.size || running;
    pick("c-sum").textContent = tn(rows.length, "clean.count");
  }

  function draw() {
    list.replaceChildren();
    if (!rows.length) {
      list.append(h("div", "cleanempty", t("clean.none")));
      drawFoot();
      return;
    }
    for (const r of rows) {
      const row = h(
        "div",
        "cleanrow" + (r.blocked ? " off" : ""),
        `<i class="box"></i><div class="txt"><b></b><span class="where"></span></div>` +
          `<span class="pr"></span><span class="sz"></span>`,
      );
      (row.querySelector("b") as HTMLElement).textContent = r.title;
      (row.querySelector(".where") as HTMLElement).textContent = r.blocked
        ? fromBack(r.blocked)
        : `${r.repoName} · ${r.branch}`;
      (row.querySelector(".pr") as HTMLElement).textContent = r.pr ? `#${r.pr}` : "";
      (row.querySelector(".sz") as HTMLElement).textContent = size(r.sizeKb);
      const box = row.querySelector(".box") as HTMLElement;
      box.innerHTML = marked.has(r.id) ? icon("check", 12) : "";
      row.classList.toggle("on", marked.has(r.id));
      if (r.blocked) {
        row.title = fromBack(r.blocked);
      } else {
        row.addEventListener("click", () => {
          if (running) return;
          marked.has(r.id) ? marked.delete(r.id) : marked.add(r.id);
          draw();
        });
      }
      list.append(row);
    }
    drawFoot();
  }

  pick("c-cancel").addEventListener("click", () => !running && hide());

  go.addEventListener("click", async () => {
    if (!marked.size || running) return;
    running = true;
    drawFoot();
    // Um de cada vez: cada um mata processo, roda o `archive` do repositório e
    // mexe no git do mesmo clone — em paralelo eles disputariam o index.
    let done = 0;
    let freed = 0;
    for (const r of rows.filter((x) => marked.has(x.id))) {
      go.textContent = t("clean.doing", { name: r.title });
      try {
        await invoke("cleanup_worktree", { id: r.id });
        done++;
        freed += r.sizeKb;
      } catch (e) {
        say(fromBack(e), true);
      }
    }
    running = false;
    hide();
    if (done) say(tn(done, "clean.done", { size: size(freed) }));
  });

  veil.onmousedown = (e) => {
    if (e.target === veil && !running) hide();
  };
  window.addEventListener("keydown", key);
  veil.replaceChildren(sheet);
  veil.hidden = false;

  // A lista custa um `git status` e um `du` por linha: vem depois da folha
  // aberta, e não antes dela.
  list.append(h("div", "cleanempty", t("clean.loading")));
  invoke<Cleanable[]>("cleanup_list")
    .then((got) => {
      rows = got.sort((a, b) => b.sizeKb - a.sizeKb);
      for (const r of rows) if (!r.blocked) marked.add(r.id);
      draw();
    })
    .catch((e) => {
      say(fromBack(e), true);
      hide();
    });
}
