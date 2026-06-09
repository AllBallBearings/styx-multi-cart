#!/usr/bin/env python3
"""Patch the synced manifest.json for Safari's WebExtension support.

Safari (WebKit) does not implement chrome.sidePanel, so the toolbar-icon ->
side panel behavior used on Chrome (action with no default_popup +
chrome.sidePanel.setPanelBehavior) leaves Safari users with a dead toolbar
icon. For Safari we fall back to the classic popup: set
action.default_popup back to popup.html (rendered without the
?surface=sidepanel query string, so it uses the normal 380px popup layout)
and drop the side_panel key + sidePanel permission, which Safari ignores but
which would otherwise misrepresent what the extension does on this platform.

Used by scripts/sync-safari-resources.sh after manifest.json is copied into
the Safari Xcode project's Resources folder.
"""
import json
import sys


def patch(path):
    with open(path, encoding="utf-8") as fh:
        manifest = json.load(fh)

    manifest.setdefault("action", {})["default_popup"] = "popup.html"
    manifest.pop("side_panel", None)

    permissions = manifest.get("permissions")
    if permissions and "sidePanel" in permissions:
        manifest["permissions"] = [p for p in permissions if p != "sidePanel"]

    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: patch-safari-manifest.py <manifest.json>")
    patch(sys.argv[1])
    print(f"patched {sys.argv[1]} for Safari (default_popup, removed side_panel)")
