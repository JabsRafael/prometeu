import {
  invoke as tauriInvoke,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";

/**
 * Commands exposed by the Rust backend and currently consumed by the frontend.
 * Keeping the boundary here makes misspelled or stale command names a type error.
 */
export const IPC_COMMANDS = [
  "add_project",
  "agents",
  "archive_workspace",
  "browser_bounds",
  "browser_close",
  "browser_hide",
  "browser_navigate",
  "browser_open",
  "browser_reload",
  "browser_url",
  "chat_buffer",
  "chat_control",
  "chat_control_remote",
  "chat_send",
  "chat_snapshot",
  "cleanup_list",
  "cleanup_worktree",
  "close_dock",
  "close_tab",
  "create_scripts_file",
  "create_workspace",
  "dock_state",
  "find_paths",
  "finish_workspace",
  "focus_tab",
  "linear_connect",
  "linear_disconnect",
  "linear_issues",
  "linear_open",
  "linear_status",
  "list_branches",
  "list_dir",
  "load_board",
  "look_at",
  "new_tab",
  "open_dock",
  "open_external",
  "open_pr",
  "open_run",
  "pin_workspace",
  "pr_open",
  "pr_prompt",
  "pty_buffer",
  "pty_resize",
  "pty_write",
  "read_file",
  "refresh_prs",
  "remove_workspace",
  "rename_tab",
  "rename_workspace",
  "reveal",
  "scripts_prompt",
  "set_lang",
  "set_shared",
  "set_stage",
  "set_unread",
  "team_config",
  "team_config_set",
  "workspace_branch",
  "workspace_diff",
  "workspace_scripts",
  "write_file",
] as const;

export type IpcCommand = (typeof IPC_COMMANDS)[number];

export function invoke<T>(
  command: IpcCommand,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  return tauriInvoke<T>(command, args, options);
}
