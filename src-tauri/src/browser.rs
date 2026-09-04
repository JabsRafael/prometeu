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
use crate::dock::ensure_port;
use crate::{i18n, AppState};
use std::process::Command;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, Url, WebviewBuilder,
    WebviewUrl,
};

/// Rótulo da webview. O Tauri só aceita letras, dígitos, `-`, `/`, `:` e `_` —
/// o id do workspace já é assim, mas custa nada garantir.
fn label(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-/:_".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("run-{safe}")
}

fn allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// Abre no navegador do sistema. Só `http`/`https`: `open` com qualquer esquema
/// é `open` com qualquer coisa — um `file:` abriria o Finder no seu disco, e um
/// esquema de app abriria o app.
pub(crate) fn browse(url: &Url) -> Result<(), String> {
    if !allowed(url) {
        return Err(i18n::ta("err.browser.badUrl", &[("url", url.to_string())]));
    }
    let ok = Command::new("open")
        .arg(url.as_str())
        .status()
        .map_err(i18n::io)?
        .success();
    ok.then_some(())
        .ok_or_else(|| i18n::t("err.browser.noBrowser"))
}

/// Link clicado dentro do app — no texto do agente, por exemplo. A janela do
/// Prometeu é o Prometeu: página de fora é assunto do navegador do sistema.
/// A aba de dentro nasce no Run; navegar para longe dele é escolha de quem usa.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let parsed =
        Url::parse(&url).map_err(|_| i18n::ta("err.browser.badUrl", &[("url", url.clone())]))?;
    browse(&parsed)
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
    let parsed = Url::parse(&url).map_err(|_| fail())?;
    // `on_navigation` dispara para cada frame da página — os iframes de anúncio
    // e de login inclusive — e a plataforma não diz qual é o principal. Então a
    // política é por esquema, e não por destino: `http`/`https` navega na aba,
    // o resto não navega. Mandar "o que saiu do site" para fora daqui já abriu
    // uma aba de navegador por anúncio da página.
    //
    // A barra de endereço acompanha pelo `on_page_load`, que é só do frame
    // principal; rota de SPA (que troca a URL sem carregar página) o front pega
    // perguntando `browser_url` de vez em quando.
    let of = id.clone();
    window
        .add_child(
            WebviewBuilder::new(label(&id), WebviewUrl::External(parsed))
                .on_navigation(allowed)
                .on_page_load(move |view, payload| {
                    if matches!(payload.event(), PageLoadEvent::Started) {
                        let _ = view.emit("browser:url", (of.clone(), payload.url().to_string()));
                    }
                })
                // `window.open` e `target="_blank"` pedem outra janela — e outra
                // janela é assunto do navegador do sistema; a aba fica onde está.
                .on_new_window(move |url, _| {
                    let _ = browse(&url);
                    NewWindowResponse::Deny
                }),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(0.0, 0.0),
        )
        .map_err(|_| fail())?;
    Ok(port)
}

/// Onde a página está agora. É daqui que a barra de endereço se corrige quando
/// a navegação não passou por `on_navigation` — rota de SPA, `history.pushState`.
#[tauri::command]
pub fn browser_url(app: AppHandle, id: String) -> Option<String> {
    let view = app.get_webview(&label(&id))?;
    view.url().ok().map(|u| u.to_string())
}

/// Vai para o que você digitou na barra. Só `http` e `https`: o resto é que a
/// barra é um campo de texto dentro do app, e `file://` leria o seu disco.
/// Aqui a URL vem do front porque foi você que escreveu — o `browser_open`, que
/// não vem, continua tirando a porta do estado.
#[tauri::command]
pub fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let bad = || i18n::ta("err.browser.badUrl", &[("url", url.clone())]);
    let parsed = Url::parse(&url).map_err(|_| bad())?;
    if !allowed(&parsed) {
        return Err(bad());
    }
    let view = app.get_webview(&label(&id)).ok_or_else(bad)?;
    view.navigate(parsed).map_err(|_| bad())
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

/// Voltar e avançar, como em qualquer navegador — quem está testando o Run
/// entra num fluxo, erra o passo e quer o anterior de volta, e a página nem
/// sempre tem um botão para isso. É o histórico da própria webview: sem API
/// para ele no Tauri, quem anda é o `history` de dentro da página.
#[tauri::command]
pub fn browser_back(app: AppHandle, id: String) {
    hop(&app, &id, "history.back()");
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, id: String) {
    hop(&app, &id, "history.forward()");
}

fn hop(app: &AppHandle, id: &str, js: &str) {
    if let Some(view) = app.get_webview(&label(id)) {
        let _ = view.eval(js);
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

    #[test]
    fn navegacao_so_aceita_http() {
        assert!(super::allowed(
            &tauri::Url::parse("http://localhost:3000").unwrap()
        ));
        assert!(super::allowed(
            &tauri::Url::parse("https://example.com/login").unwrap()
        ));
        assert!(!super::allowed(
            &tauri::Url::parse("file:///etc/passwd").unwrap()
        ));
        assert!(!super::allowed(
            &tauri::Url::parse("javascript:alert(1)").unwrap()
        ));
    }
}
