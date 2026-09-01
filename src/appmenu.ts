/// O menu do Mac.
///
/// Ele existe por causa do foco. Os atalhos do app são um `keydown` no
/// documento (`main.ts`), e a aba de navegador é uma webview do sistema por
/// cima do centro (`browser.ts`): com o cursor dentro da página, tecla nenhuma
/// chega ao documento do app — ⌘W, ⌘T, ⌘[ e ⌘] morriam ali, e sair da aba só
/// dava no clique. Acelerador de menu chega sempre: o Mac trata a tecla antes
/// de qualquer view. Pior ainda, o menu que o Tauri monta sozinho tem ⌘W ligado
/// a "fechar a janela" — com o foco na página, ⌘W fechava o app inteiro.
///
/// Cada item chama a mesma função que o `keydown` chama. Quando o foco está no
/// app, o `keydown` atende primeiro e engole a tecla (é o `preventDefault` que
/// impede o menu de disparar em seguida); quando está na página, sobra o menu.
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { t, type Key } from "./i18n";

/// O que um atalho pede. A lista é a mesma dos dois lados — menu e teclado.
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
  | "voltar"
  | "avancar";

export async function install(run: (a: Action) => void) {
  const our = (id: Action, key: Key, accelerator: string) =>
    MenuItem.new({ id, text: t(key), accelerator, action: () => run(id) });
  // Item do sistema: quem faz é o Mac (copiar, sair, tela cheia), e o que nos
  // cabe é o rótulo, que fala o idioma da tela como o resto.
  type Native = Exclude<Parameters<typeof PredefinedMenuItem.new>[0], undefined>["item"];
  const os = (item: Native, key?: Key) =>
    PredefinedMenuItem.new(key ? { item, text: t(key) } : { item });
  const bar = (text: string, items: Promise<MenuItem | PredefinedMenuItem>[]) =>
    Promise.all(items).then((all) => Submenu.new({ text, items: all }));

  const menu = await Menu.new({
    items: await Promise.all([
      // A primeira é a do nome do app, onde o Mac espera Sobre, Ocultar e Sair.
      bar("Prometheus", [
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
        os("Separator"),
        // ⌘W é a aba, e não a janela: é a aba que se fecha o tempo todo, e
        // fechar o app sem querer custa o dobro. A janela fecha em ⇧⌘W.
        our("fechar", "menu.file.close", "CmdOrCtrl+W"),
        os("CloseWindow", "menu.file.closeWindow"),
      ]),
      // Editar não é enfeite: é daqui que copiar e colar funcionam dentro da
      // página da aba de navegador, que não tem menu nenhum por conta própria.
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
