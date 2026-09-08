#!/bin/sh
# Check the self-hosted runner registered from this Mac at ~/actions-runner-prometeu.
# It runs as a launchd login service. Start it when offline so PR and release jobs do not sit queued.
#
# sh scripts/runner.sh         Check online status, then start and wait if needed.
# sh scripts/runner.sh status  Report status without starting the service.
# sh scripts/runner.sh stop    Stop until the next login or explicit start.
#
# Queued GitHub jobs time out after 24 hours. The idle runner uses roughly 60 MB and no CPU.
# Builds run locally when jobs arrive. Before starting, require a private repository and disabled fork PR
# workflows.
# PR jobs execute branch-controlled code, so preserve that trust boundary.
set -eu

REPO=gbrancaglione/prometeu
DIR=$HOME/actions-runner-prometeu

status() { gh api "repos/$REPO/actions/runners" --jq '.runners[] | "\(.name): \(.status)\(if .busy then ", ocupado" else "" end)"'; }
online() { status 2>/dev/null | grep -q ": online"; }
guard_pr_boundary() {
  private=$(gh api "repos/$REPO" --jq '.private')
  forks=$(gh api "repos/$REPO/actions/permissions/fork-pr-workflows-private-repos" \
    --jq '.run_workflows_from_fork_pull_requests')
  if [ "$private" != true ] || [ "$forks" != false ]; then
    echo "runner recusado — mantenha o repositório privado e workflows de forks desativados" >&2
    exit 1
  fi
}

case "${1:-up}" in
  status)
    status || echo "nenhum runner registrado em $REPO" ;;
  stop)
    cd "$DIR" && ./svc.sh stop ;;
  up)
    guard_pr_boundary
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
