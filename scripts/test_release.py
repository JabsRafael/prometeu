"""Release regressions with local files and a fake gh; never access GitHub."""

import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("verify_release", SCRIPTS / "verify-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
ASSETS = ["Prometeu_aarch64.dmg", "latest.json"] + [
    name + suffix for name in release.PACKAGES.values() for suffix in ("", ".sig")
]


class ReleaseTests(unittest.TestCase):
    def test_manifest_preserves_macos_and_checks_linux_signatures(self):
        signature = base64.b64encode(b"test signature").decode()
        manifest = {"version": "0.14.0", "platforms": {
            platform: {
                "url": f"https://github.com/prometeucorp/prometeu/releases/download/v0.14.0/{name}",
                "signature": signature,
            } for platform, name in release.PACKAGES.items()
        }}
        manifest["platforms"]["darwin-aarch64-app"] = copy.deepcopy(manifest["platforms"]["darwin-aarch64"])
        manifest["platforms"]["linux-x86_64-appimage"] = copy.deepcopy(manifest["platforms"]["linux-x86_64"])
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ASSETS:
                (directory / name).write_text(signature if name.endswith(".sig") else "package")

            def verify(value):
                (directory / "latest.json").write_text(json.dumps(value))
                release.verify("0.14.0", "prometeucorp/prometeu", directory, base64.b64encode(b"key").decode())

            with patch.object(release.subprocess, "run") as minisign:
                verify(manifest)
                self.assertEqual(minisign.call_count, 4)
                self.assertEqual(
                    {Path(call.args[0][3]).name for call in minisign.call_args_list},
                    set(release.PACKAGES.values()),
                )
                self.assertTrue(all(call.kwargs["check"] for call in minisign.call_args_list))

                mutations = [
                    lambda m: m.update(version="0.13.0"),
                    lambda m: m["platforms"].pop("linux-x86_64"),
                    lambda m: m["platforms"]["linux-x86_64"].update(url=m["platforms"]["darwin-aarch64"]["url"]),
                    lambda m: m["platforms"]["linux-x86_64-appimage"].update(url="https://example.com/package"),
                    lambda m: m["platforms"]["darwin-aarch64"].update(signature="different"),
                ]
                for mutate in mutations:
                    invalid = copy.deepcopy(manifest)
                    mutate(invalid)
                    with self.assertRaises(ValueError):
                        verify(invalid)
                for name in ASSETS:
                    if name == "latest.json":
                        continue
                    original = (directory / name).read_text()
                    (directory / name).unlink()
                    with self.subTest(missing=name), self.assertRaises((ValueError, FileNotFoundError)):
                        verify(manifest)
                    (directory / name).write_text(original)

                minisign.side_effect = subprocess.CalledProcessError(1, "minisign")
                with self.assertRaises(subprocess.CalledProcessError):
                    verify(manifest)

    def test_publish_requires_both_platforms_and_successful_workflow(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "scripts").mkdir()
            shutil.copy(SCRIPTS / "release.sh", directory / "scripts/release.sh")
            gh = directory / "gh"
            gh.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
from pathlib import Path
args = sys.argv[1:]
if args[:2] == ["release", "view"]:
    print("true" if "isDraft" in args else os.environ["TEST_ASSETS"])
elif args[:2] == ["run", "list"]:
    print(os.environ["TEST_CONCLUSION"])
elif args[:2] == ["release", "edit"]:
    Path(os.environ["TEST_PUBLISHED"]).write_text(json.dumps(args))
else:
    sys.exit("Unexpected gh call: " + repr(args))
''')
            gh.chmod(0o755)
            published = directory / "published"
            cases = [(set(ASSETS) - {name}, "success", False) for name in ASSETS]
            cases += [(set(ASSETS), "failure", False), (set(ASSETS), "success", True)]
            for assets, conclusion, allowed in cases:
                with self.subTest(assets=assets, conclusion=conclusion):
                    result = subprocess.run(
                        ["sh", str(directory / "scripts/release.sh"), "publish", "0.14.0"],
                        env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                             "TEST_ASSETS": "\n".join(sorted(assets)), "TEST_CONCLUSION": conclusion,
                             "TEST_PUBLISHED": str(published)},
                        capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode == 0, allowed, result.stderr)
                    self.assertEqual(published.exists(), allowed)
            self.assertEqual(json.loads(published.read_text()), [
                "release", "edit", "v0.14.0", "-R", "prometeucorp/prometeu", "--draft=false", "--latest",
            ])


if __name__ == "__main__":
    unittest.main()
