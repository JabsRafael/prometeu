"""Verify the draft's updater packages against the public key embedded in the app."""

import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


PACKAGES = {
    "darwin-aarch64": "Prometeu_aarch64.app.tar.gz",
    "linux-x86_64": "Prometeu_x86_64.AppImage",
}


def verify(version, repo, directory, public_key, expected_notes):
    directory = Path(directory)
    manifest = json.loads((directory / "latest.json").read_text())
    if manifest["version"] != version:
        raise ValueError("latest.json version does not match the tag")
    notes = manifest.get("notes")
    if not expected_notes.strip() or not isinstance(notes, str) or notes.strip() != expected_notes.strip():
        raise ValueError("latest.json notes do not match the changelog section")
    platforms = manifest["platforms"]
    if not PACKAGES.keys() <= platforms.keys():
        raise ValueError("latest.json must include macOS and Linux")
    if not (directory / "Prometeu_aarch64.dmg").is_file():
        raise ValueError("Missing Prometeu_aarch64.dmg")

    # New Tauri clients may select installer-specific entries; validate those as well.
    packages = {
        **PACKAGES,
        "darwin-aarch64-app": PACKAGES["darwin-aarch64"],
        "linux-x86_64-appimage": PACKAGES["linux-x86_64"],
    }
    with tempfile.TemporaryDirectory() as temporary:
        key = Path(temporary) / "public.key"
        signature = Path(temporary) / "package.minisig"
        key.write_bytes(base64.b64decode(public_key, validate=True))
        for platform, entry in platforms.items():
            name = packages[platform]
            expected = f"https://github.com/{repo}/releases/download/v{version}/{name}"
            if entry["url"] != expected:
                raise ValueError(f"Unexpected package URL for {platform}: {entry['url']}")
            package = directory / name
            if not package.is_file():
                raise ValueError(f"Missing {name}")
            if (directory / f"{name}.sig").read_text().strip() != entry["signature"].strip():
                raise ValueError(f"Signature does not match latest.json for {platform}")
            signature.write_bytes(base64.b64decode(entry["signature"].strip(), validate=True))
            subprocess.run(
                ["minisign", "-V", "-m", str(package), "-p", str(key), "-x", str(signature)],
                check=True,
            )


if __name__ == "__main__":
    version, repo, directory = sys.argv[1:]
    config = json.loads(Path("src-tauri/tauri.conf.json").read_text())
    verify(version, repo, directory, config["plugins"]["updater"]["pubkey"], os.environ["RELEASE_NOTES"])
