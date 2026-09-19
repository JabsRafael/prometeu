import { descriptor, descriptors, type AgentDescriptor, type AuthMethod } from "./agents";
import { invoke, type IpcCall } from "./ipc";
import { brand } from "./icons";
import { fromBack, t } from "./i18n";
import type { ProviderId } from "./types";
import { button, confirmDialog, field, formDialog, input, menuButton, select } from "./ui";
import { h } from "./util";

export type Account = {
  id: string; provider: ProviderId; email: string | null; plan: string | null;
  connected: boolean; revision: number; authMethod?: string; keySuffix?: string;
};
export type Accounts = {
  accounts: Account[]; active: Partial<Record<ProviderId, string>>;
  login: { id: string; provider: ProviderId } | null;
};

export let accounts: Accounts | null = null;
let busy = false;
let say: (text: string, error?: boolean) => void = () => {};
let quota: (id: string) => string = () => "";
const listeners = new Set<() => void>();
export function onChange(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
function changed() { for (const listener of listeners) listener(); }
export function init(options: { say: typeof say; quota: typeof quota }) { say = options.say; quota = options.quota; }
export function refreshUsage() { changed(); }
export function update(next: Accounts): boolean {
  const selected = (data: Accounts | null) => data && JSON.stringify(data.accounts
    .filter(account => data.active[account.provider] === account.id).map(({ id, revision }) => [id, revision]));
  const selectionChanged = selected(accounts) !== selected(next);
  accounts = next;
  changed();
  return selectionChanged;
}
export function accountName(account: Account) {
  if (account.keySuffix) return `${t("account.apiKey")} · ${account.keySuffix}`;
  return account.email || t(account.id === account.provider ? "account.terminal" : "account.new");
}

/// The launcher's preflight follows the same global selection as process creation.
export function selected(provider: ProviderId): Account | undefined {
  const id = accounts?.active[provider];
  return accounts?.accounts.find(account => account.provider === provider && id === account.id);
}

export function openPicker(provider: ProviderId) {
  const dialog = formDialog({
    title: t("account.use"), save: t("account.continue"), cancel: t("account.cancel"), error: fromBack,
    submit: async () => { if (!selected(provider)) throw new Error(t("launcher.account.required")); },
    closed: () => forget(),
  });
  const draw = () => {
    const focus = (document.activeElement as HTMLElement | null)?.dataset.focus;
    dialog.body.replaceChildren(render([descriptor(provider)]));
    dialog.save.disabled = !selected(provider) || busy || !!accounts?.login;
    if (focus) dialog.body.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
  };
  const forget = onChange(draw);
  draw();
  dialog.open();
}

function focusAccount(id: string) {
  requestAnimationFrame(() => {
    const nodes = document.querySelectorAll<HTMLElement>(`[data-account="${CSS.escape(id)}"] .account-select`);
    const node = [...nodes].find(node => node.getClientRects().length);
    node?.scrollIntoView({ block: "nearest" });
    node?.focus({ preventScroll: true });
  });
}

async function call(...args: IpcCall<"account_select" | "account_login" | "account_remove" | "account_api_key">) {
  if (busy || accounts?.login) throw new Error(t("err.account.busy"));
  busy = true; changed();
  try {
    const before = new Set(accounts?.accounts.map(a => a.id));
    const next = await invoke(...args);
    update(next);
    if (args[0] === "account_login" || args[0] === "account_api_key") {
      say(t("account.connected"));
      const added = next.accounts.find(a => !before.has(a.id));
      const id = added?.id ?? args[1].id;
      if (id) focusAccount(id);
    }
  } finally { busy = false; changed(); }
}
function run(work: Promise<unknown>) { void work.catch(error => say(fromBack(error), true)); }

async function remove(account: Account) {
  if (accounts?.active[account.provider] === account.id && !await confirmDialog({
    title: t("account.removeActive"), message: t("account.removeActive.message"),
    accept: t("account.remove"), cancel: t("account.cancel"),
  })) return;
  await call("account_remove", { id: account.id });
  requestAnimationFrame(() => {
    const groups = document.querySelectorAll<HTMLElement>(`[data-provider-accounts="${account.provider}"]`);
    const group = [...groups].find(node => node.getClientRects().length);
    if (group) (group.querySelector<HTMLElement>(".account-select:not(:disabled), .account-add button:not(:disabled)") ?? group).focus();
  });
}

function apiKey(provider: ProviderId, id: string | null) {
  const secret = input("");
  secret.type = "password"; secret.required = true; secret.autocomplete = "off";
  const dialog = formDialog({
    title: t(id ? "account.reconnect" : "account.add"), save: t("account.connect"), cancel: t("account.cancel"),
    error: fromBack, closed: () => { secret.value = ""; },
    submit: async () => {
      const key = secret.value;
      secret.value = "";
      await call("account_api_key", { provider, id, key });
    },
  });
  dialog.body.append(field(t("account.apiKey"), secret, t("account.apiKey.help")));
  dialog.open();
}
function start(provider: ProviderId, method: AuthMethod, id: string | null) {
  if (method.kind === "apiKey") apiKey(provider, id);
  else run(call("account_login", { provider, id, method: method.id }));
}
export function add(provider: ProviderId, id: string | null = null) {
  const methods = descriptor(provider).authMethods ?? [];
  const account = accounts?.accounts.find(a => a.id === id);
  const previous = methods.find(m => m.id === account?.authMethod);
  if (previous) return start(provider, previous, id);
  if (methods.length === 1) return start(provider, methods[0], id);
  if (!methods.length) return;
  const method = select(methods[0].id, methods.map(m => [m.id, m.kind === "apiKey" ? t("account.apiKey") : m.label]));
  let selected: AuthMethod | undefined;
  const dialog = formDialog({
    title: t("account.add"), save: t("account.continue"), cancel: t("account.cancel"), error: fromBack,
    submit: async () => { selected = methods.find(m => m.id === method.value); },
    closed: () => { if (selected) start(provider, selected, id); },
  });
  dialog.body.append(field(t("account.method"), method.root));
  dialog.open();
}

function card(account: Account): HTMLElement {
  const active = accounts?.active[account.provider] === account.id;
  const external = account.id === account.provider;
  const loggingIn = accounts?.login?.id === account.id;
  const root = h("section", `uaccount${active ? " active" : ""}`);
  root.dataset.account = account.id;
  const choose = button("", () => run(call("account_select", { id: account.id })));
  choose.className = "account-select";
  choose.dataset.focus = `select-${account.id}`;
  choose.setAttribute("aria-label", accountName(account));
  choose.setAttribute("aria-pressed", String(active));
  choose.disabled = busy || !!accounts?.login || (!account.connected && !external);
  const content = h("div", "account-content");
  const heading = h("div", "account-heading");
  const name = h("strong", "", accountName(account)); name.title = accountName(account);
  const actions = menuButton("…", () => [
    ...(!external ? [{ label: t("account.reconnect"), run: () => add(account.provider, account.id) }] : []),
    { label: t("account.remove"), danger: true, run: () => run(remove(account)) },
  ]);
  actions.setAttribute("aria-label", t("account.actions"));
  actions.dataset.focus = `actions-${account.id}`;
  actions.disabled = busy || !!accounts?.login;
  heading.append(name, actions); content.append(heading);
  if (active || account.connected || external) content.append(h("small", "account-state", t(active ? "account.active" : "account.use")));
  if (loggingIn) {
    const wait = h("div", "account-wait", t("account.browser")); wait.setAttribute("role", "status");
    wait.append(button(t("account.cancel"), () => run(invoke("account_login_cancel", { id: account.id }))));
    content.append(wait);
  } else if (!account.connected && !external) content.append(h("small", "", t("account.disconnected")));
  if (account.plan) content.append(h("div", "account-meta", account.plan));
  const limits = h("div", "account-quotas"); limits.innerHTML = quota(account.id);
  content.append(limits); root.append(choose, content);
  return root;
}

export function render(providers: readonly AgentDescriptor[] = descriptors()): HTMLElement {
  const root = h("div", "accounts-view");
  for (const provider of providers) {
    const group = h("section", "accounts-provider"); group.dataset.providerAccounts = provider.id; group.tabIndex = -1; group.setAttribute("aria-label", provider.label);
    const heading = h("div", "uhead");
    const mark = h("span", ""); mark.innerHTML = brand(provider.id);
    heading.append(mark, h("span", "uname", provider.label)); group.append(heading);
    if (!provider.installed) group.append(h("p", "ui-hint", provider.unavailableReason ? fromBack(provider.unavailableReason) : t("account.install", { provider: provider.label })));
    const list = accounts?.accounts.filter(a => a.provider === provider.id) ?? [];
    if (!list.length) group.append(h("div", "uempty", t("account.empty")));
    group.append(...list.map(card));
    const addButton = button(t("account.add"), () => add(provider.id));
    addButton.dataset.focus = `add-${provider.id}`;
    addButton.disabled = !provider.installed || busy || !!accounts?.login;
    const footer = h("div", "account-add"); footer.append(addButton); group.append(footer); root.append(group);
  }
  return root;
}
