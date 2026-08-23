#!/bin/sh
# Solta uma versão nova do Prometheus.
#
#   sh scripts/release.sh              versão calculada dos commits
#   sh scripts/release.sh 0.2.0        versão escolhida à mão
#   sh scripts/release.sh publish      publica a draft que o CI deixou pronta
#
# Daqui sai só o que é decisão de gente: o número, o changelog e a tag. O build
# assinado é do CI (.github/workflows/release.yml), que deixa uma release
# **draft** em gbrancaglione/prometheus-releases. Entre a draft e quem usa o
# app existe uma pessoa: instala o .dmg, abre, confere — e só então `publish`.
# O updater não tem rollback (só instala versão maior que a atual), então
# versão ruim publicada se conserta com a seguinte. Por isso o portão.
#
# As notas saem dos commits: Conventional Commits → git-cliff → CHANGELOG.md →
# corpo da release. Não existe etapa de "escrever as notas"; existe escrever o
# commit direito (ver CLAUDE.md). O número também: feat e fix sobem o patch
# enquanto a versão é 0.x, mudança que quebra sobe o minor (cliff.toml).
#
# A chave de assinatura não passa por aqui. Ela mora em ~/.tauri/prometheus.key
# (senha no Keychain) e, para o CI, nos Secrets do repositório. Perder as duas
# cópias significa nunca mais atualizar quem já instalou — guarde num cofre.
set -eu
cd "$(dirname "$0")/.."

REPO=gbrancaglione/prometheus-releases

die() { echo "$*" >&2; exit 1; }
cliff() { npx --no git-cliff "$@"; }

# ---------- cortar ----------

cut() {
  VERSION=${1:-}

  [ -z "$(git status --porcelain)" ] || die "há mudança não commitada — resolva antes de soltar"
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "release sai da main"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
    || die "a main local não é a origin/main — dê pull (ou push) antes"

  PREV=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo "")
  if [ -n "$PREV" ] && [ "$(git rev-list --count "$PREV..HEAD")" = 0 ]; then
    die "nada desde $PREV — não há o que soltar"
  fi

  [ -n "$VERSION" ] || VERSION=$(cliff --bumped-version | sed 's/^v//')
  case "$VERSION" in
    *.*.*) ;;
    *) die "versão inválida: '$VERSION' (ex.: 0.1.8)" ;;
  esac
  ! git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || die "a tag v$VERSION já existe"

  # Só chore, ci, docs… desde a última tag: não há nada para contar a quem usa,
  # e release sem nota é release que não devia existir. Se a mudança importa,
  # ela merece um fix ou feat no commit.
  NOTES=$(cliff --unreleased --tag "v$VERSION" --strip all)
  printf '%s\n' "$NOTES" | grep -q '^- ' \
    || die "nenhum feat, fix ou perf desde ${PREV:-o começo} — nada para contar na $VERSION"

  echo "== $VERSION  (anterior: ${PREV:-nenhuma})"
  echo
  printf '%s\n' "$NOTES"

  # O npm marca o package.json e o package-lock.json de uma vez; os do Tauri
  # vão à mão, o Cargo.lock inclusive — senão o próximo cargo build o corrige
  # sozinho e suja a árvore de quem só queria rodar o app.
  npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
  python3 - "$VERSION" <<'PY'
import json, pathlib, re, sys
v = sys.argv[1]

p = pathlib.Path("src-tauri/tauri.conf.json")
c = json.loads(p.read_text()); c["version"] = v
p.write_text(json.dumps(c, indent=2) + "\n")

p = pathlib.Path("src-tauri/Cargo.toml")
p.write_text(re.sub(r'(?m)^version = "[^"]+"', f'version = "{v}"', p.read_text(), count=1))

p = pathlib.Path("src-tauri/Cargo.lock")
p.write_text(re.sub(r'(name = "prometheus"\nversion = )"[^"]+"', rf'\1"{v}"', p.read_text(), count=1))
PY

  cliff --unreleased --tag "v$VERSION" --prepend CHANGELOG.md
  cat -s CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

  npm test >/dev/null

  git add -A
  git commit -qm "chore(release): v$VERSION"
  git tag -a "v$VERSION" -m "Prometheus $VERSION" -m "$NOTES"
  git push -q origin main "v$VERSION"

  echo
  echo "v$VERSION empurrada. O CI constrói, assina e deixa uma draft em $REPO."
  watch_run "v$VERSION"
}

# Acompanha o run do release.yml para a tag. Sem `gh run watch`, que redesenha
# a tela: isto roda dentro de sessão do Claude, sem terminal.
watch_run() {
  TAG=$1
  RUN=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    RUN=$(gh run list --workflow=release.yml --branch="$TAG" --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
    [ -n "$RUN" ] && break
    sleep 5
  done
  [ -n "$RUN" ] || { echo "não achei o run do release para $TAG — veja em $(gh repo view --json url -q .url)/actions"; return 0; }

  URL=$(gh run view "$RUN" --json url -q .url)
  echo "acompanhando $URL"
  while :; do
    STATUS=$(gh run view "$RUN" --json status,conclusion -q '.status + " " + (.conclusion // "")')
    case "$STATUS" in
      "completed success")
        echo
        echo "draft pronta: https://github.com/$REPO/releases/tag/$TAG"
        echo "baixe o .dmg, instale, abra e confira. Depois: sh scripts/release.sh publish"
        return 0 ;;
      completed*)
        die "o run terminou como '${STATUS#completed }' — leia o log em $URL antes de qualquer coisa" ;;
    esac
    printf '  %s  %s\n' "$(date +%H:%M:%S)" "$STATUS"
    sleep 30
  done
}

# ---------- publicar ----------

publish() {
  VERSION=${1:-$(node -p "require('./package.json').version")}
  TAG=v$VERSION

  DRAFT=$(gh release view "$TAG" -R "$REPO" --json isDraft -q .isDraft 2>/dev/null) \
    || die "não existe release $TAG em $REPO — o CI terminou?"
  [ "$DRAFT" = true ] || die "$TAG já está publicada"

  ASSETS=$(gh release view "$TAG" -R "$REPO" --json assets -q '.assets[].name')
  for want in "Prometheus_${VERSION}_aarch64.dmg" \
              "Prometheus_${VERSION}_aarch64.app.tar.gz" \
              "Prometheus_${VERSION}_aarch64.app.tar.gz.sig" \
              latest.json; do
    printf '%s\n' "$ASSETS" | grep -qx "$want" || die "falta $want na draft — o CI terminou inteiro?"
  done

  CONCL=$(gh run list --workflow=release.yml --branch="$TAG" --json conclusion -q '.[0].conclusion // "?"')
  [ "$CONCL" = success ] || die "o run do release para $TAG está '$CONCL' — publique só com verde"

  gh release edit "$TAG" -R "$REPO" --draft=false --latest
  echo
  echo "$VERSION no ar. Quem já tem o Prometheus aberto vê o aviso no rodapé em até seis horas,"
  echo "e na hora se fechar e abrir de novo."
}

case "${1:-}" in
  publish) shift; publish "$@" ;;
  -h|--help|help) sed -n '2,6p' "$0"; exit 0 ;;
  *) cut "$@" ;;
esac
