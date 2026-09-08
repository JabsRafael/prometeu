/// The backend overlays a native webview on #webbody. Send its DOM bounds after layout changes because native positioning does not follow CSS.
import { invoke } from "./ipc";
import { listen } from "@tauri-apps/api/event";
import { fromBack } from "./i18n";
import { $ } from "./util";

/// The workspace whose native webview is visible.
let shown: string | null = null;

/// Native webviews sit above DOM content regardless of z-index. Hide the webview while #veil is visible and restore it afterward.
let veiled = false;

/// Navigation events and polling must preserve address-bar edits.
const bar = () => $("wurl") as HTMLInputElement;
const typing = () => document.activeElement === bar();

/// Poll for SPA URL changes that do not trigger on_navigation.
let poll = 0;

export function init(external: (id: string) => void, say: (m: string, err?: boolean) => void) {
  // Back and forward navigate the embedded page, independently of application history.
  $("wback").addEventListener("click", () => shown && invoke("browser_back", { id: shown }));
  $("wfwd").addEventListener("click", () => shown && invoke("browser_forward", { id: shown }));
  $("wreload").addEventListener("click", () => shown && invoke("browser_reload", { id: shown }));
  $("wext").addEventListener("click", () => shown && external(shown));
  // Observe bounds changes from sidebar toggles, panel visibility, and window resizing.
  new ResizeObserver(place).observe($("webbody"));
  const veil = $("veil");
  new MutationObserver(() => {
    const now = !veil.hidden;
    if (now === veiled) return;
    veiled = now;
    if (!shown) return;
    if (veiled) invoke("browser_hide", { id: shown });
    else void invoke("browser_open", { id: shown }).then(place);
  }).observe(veil, { attributes: true, attributeFilter: ["hidden"] });

  bar().addEventListener("keydown", (e) => {
    if (e.key === "Enter") go(say);
    // Escape discards address editing and restores the current page URL.
    else if (e.key === "Escape") void refresh().then(() => bar().blur());
  });
  // Select the address on focus to make replacing the URL easy.
  bar().addEventListener("focus", () => bar().select());
  bar().addEventListener("blur", () => void refresh());

  listen<[string, string]>("browser:url", ({ payload: [id, url] }) => {
    if (id === shown && !typing()) bar().value = url;
  });
}

/// Show or create the workspace webview and return its port for the tab label.
export async function show(id: string): Promise<number> {
  const port = await invoke("browser_open", { id });
  shown = id;
  // Wait for the modal to close before revealing the webview.
  if (veiled) invoke("browser_hide", { id });
  bar().value = `http://localhost:${port}`;
  place();
  void refresh();
  clearInterval(poll);
  poll = setInterval(refresh, 1000);
  return port;
}

/// Hide without destroying the page when switching tabs or workspaces.
export function hide() {
  if (!shown) return;
  clearInterval(poll);
  invoke("browser_hide", { id: shown });
  shown = null;
}

export function close(id: string) {
  if (shown === id) {
    clearInterval(poll);
    shown = null;
  }
  invoke("browser_close", { id });
}

/// Default addresses without a scheme to HTTP for local development servers.
function go(say: (m: string, err?: boolean) => void) {
  const id = shown;
  if (!id) return;
  const typed = bar().value.trim();
  if (!typed) return void refresh();
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`;
  bar().blur();
  invoke("browser_navigate", { id, url }).catch((e) => {
    say(fromBack(e), true);
    void refresh();
  });
}

/// Refresh the address bar from the page's current URL.
async function refresh() {
  if (!shown || typing()) return;
  const url = await invoke("browser_url", { id: shown });
  if (url && !typing()) bar().value = url;
}

function place() {
  if (!shown) return;
  const r = $("webbody").getBoundingClientRect();
  if (!r.width || !r.height) return;
  invoke("browser_bounds", { id: shown, x: r.left, y: r.top, w: r.width, h: r.height });
}
