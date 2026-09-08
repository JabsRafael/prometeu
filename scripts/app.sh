#!/bin/sh
# Start this worktree's development app independently of other running worktrees.
# Separate Vite ports avoid strictPort conflicts; separate PROMETEU_ROOT paths avoid sharing board state
# and worktrees.
# Workspace scripts supply PROMETEU_PORT and PROMETEU_WORKSPACE_NAME. Terminal launches retain the
# default port and development root.
set -eu
cd "$(dirname "$0")/.."

PORT=${PROMETEU_PORT:-1420}
NAME=${PROMETEU_WORKSPACE_NAME:-}
ROOT=${PROMETEU_ROOT:-"$HOME/.prometeu-dev${NAME:+-$NAME}"}

export PORT
export PROMETEU_ROOT="$ROOT"

echo "Prometeu dev · vite em $PORT · raiz em $ROOT"

# The second --config merges a JSON patch over the first, replacing the devUrl port.
exec npx tauri dev \
  --config src-tauri/tauri.dev.conf.json \
  --config "{\"build\":{\"devUrl\":\"http://localhost:$PORT\"}}"
