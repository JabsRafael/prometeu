/// Display workspace Run in a native child webview over the main window's content area. The
/// frontend measures its logical bounds because native views do not follow CSS. Resolve the initial
/// port from backend state, and retain one webview per workspace so hiding and showing it preserves
/// navigation.
use crate::dock::ensure_port;
use crate::{i18n, AppState};
use std::process::Command;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, State, Url, WebviewBuilder,
    WebviewUrl,
};

/// Sanitize the webview label to Tauri's supported characters even though workspace IDs already
/// follow this format.
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

/// Open only HTTP or HTTPS URLs in the system browser. Other schemes could open local files or
/// arbitrary applications.
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

/// Links from app content open in the system browser. The embedded view belongs to Run; navigation
/// within that view remains the person's choice.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let parsed =
        Url::parse(&url).map_err(|_| i18n::ta("err.browser.badUrl", &[("url", url.clone())]))?;
    browse(&parsed)
}

/// Create the workspace webview on first use. The frontend supplies its bounds separately; return
/// the port for the address display.
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
    // on_navigation includes subframes without identifying the main frame, so permit navigation by
    // scheme rather than host. Redirecting off-site frames would open a browser tab for every ad or
    // login iframe. Track main-frame page loads, and poll browser_url for SPA history changes.
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
                // Open window.open and target=_blank requests in the system browser while
                // preserving the embedded page.
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

/// Read the current webview URL to catch SPA navigation and history.pushState changes.
#[tauri::command]
pub fn browser_url(app: AppHandle, id: String) -> Option<String> {
    let view = app.get_webview(&label(&id))?;
    view.url().ok().map(|u| u.to_string())
}

/// Accept typed HTTP or HTTPS addresses only. Unlike the initial Run URL, this address
/// intentionally comes from the frontend; reject file and application schemes.
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

/// Use logical pixels relative to the window, matching getBoundingClientRect in the full-window
/// main webview.
#[tauri::command]
pub fn browser_bounds(app: AppHandle, id: String, x: f64, y: f64, w: f64, h: f64) {
    if let Some(view) = app.get_webview(&label(&id)) {
        let _ = view.set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(w, h).into(),
        });
    }
}

/// Hide the webview without destroying its page when the center panel or workspace changes.
#[tauri::command]
pub fn browser_hide(app: AppHandle, id: String) {
    if let Some(view) = app.get_webview(&label(&id)) {
        let _ = view.hide();
    }
}

/// Use the page's native history for back and forward because Tauri does not expose dedicated
/// navigation methods.
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

/// Destroy closed tabs' webviews to avoid retaining hidden pages and their resource usage.
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
