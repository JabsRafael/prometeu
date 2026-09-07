import { invoke } from "./ipc";
import { fromBack, t } from "./i18n";
import { icon } from "./icons";
import * as menu from "./menu";
import { button, formDialog } from "./ui";
import { h } from "./util";

export type CloudStatus = {
  user: { id: string; name: string; email: string } | null;
  origin: string;
  offline: boolean;
};
type Login = { id: string; user_code: string; url: string; interval: number };
let status: CloudStatus = { user: null, origin: "", offline: false };
let changed = () => {};
let fail = (_message: string) => {};
let refreshing = false;

export function init(redraw: () => void, onError: (message: string) => void) {
  changed = redraw; fail = onError;
  // O uso local não espera pela rede. Sem conta, nenhum pedido sai para o SaaS.
  void invoke<CloudStatus>("cloud_status", { refresh: false }).then(value => {
    status = value; changed(); void refresh();
  }).catch(error => fail(fromBack(error)));
  window.addEventListener("focus", () => void refresh());
  setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
}

async function refresh() {
  if (!status.user || refreshing) return;
  refreshing = true;
  try { status = await invoke<CloudStatus>("cloud_status", { refresh: true }); changed(); }
  catch (error) { fail(fromBack(error)); }
  finally { refreshing = false; }
}

export function accountButton() {
  const control = button("", () => {
    if (!status.user) { connect(); return; }
    const at = control.getBoundingClientRect();
    control.setAttribute("aria-expanded", "true");
    menu.openAt({ x: at.left, y: at.bottom + 4 }, [
      { label: t("cloud.manage"), glyph: icon("external-link"), run: () => {
        void invoke("open_external", { url: status.origin }).catch(error => fail(fromBack(error)));
      } },
      { label: t("cloud.refresh"), glyph: icon("rotate"), run: () => void refresh() },
      "sep",
      { label: t("cloud.logout"), run: () => {
        void invoke<CloudStatus>("cloud_logout").then(value => { status = value; changed(); }).catch(error => fail(fromBack(error)));
      } },
    ], undefined, () => control.setAttribute("aria-expanded", "false"));
  }, "ghost");
  control.classList.remove("md"); control.classList.add("navitem", "brand", "cloud-account");
  control.classList.toggle("cloud-guest", !status.user);
  const glyph = h("span", "av");
  glyph.innerHTML = icon("flame");
  const label = h("span", "cloud-label");
  label.append(h("span", "", "Prometeu"), h("small", "", status.user
    ? `${status.user.name}${status.offline ? ` · ${t("cloud.offline")}` : ""}` : t("cloud.signup")));
  control.append(glyph, label);
  if (status.user) {
    control.insertAdjacentHTML("beforeend", icon("chevron-down", 14));
    control.setAttribute("aria-haspopup", "menu"); control.setAttribute("aria-expanded", "false");
    control.onkeydown = event => { if (event.key === "ArrowDown" && !menu.isOpen()) { event.preventDefault(); control.click(); } };
  }
  control.title = status.user?.email ?? t("cloud.optionalHint");
  return control;
}

function connect() {
  let attempt: Login | null = null;
  let closed = false;
  let busy = false;
  let timer = 0;
  const info = h("p", "ui-hint", t("cloud.connectHint"));
  const code = h("strong", "cloud-code", t("cloud.opening"));
  code.setAttribute("role", "status");
  const error = h("p", "ui-hint ui-error"); error.setAttribute("role", "alert");
  const open = button(t("cloud.openBrowser"), () => {
    if (attempt) void invoke("open_external", { url: attempt.url }).catch(cause => { error.textContent = fromBack(cause); });
  });
  open.disabled = true;
  const dialog = formDialog({
    title: t("cloud.connect"), save: t("cloud.check"), cancel: t("cloud.cancel"), error: fromBack,
    submit: async () => {
      if (!attempt) await start(); else await poll();
      if (!closed) throw t("cloud.waiting");
    },
    closed: () => {
      closed = true; clearTimeout(timer);
      if (attempt) void invoke("cloud_login_cancel", { id: attempt.id }).catch(() => {});
    },
  });
  const schedule = () => { clearTimeout(timer); if (!closed) timer = setTimeout(() => void poll(), (attempt?.interval ?? 5) * 1000); };
  async function poll() {
    if (busy || closed || !attempt) return;
    busy = true;
    try {
      const value = await invoke<CloudStatus | null>("cloud_login_poll", { id: attempt.id });
      if (closed) return;
      if (value) { status = value; changed(); dialog.close(); } else schedule();
    } catch (cause) {
      if (!closed) { error.textContent = fromBack(cause); attempt = null; open.disabled = true; }
    } finally { busy = false; }
  }
  async function start() {
    if (busy || closed) return;
    busy = true; error.textContent = "";
    try {
      attempt = await invoke<Login>("cloud_login_start", { signup: true });
      if (closed) { void invoke("cloud_login_cancel", { id: attempt.id }).catch(() => {}); return; }
      code.textContent = attempt.user_code; open.disabled = false; schedule();
    } catch (cause) { if (!closed) { code.textContent = ""; error.textContent = fromBack(cause); } }
    finally { busy = false; }
  }
  dialog.body.append(info, code, h("p", "ui-hint", t("cloud.codeHint")), open, error);
  dialog.open(); void start();
}
