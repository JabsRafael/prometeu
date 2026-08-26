/// A aba de navegador: o Run do workspace numa webview do sistema — a mesma que
/// desenha o app — posta por cima do centro da janela principal. Não é uma
/// janela nem um `<iframe>`: janela solta perde o lugar na tela, e iframe
/// esbarra em `X-Frame-Options` e cookie de terceiro. Uma view nativa filha
/// não sabe o que o CSS fez, então o front mede o buraco que deixou para ela e
/// manda a medida a cada redesenho (`browser_bounds`).
///
/// A porta sai do estado, e não do front: URL arbitrária não viaja pelo IPC.
/// Uma webview por workspace, viva enquanto a aba existir; trocar de workspace
/// só esconde, e voltar mostra a mesma página onde estava.
use crate::session::ensure_port;
use crate::{i18n, AppState};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect, State, WebviewBuilder, WebviewUrl};

/// Rótulo da webview. O Tauri só aceita letras, dígitos, `-`, `/`, `:` e `_` —
/// o id do workspace já é assim, mas custa nada garantir.
fn label(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "-/:_".contains(c) { c } else { '-' })
        .collect();
    format!("run-{safe}")
}

/// Mostra a webview do workspace, criando na primeira vez. Nasce sem tamanho:
/// quem sabe onde ela cabe é o front, que chama `browser_bounds` em seguida.
/// Devolve a porta, que é o que a aba escreve.
#[tauri::command]
pub fn browser_open(app: AppHandle, state: State<AppState>, id: String) -> Result<u16, String> {
    let port = ensure_port(&state, &id).ok_or_else(|| i18n::t("err.session.noPort"))?;
    let url = format!("http://localhost:{port}");
    let fail = || i18n::ta("err.session.openFailed", &[("path", url.clone())]);
    if let Some(view) = app.get_webview(&label(&id)) {
        view.show().map_err(|_| fail())?;
        return Ok(port);
    }
    let window = app.get_window("main").ok_or_else(fail)?;
    let parsed = tauri::Url::parse(&url).map_err(|_| fail())?;
    window
        .add_child(
            WebviewBuilder::new(label(&id), WebviewUrl::External(parsed)),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(0.0, 0.0),
        )
        .map_err(|_| fail())?;
    Ok(port)
}

/// Onde a webview fica, em pixels lógicos a partir do canto da janela — o
/// mesmo sistema do `getBoundingClientRect` do front, porque a webview
/// principal cobre a janela inteira.
#[tauri::command]
pub fn browser_bounds(app: AppHandle, id: String, x: f64, y: f64, w: f64, h: f64) {
    if let Some(view) = app.get_webview(&label(&id)) {
        let _ = view.set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(w, h).into(),
        });
    }
}

/// Some sem fechar: o centro mostra outra coisa, ou você foi a outro workspace.
#[tauri::command]
pub fn browser_hide(app: AppHandle, id: String) {
    if let Some(view) = app.get_webview(&label(&id)) {
        let _ = view.hide();
    }
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, id: String) {
    if let Some(view) = app.get_webview(&label(&id)) {
        let _ = view.reload();
    }
}

/// Fechar a aba é destruir a webview: página parada por baixo de uma aba que
/// não existe é memória e CPU à toa.
#[tauri::command]
pub fn browser_close(app: AppHandle, id: String) {
    if let Some(view) = app.get_webview(&label(&id)) {
        let _ = view.close();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn label_so_com_o_que_o_tauri_aceita() {
        assert_eq!(super::label("dock-1130"), "run-dock-1130");
        assert_eq!(super::label("porta 17.a"), "run-porta-17-a");
    }
}
