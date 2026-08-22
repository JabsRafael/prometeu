#!/bin/sh
# Sobe o app de dev deste worktree, isolado de qualquer outro que esteja de pé.
#
# Três coisas colidem quando dois worktrees rodam `tauri dev` ao mesmo tempo:
#
#   a porta do vite    `strictPort` na 1420, e o segundo simplesmente não sobe
#   ~/.prometheus-dev  o mesmo board.json e os mesmos worktrees para os dois
#   o socket do hook   `socket::listen` apaga o órfão antes do `bind`, então o
#                      último a subir rouba os hooks do primeiro
#
# As três saem do ambiente. `PROMETHEUS_PORT` e `PROMETHEUS_WORKSPACE_NAME` já
# vêm preenchidos quando este script é o `run` do settings.toml — é assim que o
# Prometheus roda o Prometheus. Do terminal, vale o padrão, e nada muda em
# relação a antes.
#
# O hook faz a conta do socket sozinho e chegaria em `~/.prometheus-dev`, que é
# o do vizinho; por isso `PROMETHEUS_SOCKET` vai escrito. O `claude_cmd` repassa
# o ambiente inteiro para a sessão, e a sessão para o hook.
set -eu
cd "$(dirname "$0")/.."

PORT=${PROMETHEUS_PORT:-1420}
NAME=${PROMETHEUS_WORKSPACE_NAME:-}
ROOT=${PROMETHEUS_ROOT:-"$HOME/.prometheus-dev${NAME:+-$NAME}"}

export PORT
export PROMETHEUS_ROOT="$ROOT"
export PROMETHEUS_SOCKET="$ROOT/run/prometheus.sock"

echo "Prometheus dev · vite em $PORT · raiz em $ROOT"

# O `devUrl` do tauri.conf.json tem a porta escrita. O segundo `--config` é um
# patch JSON fundido por cima do primeiro, na ordem em que aparecem.
exec npx tauri dev \
  --config src-tauri/tauri.dev.conf.json \
  --config "{\"build\":{\"devUrl\":\"http://localhost:$PORT\"}}"
