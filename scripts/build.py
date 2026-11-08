#!/usr/bin/env python3
"""Build a deterministic, unpacked Chromium MV3 extension from live Firefox sources."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "src"
VERSION = "0.3.0"
SOURCE_FILES = (
    "background.js", "content.css", "content.js", "diagnostics.js",
    "popup.css", "popup.html", "popup.js",
)


def png_icon(path: Path, size: int) -> None:
    scale = size / 64
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            px, py = x / scale, y / scale
            dx, dy = px - 31.5, py - 31.5
            qx, qy = max(abs(dx) - 16, 0), max(abs(dy) - 16, 0)
            rounded = math.hypot(qx, qy) + min(max(abs(dx) - 16, abs(dy) - 16), 0) <= 16
            color = (40, 95, 196, 255) if rounded else (0, 0, 0, 0)
            radius = math.hypot(px - 34, py - 32)
            if rounded and 14 <= radius <= 22 and px > 22:
                color = (255, 255, 255, 255)
            if rounded and 35 <= px <= 49 and ((21 <= py <= 28) or (36 <= py <= 43)):
                color = (207, 224, 255, 255)
            pixels.extend(color)
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)
    raw = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(pixels), 9)) + chunk(b"IEND", b"")
    path.write_bytes(raw)


def build(destination: Path, extension_key: str | None = None, native_diagnostics: bool = False) -> dict[str, str]:
    manifest = json.loads((SOURCE / "manifest.json").read_text())
    manifest.pop("browser_specific_settings", None)
    manifest["version"] = VERSION
    # Frame inspection is essential to Start and fullscreen verification. Chromium
    # must expose this namespace when it creates the popup and worker contexts.
    manifest["permissions"] = ["activeTab", "tabs", "scripting", "storage", "webNavigation"]
    if native_diagnostics:
        manifest["permissions"].append("nativeMessaging")
    manifest.pop("optional_permissions", None)
    manifest["optional_host_permissions"] = ["http://*/*", "https://*/*"]
    manifest["minimum_chrome_version"] = "127"
    manifest["background"] = {"service_worker": "service-worker.js"}
    manifest["action"] = {"default_title": "Craig Zone", "default_popup": "popup.html", "default_icon": "icons/craig-zone.png"}
    # Chromium accepts at most four suggested keyboard shortcuts.
    manifest["commands"]["open-controls"].pop("suggested_key", None)
    manifest["commands"]["next"]["suggested_key"] = {"default": "Alt+Shift+Right"}
    manifest["commands"]["previous"]["suggested_key"] = {"default": "Alt+Shift+Left"}
    manifest["commands"]["last"]["suggested_key"] = {"default": "Alt+Shift+B"}
    manifest["commands"]["toggle"]["suggested_key"] = {"default": "Alt+Shift+Z"}
    if extension_key:
        manifest["key"] = extension_key

    if destination.exists() and any(destination.iterdir()):
        raise FileExistsError(f"Refusing to replace a non-empty build destination: {destination}")
    destination.mkdir(parents=True, exist_ok=True)
    for relative_name in SOURCE_FILES:
        path = SOURCE / relative_name
        if not path.is_file():
            raise FileNotFoundError(f"Required extension source is missing: {path}")
        relative = Path(relative_name)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    compat = (SOURCE / "chromium/compat.js").read_text()
    (destination / "compat.js").write_text(compat)
    (destination / "service-worker.js").write_text('importScripts("compat.js", "diagnostics.js", "background.js");\n')
    background = (destination / "background.js").read_text()
    content_injection = 'files: ["content.js"]'
    sender_guard = 'if (sender.tab || !sender.url?.startsWith(extensionUrl)) return undefined;'
    extension_url_declaration = '      const extensionUrl = browser.runtime.getURL("");\n'
    if background.count(content_injection) != 4:
        raise RuntimeError("Expected four content-script injection sites; review the generator for source changes")
    if background.count(sender_guard) != 4:
        raise RuntimeError("Expected four popup authorization guards; review the generator for source changes")
    if background.count(extension_url_declaration) != 4:
        raise RuntimeError("Expected four popup URL declarations; review the generator for source changes")
    candidate_flush = 'enqueue(() => runFullscreenTransaction(tabId, candidates)).catch(() => diagnostics.failure("fullscreen"));\n    }, 0);'
    if background.count(candidate_flush) != 1:
        raise RuntimeError("Expected the fullscreen candidate batching timer; review the generator for source changes")
    background = background.replace(content_injection, 'files: ["compat.js", "content.js"]')
    background = background.replace(sender_guard, 'if (!globalThis.CraigZoneChromium.isTrustedPopupSender(sender)) return undefined;')
    background = background.replace(extension_url_declaration, "")
    background = background.replace(candidate_flush, 'enqueue(() => runFullscreenTransaction(tabId, candidates)).catch(() => diagnostics.failure("fullscreen"));\n    }, 24);')
    old_toggle = '''    if (command === "toggle") {
      if (session) enqueue(async () => { await ensureReady(); return stopSession(); }).catch(() => diagnostics.failure("stop"));
      else browser.action.openPopup().catch(() => {});
      return;
    }'''
    new_toggle = '''    if (command === "toggle") {
      enqueue(async () => {
        await ensureReady();
        if (session) {
          try { return await stopSession(); }
          catch (_) { diagnostics.failure("stop"); return; }
        }
        return browser.action.openPopup().catch(() => {});
      }).catch(() => {});
      return;
    }'''
    if old_toggle not in background:
        raise RuntimeError("Could not patch the toggle command for MV3 service-worker restarts")
    background = background.replace(old_toggle, new_toggle)
    (destination / "background.js").write_text(background)
    html = (destination / "popup.html").read_text().replace('<script src="popup.js"></script>', '<script src="compat.js"></script>\n  <script src="popup.js"></script>')
    html = html.replace("Firefox", "Chromium")
    (destination / "popup.html").write_text(html)
    popup = (destination / "popup.js").read_text()
    popup = popup.replace("Firefox", "Chromium")
    (destination / "popup.js").write_text(popup)
    background = (destination / "background.js").read_text().replace("Firefox", "Chromium")
    (destination / "background.js").write_text(background)
    for key in ("16", "32", "48", "128"):
        icon = destination / "icons" / f"craig-zone-{key}.png"
        icon.parent.mkdir(parents=True, exist_ok=True)
        png_icon(icon, int(key))
    manifest["action"]["default_icon"] = {"16": "icons/craig-zone-16.png", "32": "icons/craig-zone-32.png", "48": "icons/craig-zone-48.png", "128": "icons/craig-zone-128.png"}
    manifest["icons"] = manifest["action"]["default_icon"]
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    hashes = {path.relative_to(destination).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(destination.rglob("*")) if path.is_file()}
    return hashes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--key", help="Stable base64 DER public key for a fixed Chromium extension ID")
    parser.add_argument("--native-diagnostics", action="store_true", help="Enable the separately installed local native mirror")
    args = parser.parse_args()
    print(json.dumps(build(args.destination.resolve(), args.key, args.native_diagnostics), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
