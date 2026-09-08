import { avatar, icon } from "./icons";
import { t } from "./i18n";
import * as team from "./team";
import { h, template } from "./util";

/// The mention inbox selects a conversation to open; threads are read beside that conversation. Only resolving a thread removes it from the relay inbox.

export function openInbox(go: (workspace: string, note: string, tab: string | null) => void) {
  const veil = document.getElementById("veil")!;
  const sheet = h("div", "sheet inbox");
  sheet.innerHTML = `
    <div class="sheettop">
      <span class="who"><b></b></span>
      <span class="spacer"></span>
      <span class="sub"></span>
    </div>
    <div class="inboxlist"></div>
    <div class="sheetbar">
      <span class="spacer"></span>
      <button class="ghost md"></button>
    </div>`;
  sheet.querySelector(".who b")!.textContent = t("inbox.title");
  const list = sheet.querySelector(".inboxlist") as HTMLElement;
  const close = sheet.querySelector(".sheetbar button") as HTMLButtonElement;
  close.textContent = t("clean.cancel");

  const hide = () => {
    veil.replaceChildren();
    veil.hidden = true;
    window.removeEventListener("keydown", key);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") hide();
  };
  close.addEventListener("click", hide);
  veil.onmousedown = (e) => {
    if (e.target === veil) hide();
  };
  window.addEventListener("keydown", key);

  function draw() {
    const items = team.inboxList();
    sheet.querySelector(".sub")!.textContent = items.length ? String(items.length) : "";
    list.replaceChildren();
    if (!items.length) {
      list.append(h("div", "cleanempty", t("inbox.empty")));
      return;
    }
    for (const item of items) {
      const row = template(
        "button",
        "inboxrow",
        `<span class="av"></span><span class="txt"><b></b><span class="what"></span></span>` +
          `<span class="go">${icon("arrow-right", 14)}</span>`,
      );
      row.querySelector(".av")!.innerHTML = avatar(item.author);
      row.querySelector("b")!.textContent = t("inbox.from", { name: item.author });
      row.querySelector(".what")!.textContent = item.text || item.title;
      row.title = t("inbox.open");
      row.addEventListener("click", () => {
        const at = team.readInbox(item.id);
        hide();
        if (at) go(at.workspace, at.note, at.tab);
      });
      list.append(row);
    }
  }

  team.onChange(() => {
    if (!veil.hidden) draw();
  });
  draw();
  veil.replaceChildren(sheet);
  veil.hidden = false;
}
