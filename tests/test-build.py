#!/usr/bin/env python3
"""Synthetic deterministic build checks; no browser profile is opened."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("craig_zone_chromium_build", ROOT.parent / "scripts/build.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class ChromiumBuildTest(unittest.TestCase):
    def test_manifest_shim_assets_and_reproducibility(self):
        with tempfile.TemporaryDirectory(prefix="craig-zone-synthetic-") as tmp:
            root = Path(tmp)
            first, second = root / "one", root / "two"
            one = BUILD.build(first, "c3ludGhldGljLWtleQ==")
            two = BUILD.build(second, "c3ludGhldGljLWtleQ==")
            self.assertEqual(one, two)
            with self.assertRaises(FileExistsError):
                BUILD.build(first)
            manifest = json.loads((first / "manifest.json").read_text())
            self.assertEqual(manifest["manifest_version"], 3)
            self.assertEqual(manifest["version"], "0.3.2")
            self.assertNotIn("nativeMessaging", manifest["permissions"])
            self.assertIn("webNavigation", manifest["permissions"])
            self.assertNotIn("webNavigation", manifest.get("optional_permissions", []))
            self.assertNotIn("host_permissions", manifest)
            self.assertEqual(manifest["minimum_chrome_version"], "127")
            self.assertEqual(manifest["background"], {"service_worker": "service-worker.js"})
            self.assertEqual(manifest["key"], "c3ludGhldGljLWtleQ==")
            suggested = [command for command in manifest["commands"].values() if "suggested_key" in command]
            self.assertEqual(len(suggested), 4)
            self.assertIn("compat.js", (first / "service-worker.js").read_text())
            self.assertIn('files: ["compat.js", "content.js"]', (first / "background.js").read_text())
            self.assertEqual((first / "background.js").read_text().count('files: ["compat.js", "content.js"]'), 4)
            generated_background = (first / "background.js").read_text()
            self.assertEqual(generated_background.count("isTrustedPopupSender(sender)"), 4)
            self.assertNotIn("sender.tab || !sender.url?.startsWith(extensionUrl)", generated_background)
            self.assertNotIn("extensionUrl", generated_background)
            self.assertIn('diagnostics.failure("fullscreen"));\n    }, 24);', generated_background)
            self.assertTrue((first / "icons/craig-zone-128.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertIn("Chromium may ask", (first / "popup.html").read_text())
            self.assertNotIn("Firefox", (first / "popup.js").read_text())
            self.assertNotIn("Firefox", (first / "background.js").read_text())
            empty = root / "empty"
            empty.mkdir()
            BUILD.build(empty, native_diagnostics=True)
            self.assertIn("nativeMessaging", json.loads((empty / "manifest.json").read_text())["permissions"])


if __name__ == "__main__":
    unittest.main()
