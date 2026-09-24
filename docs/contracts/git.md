# Workspace Git

Status: implemented. Git runs only on the Mac that owns the workspace.

## Responsibilities

`src/workspace-changes.ts` controls selection, drafts and presentation. The
backend `src-tauri/src/session/git.rs` resolves the repository from the
workspace and runs Git with separate arguments, without a shell. `src/diff.ts`
stacks the scope's files in a single scroll, in a unified or side-by-side diff,
both in Changes and in comparison and commit. Both presentations keep the line
numbers of each side; side by side aligns the blocks of removals and additions
between context lines. The existing viewer is still responsible for full file
editing, reachable through **Open file** or by double-clicking the header.

The panel keeps repository, branch and remote in the header, with pull/push
counters and an action menu. Explicit tabs separate Local files, Stage, History
and Compare. The commit form lives only in Stage; Local files offers an entry to
review the index. History lists commits in the panel and shows the selected one
in the center; Compare keeps the reference editable. The groups preserve their
state when Git is refreshed. The pt-BR labels keep the terms branch, commit and
stage; explanations of the operations live in the tooltips, without repeating
instructions in the list.

Branch, workspace stage and agent status are independent concepts. Selecting a
branch does not switch the checkout of a running session: it opens an existing
workspace or the launcher, with a mandatory worktree. A branch taken in a folder
without a registered workspace shows that location without offering a checkout
on top of it.

## IPC commands

Every command receives `id`, the local workspace identifier. Per-repository
commands also receive `repo`, an index into `Workspace.repos`. The backend
refuses a workspace that was removed, returned, is being prepared or failed.
File paths are relative to the selected repository; absolute paths, traversals,
`.git` and parents that cross symlinks to the outside are refused.

| Command | Additional arguments | Return |
| --- | --- | --- |
| `workspace_git_status` | none | `GitStatus[]` |
| `workspace_git_diff` | `repo`, `scope`, `path?`, `reference?` | `GitDiff` |
| `workspace_git_action` | `repo`, `operation`, `paths`, `message?`, `expected?`, `remote?` | empty or error |
| `workspace_git_history` | `repo` | up to 100 `GitCommit` |
| `workspace_git_branches` | `repo` | `GitBranch[]` |
| `workspace_git_conflict` | `repo`, `path` | current, ours and theirs versions |
| `workspace_git_resolve` | `repo`, `path`, `was`, `text` | empty or error |
| `tree_git_status` | none; `id` may also be a project | `GitFile[]`, never an error |

The TypeScript types are in `src/types.ts`. `src/ipc.ts`, the Tauri registry and
`src/mock.ts` expose the same commands. No new field is persisted in the board;
selection and drafts last while the workspace exists in the window.

### Status and diffs

`GitStatus` contains identity (`repo`, `name`, `branch`, `base`), upstream and
remotes, `ahead`/`behind` counters relative to the upstream, `has_head`,
`merging`, the opaque `index` token, the `staged`/`changes`/`conflicts` groups
and `error`. Each file has `path` and `status`. A partially staged file appears
in both groups, with different comparisons. Renames appear as a deletion and an
addition. The tab counter counts unique local paths per repository.

Status uses the NUL-delimited porcelain format. An error in one repository does
not hide the others; the UI keeps the last known status, shows the error and
disables mutations in that repository. A project may not be a git repository:
the workspace is born without a worktree and without a branch (`list_branches`
answers `git: false`, and the launcher locks both toggles), and the panel shows
the Git error as with any repository that does not answer. Old responses cannot
replace the selection of another workspace or repository.

### File tree marks

