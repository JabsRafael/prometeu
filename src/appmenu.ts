/// Native menu accelerators keep shortcuts working while an embedded webview owns focus. Dispatch the same actions as main.ts; document handlers preventDefault to avoid double execution. Override Tauri's default Command-W window closure with tab closure.
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { t, type Key } from "./i18n";

/// Shared action names for native-menu and document-keyboard dispatch.
export type Action =
  | "novoWorkspace"
  | "novaConversa"
  | "fechar"
  | "arquivar"
  | "concluir"
  | "run"
  | "lateral"
  | "nota"
  | "ajustes"
  | "quickOpen"
  | "voltar"
  | "avancar";

export async function install(run: (a: Action) => void) {
  const our = (id: Action, key: Key, accelerator: string) =>
    MenuItem.new({ id, text: t(key), accelerator, action: () => run(id) });
  // The Mac implements system actions such as copy, quit, and full screen; localize their labels here.
  type Native = Exclude<Parameters<typeof PredefinedMenuItem.new>[0], undefined>["item"];
  const os = (item: Native, key?: Key) =>
    PredefinedMenuItem.new(key ? { item, text: t(key) } : { item });
  const bar = (text: string, items: Promise<MenuItem | PredefinedMenuItem>[]) =>
    Promise.all(items).then((all) => Submenu.new({ text, items: all }));

  const menu = await Menu.new({
    items: await Promise.all([
      // The application-named menu contains About, Hide, and Quit as macOS expects.
      bar("Prometeu", [
        os({ About: null }, "menu.app.about"),
        os("Separator"),
        our("ajustes", "menu.app.settings", "CmdOrCtrl+,"),
        os("Separator"),
        os("Services", "menu.app.services"),
        os("Separator"),
        os("Hide", "menu.app.hide"),
        os("HideOthers", "menu.app.hideOthers"),
        os("ShowAll", "menu.app.showAll"),
        os("Separator"),
        os("Quit", "menu.app.quit"),
      ]),
      bar(t("menu.file"), [
        our("novoWorkspace", "menu.file.newWorkspace", "CmdOrCtrl+N"),
        our("novaConversa", "menu.file.newChat", "CmdOrCtrl+T"),
        our("quickOpen", "menu.file.quickOpen", "CmdOrCtrl+P"),
        os("Separator"),
        // Command-W closes the current tab; Shift-Command-W closes the window.
        our("fechar", "menu.file.close", "CmdOrCtrl+W"),
        os("CloseWindow", "menu.file.closeWindow"),
      ]),
      // The Edit menu enables copy and paste inside embedded pages, which have no independent menu.
      bar(t("menu.edit"), [
        os("Undo", "menu.edit.undo"),
        os("Redo", "menu.edit.redo"),
        os("Separator"),
        os("Cut", "menu.edit.cut"),
        os("Copy", "menu.edit.copy"),
        os("Paste", "menu.edit.paste"),
        os("SelectAll", "menu.edit.selectAll"),
      ]),
      bar(t("menu.view"), [
        our("lateral", "menu.view.rail", "CmdOrCtrl+B"),
        our("run", "menu.view.run", "CmdOrCtrl+R"),
        os("Separator"),
        our("voltar", "menu.view.back", "CmdOrCtrl+["),
        our("avancar", "menu.view.fwd", "CmdOrCtrl+]"),
        os("Separator"),
        os("Fullscreen", "menu.view.fullscreen"),
      ]),
      bar(t("menu.ws"), [
        our("nota", "menu.ws.note", "CmdOrCtrl+Shift+M"),
        os("Separator"),
        our("arquivar", "menu.ws.archive", "CmdOrCtrl+Shift+A"),
        our("concluir", "menu.ws.finish", "CmdOrCtrl+Shift+D"),
      ]),
      bar(t("menu.window"), [
        os("Minimize", "menu.window.minimize"),
        os("Maximize", "menu.window.zoom"),
      ]),
    ]),
  });
  await menu.setAsAppMenu();
}
