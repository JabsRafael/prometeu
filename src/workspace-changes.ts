import { invoke } from "./ipc";
import { avatar, icon } from "./icons";
import { current as language, fromBack, t, type Key } from "./i18n";
import { $, h, template } from "./util";
import * as diff from "./diff";
import * as menu from "./menu";
import type { GitAction, GitBranch, GitCommit, GitConflict, GitDiff, GitFile, GitStatus, RepoDiff, Workspace } from "./types";

type Mode = "changes" | "branches" | "history" | "compare" | "commit" | "conflict";
type Selection = { path: string; scope: "staged" | "changes" | "conflict" };
type View = { repo: number; mode: Mode; selection: Selection | null; reference: string; collapsed: Set<string>; messages: Map<number, string>; remotes: Map<number, string>; conflicts: Map<string, { source: GitConflict; text: string }> };
type Context = {
  workspace: () => Workspace | undefined;
  refresh: () => Promise<void>;
  show: () => void;
  say: (text: string, error?: boolean) => void;
  openFile: (repo: string, path: string) => void;
  launchBranch: (project: string, base: string, branch?: string) => void;
  openWorkspace: (id: string) => void;
};
let context: Context;
const views = new Map<string, View>();
const data = new Map<string, GitStatus[]>();
let busy = false, ticket = 0, sidebarSignature = "", editorSignature = "";
/// O arquivo a rolar até no próximo desenho: clicar na lista é andar no diff
/// empilhado, não trocar de tela. Fica vazio nos redesenhos do quadro, para a
/// rolagem de quem está lendo não voltar sozinha a cada evento do agente.
let pendingFocus = "";
let review: RepoDiff[] = [];

export function init(ctx: Context) {
  context = ctx;
  $("dfold").onclick = () => { diff.foldAll(diff.keys(review)); void drawEditor(); };
  $("dseen").onclick = () => {
    const ws = context.workspace();
    if (ws) diff.seeAll(ws.id, review);
    diff.invalidate(); void drawEditor();
  };
}

function state(): View {
  const id = context.workspace()!.id;
  if (!views.has(id)) views.set(id, { repo: 0, mode: "changes", selection: null, reference: "", collapsed: new Set(), messages: new Map(), remotes: new Map(), conflicts: new Map() });
  return views.get(id)!;
}
const current = () => data.get(context.workspace()?.id ?? "")?.find(repo => repo.repo === state().repo);
export const statuses = (id: string) => data.get(id);
export const count = (id: string) => (data.get(id) ?? []).reduce((n, repo) => n + new Set([...repo.staged, ...repo.changes, ...repo.conflicts].map(file => file.path)).size, 0);

function clearEditor() {
  ticket++; editorSignature = ""; heading(t("git.changes"));
  $("dlist").replaceChildren(h("div", "none", t("git.loading")));
}

export function enter() {
  sidebarSignature = ""; clearEditor();
  $("difflist").replaceChildren();
  if (context.workspace() && !context.workspace()!.remote) drawSidebar();
}

export function forget(alive: Set<string>) {
  for (const map of [views, data]) for (const id of map.keys()) if (!alive.has(id)) map.delete(id);
}

export function update(id: string, repos: GitStatus[]) {
  const previous = data.get(id);
  data.set(id, repos.map(repo => repo.error ? { ...(previous?.find(old => old.repo === repo.repo) ?? repo), error: repo.error } : repo));
  if (context.workspace()?.id !== id) return;
  const view = state();
  if (!repos.some(repo => repo.repo === view.repo)) view.repo = repos[0]?.repo ?? 0;
  const repo = current();
  if (view.selection && repo && !repo.error) {
    const selection = view.selection;
    const group = selection.scope === "conflict" ? repo.conflicts : repo[selection.scope];
    if (!group.some(file => file.path === selection.path)) view.selection = null;
  }
  drawSidebar();
  if (!$("diffview").hidden) void drawEditor();
}

