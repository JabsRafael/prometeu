#!/bin/sh
# O prometheus-hook precisa viajar dentro do .app: é ele que o Claude Code
# executa, e o caminho vai escrito no settings.json de cada sessão. O Tauri só
# empacota o binário principal, então o hook entra como "sidecar" — e sidecar
# exige o nome terminando no target triple.
#
# Roda antes do cargo, tanto no dev quanto no build, porque o build script do
# Tauri recusa a compilação se o arquivo do sidecar não existir.
set -eu
cd "$(dirname "$0")/.."

TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
HOOK=src-tauri/hook/Cargo.toml

# Debug para o `tauri dev`, que procura o hook ao lado do executável em
# target/debug; release para o que vai dentro do bundle.
cargo build --quiet --manifest-path "$HOOK"
cargo build --quiet --release --manifest-path "$HOOK"

mkdir -p src-tauri/binaries
cp src-tauri/target/release/prometheus-hook "src-tauri/binaries/prometheus-hook-$TRIPLE"
echo "sidecar pronto: prometheus-hook-$TRIPLE"
