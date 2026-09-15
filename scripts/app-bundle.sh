#!/bin/sh
# Build this worktree's app as a debug .app and open it through LaunchServices.
# macOS TCC reads NSMicrophoneUsageDescription and NSSpeechRecognitionUsageDescription only from
# a bundle the app launched itself, so dictation cannot be tested under `tauri dev`. Updater
# artifacts stay off: they need the release signing key.
set -eu
cd "$(dirname "$0")/.."

NAME=${PROMETEU_WORKSPACE_NAME:-}
ROOT=${PROMETEU_ROOT:-"$HOME/.prometeu-dev${NAME:+-$NAME}"}

echo "Prometeu debug bundle · raiz em $ROOT"

npx tauri build --debug --bundles app \
  --config src-tauri/tauri.dev.conf.json \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'

exec open -W --env PROMETEU_ROOT="$ROOT" "src-tauri/target/debug/bundle/macos/Prometeu Dev.app"