export function fail(id: string, error: unknown) {
  const ws = context.workspace();
  const existing = data.get(id);
  if (existing) update(id, existing.map(repo => ({ ...repo, error: String(error) })));
  else if (ws?.id === id) {
    $("difflist").replaceChildren(h("div", "git-error", fromBack(error)));
    $("difflist").append(button(t("git.refresh"), () => void context.refresh()));
  }
}

export function show(mode?: Mode) {
  const ws = context.workspace();
  if (!ws || ws.remote || ws.cleaned) return;
  if (mode) state().mode = mode;
  if (state().mode === "changes" && state().selection?.scope === "conflict") state().mode = "conflict";
  clearEditor();
  if (mode === "compare") state().reference = current()?.base ?? "";
  context.show(); drawSidebar(); void drawEditor();
}

export function selectRepo(index: number) {
  state().repo = index; state().selection = null; show("changes");
}

function button(label: string, click: () => void, disabled = false, className = "") {
  const node = h("button", className, label) as HTMLButtonElement;
  node.type = "button"; node.disabled = disabled; node.onclick = click;
  return node;
}

function iconButton(label: string, glyph: Parameters<typeof icon>[0], click: () => void, disabled = false) {
  const node = button("", click, disabled, "ghost git-icon");
  node.append(template("span", "", icon(glyph, 14)));
  node.title = label; node.setAttribute("aria-label", label);
  return node;
}

function selectFile(file: GitFile, scope: Selection["scope"]) {
  const view = state();
  const stay = scope !== "conflict" && view.mode === "changes" && view.selection?.scope === scope;
  view.selection = { path: file.path, scope };
  pendingFocus = scope === "conflict" ? "" : file.path;
  // Mesmo escopo, mesma tela: o diff já está montado, então só a rolagem anda.
  if (stay) { drawSidebar(); void drawEditor(); return; }
  show(scope === "conflict" ? "conflict" : "changes");
}

