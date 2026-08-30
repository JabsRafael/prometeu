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
use std::collections::BTreeMap;
use std::process::Command;
use std::sync::Mutex;
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

/// O Run e nada mais: a máquina de quem está olhando. É este o endereço que a
/// aba serve para ver.
fn local(url: &Url) -> bool {
    match url.host_str() {
        Some(host) => {
            host == "localhost"
                || host == "127.0.0.1"
                || host == "::1"
                || host.ends_with(".localhost")
        }
        None => false,
    }
}

/// O host que a pessoa escreveu na barra de cada aba. Quem digita um endereço
/// pediu aquela página ali dentro — e o que ela abrir dali (um redirecionamento
/// de login, outra rota do mesmo site) continua sendo ali. Link para outro
/// host, não: esse é o navegador do sistema.
static TYPED: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

fn typed(id: &str) -> Option<String> {
    TYPED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
}

/// Se a página fica na aba. O Run e o que a pessoa digitou ficam; o resto sai.
fn inside(id: &str, url: &Url) -> bool {
    local(url) || typed(id).is_some_and(|host| Some(host.as_str()) == url.host_str())
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
/// Prometheus é o Prometheus: página de fora é assunto do navegador do sistema.
/// A aba de dentro é só o Run.
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
    // A barra de endereço tem que acompanhar quem navega dentro da página — um
    // link clicado, um redirecionamento de login. `on_navigation` conta cada
    // uma; o resto (rota de SPA, que troca a URL sem carregar página) o front
    // pega perguntando `browser_url` de vez em quando.
    let to = app.clone();
    let of = id.clone();
    window
        .add_child(
            WebviewBuilder::new(label(&id), WebviewUrl::External(parsed)).on_navigation(
                move |url| {
                    if !allowed(url) {
                        return false;
                    }
                    // Link que sai do Run vai para o navegador do sistema, e a
                    // aba fica onde estava: quem clica num link do app espera a
                    // página de fora abrir de fora.
                    if !inside(&of, url) {
                        let _ = browse(url);
                        return false;
                    }
                    let _ = to.emit("browser:url", (of.clone(), url.to_string()));
                    true
                },
            ),
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
    let mut typed = TYPED.lock().unwrap_or_else(|e| e.into_inner());
    match parsed.host_str() {
        Some(host) if !local(&parsed) => typed.insert(id.clone(), host.to_string()),
        _ => typed.remove(&id),
    };
    drop(typed);
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
    TYPED.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
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
    fn a_aba_fica_no_run_e_manda_o_resto_para_fora() {
        let run = tauri::Url::parse("http://localhost:3100/painel").unwrap();
        let outro_local = tauri::Url::parse("http://127.0.0.1:5173/").unwrap();
        let fora = tauri::Url::parse("https://github.com/gbrancaglione").unwrap();
        assert!(super::inside("ws", &run));
        assert!(super::inside("ws", &outro_local));
        assert!(!super::inside("ws", &fora));
    }

    #[test]
    fn o_que_a_pessoa_digitou_na_barra_fica_na_aba() {
        let host = |id: &str, h: &str| {
            super::TYPED
                .lock()
                .unwrap()
                .insert(id.to_string(), h.to_string())
        };
        host("digitou", "github.com");
        assert!(super::inside(
            "digitou",
            &tauri::Url::parse("https://github.com/gbrancaglione/prometheus").unwrap()
        ));
        // Outra aba não herda o que se digitou nesta.
        assert!(!super::inside(
            "outra",
            &tauri::Url::parse("https://github.com/").unwrap()
        ));
        // E um link para outro site sai da aba mesmo assim.
        assert!(!super::inside(
            "digitou",
            &tauri::Url::parse("https://example.com/").unwrap()
        ));
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
