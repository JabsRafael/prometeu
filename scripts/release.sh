#!/bin/sh
# Solta uma versão nova: marca, constrói assinado e publica onde o app procura.
#
#   sh scripts/release.sh 0.1.4
#
# O que sai daqui é o que o Prometheus instalado baixa sozinho. Três peças:
#
#   Prometheus.app.tar.gz      o bundle novo
#   Prometheus.app.tar.gz.sig  a assinatura minisign
#   latest.json                o manifesto que o app consulta ao abrir
#
# A chave privada mora em ~/.tauri/prometheus.key e a senha dela no Keychain —
# nenhuma das duas entra em repositório. Sem elas, o build sai sem assinatura e
# o app instalado recusa a atualização, que é exatamente o que se espera dele.
#
# O código continua no repo privado; só os pacotes vão para o público.
set -eu
cd "$(dirname "$0")/.."

VERSION=${1:-}
[ -n "$VERSION" ] || { echo "uso: sh scripts/release.sh <versão>   (ex.: 0.1.4)" >&2; exit 1; }
REPO=gbrancaglione/prometheus-releases

[ -z "$(git status --porcelain)" ] || { echo "há mudança não commitada — resolva antes de soltar" >&2; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "release sai da main" >&2; exit 1; }

PREV=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

# ---------- marcar ----------

python3 - "$VERSION" <<'PY'
import json, pathlib, re, sys
v = sys.argv[1]

p = pathlib.Path("package.json")
p.write_text(re.sub(r'("version": )"[^"]+"', rf'\1"{v}"', p.read_text(), count=1))

p = pathlib.Path("src-tauri/tauri.conf.json")
c = json.loads(p.read_text()); c["version"] = v
p.write_text(json.dumps(c, indent=2) + "\n")

p = pathlib.Path("src-tauri/Cargo.toml")
p.write_text(re.sub(r'(?m)^version = "[^"]+"', f'version = "{v}"', p.read_text(), count=1))

p = pathlib.Path("src-tauri/Cargo.lock")
p.write_text(re.sub(r'(name = "prometheus"\nversion = )"[^"]+"', rf'\1"{v}"', p.read_text(), count=1))
PY

npm test >/dev/null
git commit -qam "Marcar a versão $VERSION"
git tag -a "v$VERSION" -m "Prometheus $VERSION"

# ---------- construir assinado ----------

TAURI_SIGNING_PRIVATE_KEY=$(cat "$HOME/.tauri/prometheus.key")
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s prometheus-updater -w)
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

npm run build:app

OUT=src-tauri/target/release/bundle
TAR=$OUT/macos/Prometheus.app.tar.gz
DMG=$OUT/dmg/Prometheus_${VERSION}_aarch64.dmg
[ -f "$TAR.sig" ] || { echo "o build saiu sem assinatura — a chave não foi lida" >&2; exit 1; }

# ---------- o manifesto ----------

# As notas são os commits desde a última versão, menos o "Marcar a versão".
NOTES=$(git log --reverse --pretty="- %s" "${PREV:+$PREV..}HEAD^" | grep -v '^- Marcar a versão' || true)
[ -n "$NOTES" ] || NOTES="- ajustes internos"

python3 - "$VERSION" "$TAR.sig" "$REPO" "$NOTES" <<'PY' > "$OUT/latest.json"
import json, subprocess, sys
version, sig, repo, notes = sys.argv[1:5]
date = subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip()
print(json.dumps({
    "version": version,
    "notes": notes,
    "pub_date": date,
    "platforms": {
        "darwin-aarch64": {
            "signature": open(sig).read().strip(),
            "url": f"https://github.com/{repo}/releases/download/v{version}/Prometheus.app.tar.gz",
        }
    },
}, indent=2, ensure_ascii=False))
PY

# ---------- publicar ----------

git push -q origin main
git push -q origin "v$VERSION"

printf '%s\n' "$NOTES" | gh release create "v$VERSION" -R "$REPO" \
  --title "$VERSION" --latest --notes-file - \
  "$TAR" "$TAR.sig" "$OUT/latest.json" "$DMG"

echo
echo "$VERSION no ar. Quem já tem o Prometheus aberto vê o aviso no rodapé em até seis horas,"
echo "e na hora se fechar e abrir de novo."