function drawSidebar() {
  const ws = context.workspace(); if (!ws || ws.remote) return;
  const view = state(), repo = current();
  for (const row of $("difflist").querySelectorAll<HTMLElement>(".git-file")) {
    row.classList.toggle("selected", row.dataset.path === view.selection?.path && row.closest<HTMLElement>(".git-group")?.dataset.scope === view.selection?.scope);
  }
  const activeMode = view.mode === "conflict" ? "changes" : view.mode === "commit" ? "history" : view.mode;
  for (const item of $("difflist").querySelectorAll<HTMLElement>(".git-nav button")) item.setAttribute("aria-current", String(item.dataset.mode === activeMode));
  const signature = JSON.stringify([ws.id, language(), view.repo, view.remotes.get(view.repo), data.get(ws.id), busy]);
  if (signature === sidebarSignature) return;
  sidebarSignature = signature;
  const oldInput = document.getElementById("git-message") as HTMLTextAreaElement | null;
  const focused = oldInput === document.activeElement;
  const range = oldInput && [oldInput.selectionStart, oldInput.selectionEnd];
  const list = $("difflist");
  list.classList.add("git-panel");
  list.replaceChildren();
  const picker = h("div", "git-repository");
  picker.append(template("span", "", avatar(repo?.name ?? ws.repo_name)));
  const select = button(repo?.name ?? ws.repos[view.repo]?.name ?? ws.repo_name, () => {
    const at = select.getBoundingClientRect();
    menu.openAt({ x: at.left, y: at.bottom + 4 }, ws.repos.map((item, index) => ({
      label: item.name, glyph: avatar(item.name), checked: index === view.repo,
      run: () => { view.repo = index; view.selection = null; view.mode = "changes"; view.reference = ""; clearEditor(); drawSidebar(); if (!$("diffview").hidden) void drawEditor(); },
    })));
  });
  select.setAttribute("aria-label", t("git.repository"));
  select.append(template("span", "spacer", ""), template("span", "", icon("chevron-down", 12)));
  picker.append(select, h("span", "spacer"), iconButton(t("git.refresh"), "rotate", () => { editorSignature = ""; void context.refresh(); }, busy)); list.append(picker);
  if (!repo) { list.append(h("div", "none", t("git.loading"))); return; }
  const target = { id: ws.id, repo: view.repo, index: repo.index };
  const act = (operation: GitAction, paths: string[] = [], remote?: string) => perform(target, operation, paths, remote);
  const disabled = busy || !!repo.error;
  const branch = button(repo.branch ?? t("git.detached"), () => show("branches"), false, "ghost git-branch");
  branch.prepend(template("span", "", icon("git-branch", 13)));
  branch.title = `${repo.branch ?? t("git.detached")} · ${t("git.branches")}`;
  branch.append(template("span", "", icon("chevron-down", 12)));
  const meta = h("div", "git-meta"); meta.append(branch, h("span", "spacer")); list.append(meta);
  if (repo.error) list.append(h("div", "git-error", fromBack(repo.error)));
  if (!repo.branch) list.append(h("div", "git-hint", t("err.git.detached")));
  const tools = h("div", "git-tools");
  const pullDisabled = disabled || !repo.branch || !repo.upstream || !!repo.conflicts.length || !!repo.staged.length || !!repo.changes.length || ws.tabs.some(tab => tab.status === "rodando");
  const pull = button(`↓${repo.behind}`, () => void act("pull"), pullDisabled, "ghost");
  pull.setAttribute("aria-label", t("git.pull", { n: repo.behind }));
  pull.title = ws.tabs.some(tab => tab.status === "rodando") ? t("err.git.agent") : repo.staged.length || repo.changes.length ? t("err.git.dirtyPull") : t("git.pull.hint");
  tools.append(pull);
  if (repo.upstream) {
    const push = button(`↑${repo.ahead}`, () => void act("push"), disabled || !repo.branch || !repo.ahead, "ghost");
    push.setAttribute("aria-label", t("git.push", { n: repo.ahead }));
    push.title = `${t("git.push.hint")} · ${repo.upstream}`; tools.append(push);
  } else {
    tools.append(button(t("git.publish"), () => {
      const remote = view.remotes.get(view.repo) ?? repo.remotes[0];
      void act("publish", [], remote);
    }, disabled || !repo.branch || !repo.has_head || !repo.remotes.length, "ghost"));
  }
  meta.append(tools);
  const more = iconButton(t("git.actions"), "ellipsis", () => {
    const at = more.getBoundingClientRect();
    menu.openAt({ x: at.right, y: at.bottom + 4 }, [
      { label: t("git.fetch"), hint: t("git.fetch.hint"), disabled: disabled || !repo.remotes.length, run: () => void act("fetch") },
      { label: t("git.pull", { n: repo.behind }), disabled: pullDisabled, run: () => void act("pull") },
      { label: t("git.push", { n: repo.ahead }), disabled: disabled || !repo.branch || !repo.upstream || !repo.ahead, run: () => void act("push") },
      "sep", { label: t("git.branches"), run: () => show("branches") },
    ]);
  });
  picker.append(more);
  if (!repo.upstream && repo.remotes.length > 1) {
    const remotes = button(view.remotes.get(view.repo) ?? repo.remotes[0], () => {
      const at = remotes.getBoundingClientRect();
      menu.openAt({ x: at.left, y: at.bottom + 4 }, repo.remotes.map(remote => ({
        label: remote, checked: remote === (view.remotes.get(view.repo) ?? repo.remotes[0]),
        run: () => { view.remotes.set(view.repo, remote); drawSidebar(); },
      })));
    }, busy, "git-remotes");
    remotes.id = "git-remote"; remotes.setAttribute("aria-label", t("git.remote")); list.append(remotes);
  }
  const destination = repo.upstream ?? (repo.remotes.length && repo.branch ? `${view.remotes.get(view.repo) ?? repo.remotes[0]}/${repo.branch}` : t("git.noUpstream"));
  const upstream = h("div", "git-hint git-upstream", destination);
  upstream.title = t("git.destination", { name: destination }); list.append(upstream);
  const nav = h("div", "git-nav");
  for (const mode of ["changes", "history", "compare"] as const) {
    const item = button(t(`git.${mode}`), () => show(mode), false, "ghost");
    item.dataset.mode = mode; item.setAttribute("aria-current", String(mode === activeMode)); nav.append(item);
  }
  list.append(nav);
  const composer = h("div", "git-composer");
  const input = h("textarea", "") as HTMLTextAreaElement;
  input.id = "git-message"; input.value = view.messages.get(view.repo) ?? ""; input.placeholder = t("git.message.placeholder"); input.disabled = busy;
  input.setAttribute("aria-label", t("git.message")); input.rows = 2;
  const canCommit = () => disabled || !repo.branch || !!repo.conflicts.length || (!repo.staged.length && !repo.merging) || !input.value.trim();
  const commit = button(t(repo.merging ? "git.commit.merge" : "git.commit", { n: repo.staged.length }), () => void act("commit"), canCommit(), "pri"); commit.id = "git-commit";
  commit.prepend(template("span", "", icon("check", 14)));
  commit.title = t(repo.conflicts.length ? "git.conflict.hint" : repo.staged.length ? "git.commit.hint" : "git.stage.hint");
  input.oninput = () => { view.messages.set(view.repo, input.value); commit.disabled = canCommit(); };
  composer.append(input, commit);
  list.append(composer);
  for (const scope of ["conflict", "staged", "changes"] as const) {
    const group = scope === "conflict" ? repo.conflicts : repo[scope];
    if (scope === "conflict" && !group.length) continue;
    const section = h("section", "git-group"); section.dataset.scope = scope;
    const head = h("div", "git-group-head");
    const groupKey = `${view.repo}/${scope}`, body = h("div", "git-group-files");
    body.id = `git-files-${scope}`; body.hidden = view.collapsed.has(groupKey);
    const toggle = button("", () => {
      body.hidden = !body.hidden;
      if (body.hidden) view.collapsed.add(groupKey); else view.collapsed.delete(groupKey);
      toggle.setAttribute("aria-expanded", String(!body.hidden));
    }, false, "ghost git-group-toggle");
    toggle.setAttribute("aria-expanded", String(!body.hidden)); toggle.setAttribute("aria-controls", body.id);
    toggle.append(template("span", "", icon("chevron-down", 12)), h("strong", "", t(scope === "conflict" ? "git.conflicts" : scope === "staged" ? "git.staged" : "git.changes")), h("span", "git-count", String(group.length)));
    head.append(toggle, h("span", "spacer"));
    if (scope !== "conflict") {
      const all = button(scope === "staged" ? "−" : "+", () => void act(scope === "staged" ? "unstage" : "stage", group.map(file => file.path)), disabled || !group.length, "ghost git-file-action");
      all.title = t(scope === "staged" ? "git.unstageAll" : "git.stageAll"); all.setAttribute("aria-label", all.title); head.append(all);
    }
    section.append(head, body);
    for (const file of group) {
      const selected = view.selection?.path === file.path && view.selection.scope === scope;
      const row = h("div", `git-file${selected ? " selected" : ""}`); row.dataset.path = file.path;
      const cut = file.path.lastIndexOf("/");
      const open = button("", () => selectFile(file, scope), false, "git-file-name"); open.title = file.path;
      open.append(h("span", "", file.path.slice(cut + 1)), h("small", "", file.path.slice(0, cut + 1)));
      if (file.status !== "D") open.ondblclick = () => context.openFile(repo.name, file.path);
      const letter = h("span", `git-letter status-${file.status === "?" ? "new" : file.status}`, file.status === "?" ? "U" : file.status);
      const key = `git.status.${file.status}` as Key; letter.title = t(key);
      row.append(open, letter);
      if (scope !== "conflict") {
        const action = button(scope === "staged" ? "−" : "+", () => void act(scope === "staged" ? "unstage" : "stage", [file.path]), disabled, "ghost git-file-action");
        action.title = `${t(scope === "staged" ? "git.unstage" : "git.stage")}: ${file.path}`;
        action.setAttribute("aria-label", action.title); row.append(action);
      }
      body.append(row);
    }
    if (!group.length) body.append(h("div", "git-hint", t("git.empty")));
    list.append(section);
  }
  if (busy) list.append(h("div", "git-hint", t("git.busy")));
  if (focused) { input.focus(); if (range) input.setSelectionRange(range[0], range[1]); }
}

