import { invoke, type IpcResult } from "./ipc";
import * as catalog from "./catalog";
import { fromBack, t } from "./i18n";
import { icon } from "./icons";
import * as menu from "./menu";
import { button } from "./ui";
import { h } from "./util";

export type CloudStatus = {
  user: { id: string; name: string; email: string } | null;
  origin: string;
  offline: boolean;
};
type Login = IpcResult<"cloud_login_start">;
let status: CloudStatus = { user: null, origin: "", offline: false };
let changed = () => {};
let fail = (_message: string) => {};
let refreshing = false;
let pending: { code: string; open: () => void; cancel: () => void } | null = null;
export const current = () => status;

export function init(redraw: () => void, onError: (message: string) => void) {
  changed = redraw; fail = onError;
  // Local usage does not wait for the network. Without an account, no SaaS requests are sent.
  void invoke("cloud_status", { refresh: false }).then(value => {
    status = value; changed(); void refresh();
  }).catch(error => fail(fromBack(error)));
  window.addEventListener("focus", () => void refresh());
  setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
}

async function refresh() {
  if (!status.user || refreshing) return;
  refreshing = true;
  try { status = await invoke("cloud_status", { refresh: true }); changed(); await catalog.load(); }
  catch (error) { fail(fromBack(error)); }
  finally { refreshing = false; }
}

export function accountButton() {
  const control = button("", () => {
    if (!status.user && !pending) { connect(); return; }
    const at = control.getBoundingClientRect();
    control.setAttribute("aria-expanded", "true");
    if (pending) {
      menu.openAt({ x: at.left, y: at.bottom + 4 }, [
        { label: t("cloud.openBrowser"), run: pending.open },
        { label: t("cloud.cancel"), run: pending.cancel },
      ], undefined, () => control.setAttribute("aria-expanded", "false"));
      return;
    }
    menu.openAt({ x: at.left, y: at.bottom + 4 }, [
      { label: t("catalog.manage"), run: () => { void invoke("open_external", { url: `${status.origin}/catalog` }).catch(error => fail(fromBack(error))); } },
      { label: t("organization.manage"), run: () => { void invoke("open_external", { url: `${status.origin}/settings/organizations` }).catch(error => fail(fromBack(error))); } },
      { label: t("cloud.manage"), glyph: icon("external-link"), run: () => {
        void invoke("open_external", { url: status.origin }).catch(error => fail(fromBack(error)));
      } },
      { label: t("cloud.refresh"), glyph: icon("rotate"), run: () => void refresh() },
      "sep",
      { label: t("cloud.logout"), run: () => {
        void invoke("cloud_logout").then(value => { status = value; changed(); void catalog.load().catch(error => fail(fromBack(error))); }).catch(error => fail(fromBack(error)));
      } },
    ], undefined, () => control.setAttribute("aria-expanded", "false"));
  }, "ghost");
  control.classList.remove("md"); control.classList.add("navitem", "brand", "cloud-account");
  control.classList.toggle("cloud-guest", !status.user);
  const glyph = h("span", "av");
  glyph.innerHTML = icon("flame");
  const label = h("span", "cloud-label");
  label.append(h("span", "", "Prometeu"), h("small", "", status.user
    ? `${status.user.name}${status.offline ? ` · ${t("cloud.offline")}` : ""}` : pending ? pending.code || t("cloud.opening") : t("cloud.signup")));
  if (pending) label.lastElementChild!.setAttribute("role", "status");
  control.append(glyph, label);
  if (status.user || pending) {
    control.insertAdjacentHTML("beforeend", icon("chevron-down", 14));
    control.setAttribute("aria-haspopup", "menu"); control.setAttribute("aria-expanded", "false");
    control.onkeydown = event => { if (event.key === "ArrowDown" && !menu.isOpen()) { event.preventDefault(); control.click(); } };
  }
  control.title = pending ? `${t("cloud.waiting")} ${t("cloud.codeHint")} ${pending.code}` : status.user?.email ?? t("cloud.optionalHint");
  return control;
}

function connect() {
  let attempt: Login | null = null;
  let closed = false;
  let busy = false;
  let timer = 0;
  function close() {
    closed = true; clearTimeout(timer); pending = null; changed();
    if (attempt) void invoke("cloud_login_cancel", { id: attempt.id }).catch(() => {});
  }
  const progress = pending = {
    code: "",
    open: () => { if (attempt) void invoke("open_external", { url: attempt.url }).catch(cause => fail(fromBack(cause))); },
    cancel: close,
  };
  changed();
  const schedule = () => { clearTimeout(timer); if (!closed) timer = setTimeout(() => void poll(), (attempt?.interval ?? 5) * 1000); };
  async function poll() {
    if (busy || closed || !attempt) return;
    busy = true;
    try {
      const value = await invoke("cloud_login_poll", { id: attempt.id });
      if (closed) return;
      if (value) { status = value; close(); void catalog.load().catch(cause => fail(fromBack(cause))); void refresh(); } else schedule();
    } catch (cause) {
      if (!closed) { close(); fail(fromBack(cause)); }
    } finally { busy = false; }
  }
  async function start() {
    if (busy || closed) return;
    busy = true;
    try {
      attempt = await invoke("cloud_login_start", { signup: true });
      if (closed) { void invoke("cloud_login_cancel", { id: attempt.id }).catch(() => {}); return; }
      progress.code = attempt.user_code; changed(); schedule();
    } catch (cause) { if (!closed) { close(); fail(fromBack(cause)); } }
    finally { busy = false; }
  }
  void start();
}
