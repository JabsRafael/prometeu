#!/bin/sh
# Sobe o app de dev deste worktree, isolado de qualquer outro que esteja de pé.
#
# Duas coisas colidem quando dois worktrees rodam `tauri dev` ao mesmo tempo:
#
#   a porta do vite    `strictPort` na 1420, e o segundo simplesmente não sobe
#   ~/.prometeu-dev  o mesmo board.json e os mesmos worktrees para os dois
#
# As duas saem do ambiente. `PROMETEU_PORT` e `PROMETEU_WORKSPACE_NAME` já
# vêm preenchidos quando este script é o `run` do settings.toml — é assim que o
# Prometeu roda o Prometeu. Do terminal, vale o padrão, e nada muda em
# relação a antes.
set -eu
cd "$(dirname "$0")/.."

PORT=${PROMETEU_PORT:-1420}
NAME=${PROMETEU_WORKSPACE_NAME:-}
ROOT=${PROMETEU_ROOT:-"$HOME/.prometeu-dev${NAME:+-$NAME}"}

export PORT
export PROMETEU_ROOT="$ROOT"

echo "Prometeu dev · vite em $PORT · raiz em $ROOT"

# O `devUrl` do tauri.conf.json tem a porta escrita. O segundo `--config` é um
# patch JSON fundido por cima do primeiro, na ordem em que aparecem.
exec npx tauri dev \
  --config src-tauri/tauri.dev.conf.json \
  --config "{\"build\":{\"devUrl\":\"http://localhost:$PORT\"}}"
