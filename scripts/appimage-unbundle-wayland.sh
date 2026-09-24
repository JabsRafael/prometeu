#!/usr/bin/env bash
# Removes the libwayland-* copies that linuxdeploy bundles from the build runner and repacks the
# AppImage in place. The host's Mesa must talk to the host's libwayland: with the Ubuntu 22.04 copies
# first on LD_LIBRARY_PATH, WebKitGTK aborts on current Mesa with
# "Could not create default EGL display: EGL_BAD_PARAMETER" and the window stays black.
# tauri-bundler has no exclude-library setting, so the artifact is patched after the build.
# Repacking changes the bytes: sign the AppImage again afterwards.
set -euo pipefail

APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
# Pinned too: without --runtime-file, appimagetool downloads the runtime's continuous build.
RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64"
RUNTIME_SHA256="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"

appimage="$(realpath "${1:?usage: $0 path/to/App.AppImage}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

curl -fsSL -o appimagetool "$APPIMAGETOOL_URL"
curl -fsSL -o runtime "$RUNTIME_URL"
printf '%s  appimagetool\n%s  runtime\n' "$APPIMAGETOOL_SHA256" "$RUNTIME_SHA256" | sha256sum -c --quiet
chmod +x appimagetool "$appimage"

"$appimage" --appimage-extract >/dev/null
removed="$(find squashfs-root -name 'libwayland-*.so*' -print -delete)"
[ -n "$removed" ] || echo "no bundled libwayland-* found; repacking anyway"
printf '%s\n' "$removed"

# --appimage-extract-and-run: CI runners have no usable FUSE.
ARCH=x86_64 ./appimagetool --appimage-extract-and-run --no-appstream --runtime-file runtime squashfs-root repacked.AppImage >/dev/null
rm -rf squashfs-root

# Check the file that will ship, so a bundler change fails here instead of reaching users.
chmod +x repacked.AppImage
./repacked.AppImage --appimage-extract >/dev/null
[ -d squashfs-root/usr ] || { echo "repacked AppImage has no usr/"; exit 1; }
if [ -n "$(find squashfs-root -name 'libwayland-*.so*' -print -quit)" ]; then
  echo "repacked AppImage still bundles libwayland-*"
  exit 1
fi

mv repacked.AppImage "$appimage"
