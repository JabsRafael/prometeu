#!/bin/sh
# O runner self-hosted do CI é este Mac: ~/actions-runner, de pé como serviço
# de login (launchd), registrado no repositório. Este script confere se o
# GitHub o vê online e, se não, sobe o serviço — para ninguém empurrar tag ou
# abrir PR e ficar com o job na fila sem perceber (a fila espera 24h e falha).
#
#   sh scripts/runner.sh           online? senão sobe e espera
#   sh scripts/runner.sh status    só diz
#   sh scripts/runner.sh stop      para o serviço; volta no próximo login ou
#                                  no próximo `sh scripts/runner.sh`
#
# Parado, o runner é um processo ocioso (~60 MB, CPU zero). O custo de verdade
# é o cargo build rodando aqui quando há push — e é o mesmo build que rodaria
# de qualquer jeito.
set -eu

REPO=gbrancaglione/prometheus
DIR=$HOME/actions-runner

status() { gh api "repos/$REPO/actions/runners" --jq '.runners[] | "\(.name): \(.status)\(if .busy then ", ocupado" else "" end)"'; }
online() { status 2>/dev/null | grep -q ": online"; }

case "${1:-up}" in
  status)
    status || echo "nenhum runner registrado em $REPO" ;;
  stop)
    cd "$DIR" && ./svc.sh stop ;;
  up)
    if online; then status; exit 0; fi
    [ -d "$DIR" ] || { echo "não há runner em $DIR — ver o cabeçalho de .github/workflows/ci.yml" >&2; exit 1; }
    echo "runner offline — subindo o serviço"
    (cd "$DIR" && ./svc.sh start >/dev/null)
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      if online; then status; exit 0; fi
      sleep 5
    done
    echo "o runner não ficou online em um minuto — veja $DIR/_diag" >&2
    exit 1 ;;
  *)
    sed -n '2,10p' "$0"; exit 1 ;;
esac