async function perform(target: { id: string; repo: number; index: string }, operation: GitAction, paths: string[] = [], remote?: string) {
  const ws = context.workspace(), repo = current(); if (!ws || !repo || repo.error || busy) return;
  if (ws.id !== target.id || state().repo !== target.repo || repo.index !== target.index) { context.say(t("err.git.changed"), true); return; }
  const view = state(), selectedRepo = target.repo, message = view.messages.get(selectedRepo) ?? "";
  busy = true; drawSidebar();
  try {
    await invoke("workspace_git_action", { id: ws.id, repo: selectedRepo, operation, paths, message, expected: target.index, remote: remote ?? null });
    if (operation === "commit") view.messages.delete(selectedRepo);
    if ((operation === "stage" || operation === "unstage") && view.selection && paths.includes(view.selection.path)) {
      view.selection.scope = operation === "stage" ? "staged" : "changes";
      if (view.mode === "conflict") view.mode = "changes";
    }
    context.say(t("git.done"));
  } catch (error) { context.say(fromBack(error), true); }
  finally { busy = false; await context.refresh(); drawSidebar(); }
}

function heading(title: string) {
  $("dcrumb").replaceChildren(h("span", "nm", title));
  $("dseen").hidden = true; $("dfold").hidden = true;
}

async function drawEditor() {
  const ws = context.workspace(), repo = current(); if (!ws || ws.remote || $("diffview").hidden) return;
  const view = state(), mode = view.mode;
  if (mode === "compare" && document.activeElement?.classList.contains("git-base")) return;
  const mine = ++ticket;
  const valid = () => mine === ticket && context.workspace()?.id === ws.id && !$("diffview").hidden;
  const host = $("dlist"); host.classList.add("git-content");
  if (!repo) { clearEditor(); return; }
  if (repo.error) { editorSignature = ""; heading(t("git.changes")); host.replaceChildren(h("div", "git-error", fromBack(repo.error))); return; }
  const args = { id: ws.id, repo: view.repo };
  const act = (operation: GitAction, paths: string[] = []) => perform({ ...args, index: repo.index }, operation, paths);
  try {
    if (mode === "branches") {
      if (editorSignature === `${ws.id}/${view.repo}/branches`) return;
      const branches = await invoke<GitBranch[]>("workspace_git_branches", args); if (!valid()) return;
      heading(t("git.branches"));
      const box = h("div", "git-page"), search = h("input", "git-search") as HTMLInputElement;
      search.placeholder = t("git.branch.search"); search.setAttribute("aria-label", t("git.branch.search"));
      const list = h("div", "git-branches");
      const render = () => {
        list.replaceChildren();
        for (const branch of branches.filter(branch => branch.name.toLowerCase().includes(search.value.toLowerCase()))) {
          const row = h("div", "git-branch-row"); row.append(h("code", "", branch.name), h("span", "spacer"));
          if (branch.current) row.append(h("span", "git-badge", t("git.branch.current")));
          else if (branch.workspace) row.append(button(t("git.branch.open"), () => context.openWorkspace(branch.workspace!)));
          else if (branch.worktree) { const label = h("span", "git-hint", t("git.branch.occupied")); label.title = branch.worktree; row.append(label); }
          else row.append(button(t("git.branch.create"), () => context.launchBranch(ws.repos[args.repo].path, branch.name, branch.remote ? undefined : branch.name)));
          if (branch.remote) row.append(h("span", "git-badge", t("git.branch.remote")));
          list.append(row);
        }
        if (!list.children.length) list.append(h("div", "none", t("git.branch.none")));
      };
      search.oninput = render; render();
      box.append(search, list, button(t("git.branch.new"), () => context.launchBranch(ws.repos[args.repo].path, repo.branch ?? "HEAD")), h("p", "git-hint", t("git.branch.hint")));
      host.replaceChildren(box); editorSignature = `${ws.id}/${view.repo}/branches`; return;
    }
    if (mode === "history") {
      const history = await invoke<GitCommit[]>("workspace_git_history", args); if (!valid()) return;
      const signature = JSON.stringify([args, mode, history]); if (signature === editorSignature) return;
      heading(t("git.history")); const box = h("div", "git-page");
      box.append(h("p", "git-hint", `${repo.branch ?? t("git.detached")} · ${t("git.history.limit")}`));
      for (const commit of history) {
        const row = button("", () => { view.reference = commit.oid; show("commit"); }, false, "git-history-row");
        const description = h("div", ""); description.append(h("strong", "", commit.subject), h("small", "", `${commit.oid.slice(0,7)} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`));
        row.append(h("span", "git-history-node"), description, h("span", "spacer"));
        if (commit.outgoing) row.append(h("span", "git-badge", t("git.outgoing")));
        box.append(row);
      }
      if (!history.length) box.append(h("div", "none", t("git.history.empty")));
      host.replaceChildren(box); editorSignature = signature; return;
    }
    if (mode === "compare" || mode === "commit") {
      heading(mode === "compare" ? t("git.compare") : t("git.saved"));
      if (mode === "compare") {
        const base = h("input", "git-base") as HTMLInputElement; base.value = view.reference || repo.base; base.setAttribute("aria-label", t("git.base"));
        const apply = () => { view.reference = base.value; base.blur(); editorSignature = ""; void drawEditor(); };
        base.onkeydown = e => { if (e.key === "Enter") apply(); };
        $("dcrumb").append(base, button(t("git.compare"), apply));
      }
      if (!repo.has_head) { host.replaceChildren(h("div", "none", t("git.history.empty"))); return; }
      const result = await invoke<GitDiff>("workspace_git_diff", { ...args, scope: mode, path: null, reference: view.reference || null }); if (!valid()) return;
      const signature = JSON.stringify([args, mode, view.reference, result]);
      const caption = mode === "compare" ? t("git.compare.scope", { base: view.reference || repo.base }) : `${t("git.saved")} · ${result.head.slice(0, 7)}`;
      $("dcrumb").title = caption;
      const summary = h("div", "git-review-scope", caption);
      const list = h("div", "git-review-list dlist");
      if (signature !== editorSignature) {
        host.replaceChildren(summary, list); diff.invalidate(); editorSignature = signature;
      }
      const target = host.querySelector<HTMLElement>(".git-review-list")!;
      review = [{ name: repo.name, base: view.reference, ahead: 0, unpushed: repo.ahead, dirty: 0, files: result.files }];
      diff.render(target, { id: ws.id, repos: review, empty: t("git.compare.empty"), onSeen: () => {}, onOpen: context.openFile });
      $("dseen").hidden = false; $("dfold").hidden = false; return;
    }
    if (mode === "conflict" && view.selection?.scope === "conflict") {
      const selected = view.selection;
      const signature = `${ws.id}/${view.repo}/conflict/${selected.path}`;
      if (signature === editorSignature) return;
      const result = await invoke<GitConflict>("workspace_git_conflict", { ...args, path: selected.path }); if (!valid()) return;
      const draftKey = `${args.repo}/${selected.path}`;
      let draft = view.conflicts.get(draftKey);
      if (!draft) { draft = { source: result, text: result.current }; view.conflicts.set(draftKey, draft); }
      const saved = draft;
      heading(`${t("git.conflicts")} · ${selected.path}`);
      const box = h("div", "git-page"), sides = h("div", "git-conflict-sides");
      const input = h("textarea", "git-conflict-result") as HTMLTextAreaElement;
      input.value = saved.text; input.oninput = () => { saved.text = input.value; }; input.setAttribute("aria-label", t("git.conflict.result")); input.spellcheck = false;
      for (const [text, key] of [[saved.source.ours, "ours"], [saved.source.theirs, "theirs"]] as const) {
        const side = h("section", "git-conflict-side");
        side.append(h("h4", "", t(key === "ours" ? "git.conflict.current" : "git.conflict.incoming", { branch: repo.branch ?? "HEAD" })), h("pre", "", text ?? t("git.conflict.deleted")), button(t(`git.conflict.${key}`), () => { input.value = text!; saved.text = text!; }, text === null)); sides.append(side);
      }
      const resolve = button(t("git.conflict.resolve"), () => {
        if (busy || context.workspace()?.id !== args.id || state().repo !== args.repo || current()?.error) return; busy = true; resolve.disabled = true; drawSidebar();
        void invoke("workspace_git_resolve", { ...args, path: selected.path, was: saved.source.current, text: input.value }).then(() => {
          view.conflicts.delete(draftKey);
          if (context.workspace()?.id === ws.id && state().repo === args.repo) { view.mode = "changes"; view.selection = { scope: "staged", path: selected.path }; editorSignature = ""; }
        }).catch(error => context.say(fromBack(error), true)).finally(async () => { busy = false; resolve.disabled = false; await context.refresh(); });
      }, busy, "pri");
      if (saved.source.current !== result.current) {
        box.append(h("p", "git-error", t("err.git.changed")), button(t("git.conflict.refresh"), () => { saved.source = result; editorSignature = ""; void drawEditor(); }));
      }
      box.append(sides, h("label", "git-hint", t("git.conflict.result")), input, resolve, button(t("git.conflict.manual"), () => void act("stage", [selected.path]), busy), h("p", "git-hint", t("git.conflict.hint")));
      host.replaceChildren(box); editorSignature = signature; return;
    }
    heading(t("git.changes"));
    if (!view.selection && repo.conflicts.length) {
      view.selection = { path: repo.conflicts[0].path, scope: "conflict" }; view.mode = "conflict";
      drawSidebar(); return void drawEditor();
    }
    if (!repo.staged.length && !repo.changes.length) {
      host.replaceChildren(h("div", "git-clean", t("git.clean")), h("p", "git-clean-hint", t("git.clean.hint"))); editorSignature = ""; return;
    }
    // O stage e o local são dois diffs diferentes do mesmo arquivo, então a
    // tela mostra um escopo por vez — o do arquivo escolhido na lista.
    const scope = view.selection?.scope === "staged" || !repo.changes.length ? "staged" : "changes";
    const group = scope === "staged" ? repo.staged : repo.changes;
    const result = await invoke<GitDiff>("workspace_git_diff", { ...args, scope, path: null, reference: null }); if (!valid()) return;
    const signature = JSON.stringify([args, scope, result]);
    $("dcrumb").append(h("span", "git-review-scope git-scope-badge", t(scope === "staged" ? "git.scope.staged" : "git.scope.changes")));
    $("dcrumb").append(button(t(scope === "staged" ? "git.unstageAll" : "git.stageAll"), () => void act(scope === "staged" ? "unstage" : "stage", group.map(file => file.path)), busy || !!repo.error || !group.length));
    if (signature !== editorSignature) {
      host.replaceChildren(h("div", "git-review-list dlist")); diff.invalidate(); editorSignature = signature;
    }
    review = [{ name: repo.name, base: "", ahead: 0, unpushed: repo.ahead, dirty: 0, files: result.files }];
    const focus = pendingFocus; pendingFocus = "";
    diff.render(host.querySelector<HTMLElement>(".git-review-list")!, {
      id: ws.id, repos: review, focus: focus ? diff.key(repo.name, focus) : undefined,
      empty: t("git.empty"), onSeen: () => {}, onOpen: context.openFile,
    });
    $("dseen").hidden = false; $("dfold").hidden = false;
  } catch (error) {
    if (!valid()) return;
    editorSignature = "";
    if (mode !== "compare") heading(t(mode === "conflict" ? "git.conflicts" : "git.changes"));
    host.replaceChildren(h("div", "git-error", fromBack(error)));
    if (mode === "conflict" && view.selection) {
      const path = view.selection.path;
      host.append(button(t("git.openFile"), () => context.openFile(repo.name, path)), button(t("git.conflict.manual"), () => void act("stage", [path]), busy));
    }
  }
}