`tree_git_status` feeds the colors of the side **Files** tree and, unlike the
other commands, accepts the same `id` as `list_dir`: a workspace or a project
(see [the root of the file commands](ipc.md#root-of-the-file-commands)). Paths
are relative to that tree root, so a grouping folder prefixes each worktree's
folder and a project registered on a subfolder sees only its own changes.
`status` is collapsed to one mark: `U` for conflicts, `A` for untracked or added
files, `D` for deletions and `M` for the rest. Untracked folders are not
expanded and arrive as a single path ending in `/`. A directory outside Git, or
a repository that fails, contributes no marks instead of an error. The tree
refreshes marks every 5 seconds while it is visible, because terminals and
agents change files without board events.

Without an upstream, the counters are zero and the action is **Publish branch**.
That does not mean the commits are published. A detached HEAD is
`branch: null`; reading stays available, but commit, pull and push are blocked.

`GitDiff` contains the resolved `base` and `head` and files in the `Change`
format already used by the review viewer. The scopes are:

- `changes`: the index compared to the worktree, including untracked files;
- `staged`: HEAD compared to the index, including before the first commit;
- `compare`: the merge base of the chosen reference with HEAD, up to HEAD;
- `commit`: the first parent up to the chosen commit; an initial commit uses the
  empty tree.

Branch comparison and history exclude local changes. Empty patches may indicate
a binary file, metadata or the 400,000-byte limit; the UI states that
limitation. The diff shows up to 2,500 lines per file and builds each file's
body as it enters the visible area.

Changes shows one scope at a time — `staged` or `changes`, decided by the chosen
tab even when it is empty — because the same file has two different diffs. Stage
and Unstage do not switch that tab. Clicking a file of the already-displayed
scope scrolls to it and opens its diff if collapsed, without rebuilding the
other patches. The path filter affects the list and the diffs; **Stage
everything** and **Unstage everything** still operate on the whole scope,
including files outside the filter.

**Reviewed** only records the reading: it does not stage or discard content. The
existing mark in localStorage is still associated with the workspace,
repository, path and patch fingerprint. Changes to the patch invalidate the
mark. Progress counts every file of the scope; **Next unreviewed** clears the
filter and opens the next pending file. Layout and filter are ephemeral window
state.

### Mutations

`operation` accepts `stage`, `unstage`, `commit`, `fetch`, `pull`, `push` and
`publish`. Stage operates only on the chosen paths, as literal pathspecs.
Unstage changes the index and preserves the files, including before the first
commit. There is no automatic staging on commit.

Commit requires a message, a branch and a prepared index, or a pending merge
without conflicts. The `expected` token identifies HEAD and the index entries;
changes observed between the read and the operation require a new review. The
read checks the token before and after building the status. Git keeps its own
locks; external operations and hooks are still participants in the repository,
not processes controlled by the UI. The app serializes its mutations and refuses
another operation while one is in progress.

Fetch updates remotes. Pull requires a clean worktree and index, an agent with
no running turn and a fast-forward advance, without rebase or autostash. Push
sends only HEAD to the configured upstream reference. Publish requires a known
remote and configures the branch's upstream. Both actions disable `followTags`,
do not force-push and do not publish other branches or tags. Failures preserve
the draft and the selection; the UI refreshes the status after the result.

### Conflicts

The editor shows text versions without removing whitespace or line breaks. The
draft is kept separate from the current file. Resolving compares `was` with the
text on disk, refuses observed concurrent changes and conflict markers, writes
the result and stages the file. A commit does not happen automatically. Choosing
ours may leave the index equal to HEAD; `merging` allows completing that merge
even without staged files.

Binaries, symlinks and texts above the limit do not go through the merge editor.
They can be resolved with external tools and staged explicitly. Rebase/cherry-pick
and other advanced operations still use external Git; the interface does not
offer a generic action that completes those sequencers.

### Archived worktree cleanup

Archiving and finishing stop workspace processes and run the archive script
before offering cleanup for that workspace. Cleanup remains a separate choice:
canceling keeps the worktree, local branch, transcript and archived card.

The scoped offer uses the same `cleanup_list` and `cleanup_worktree` commands as
the archived-workspaces screen. A safe worktree starts selected. A worktree with
uncommitted changes or an unmerged branch starts unselected, shows the reason,
and requires the person to select it before the destructive confirmation can
run with `force`. Cleanup removes both the worktree and local branch but keeps
the archived card and transcript. Original clones are never eligible.

## Compatibility and evidence

The screen uses the per-repository `workspace_git_*` commands. The unused
`workspace_diff` IPC and its mixed-diff implementation were retired in
[ADR 0043](../decisions/0043-retire-unused-ipc.md). The diff presentation still
uses its existing view model. There is no board, transcript or collaboration
protocol migration.

- `src-tauri/src/session/git_tests.rs`: real Git repositories, partial index,
  special paths, commit, local remotes, conflicts and merge.
- `src/diff.test.ts`: line numbering on both sides and alignment of
  replacements, additions and deletions between hunks.
- `e2e/git.spec.ts`: representative review and commit flows, filters, layout,
  per-repo drafts and protection against stale UI actions over the mock in
  Chromium; selected review and keyboard/layout scenarios also run in WebKit.
- `e2e/critical-flows.spec.ts`: navigation to the viewer, a large review and
  isolation between repositories.
- `e2e/audit-regressions.spec.ts`: scoped cleanup offers after both archiving
  and finishing, plus dialog lifetime during deletion.
- `src-tauri/tests/mock.rs`: IPC command parity.
