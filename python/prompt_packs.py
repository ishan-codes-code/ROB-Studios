"""Prompt-pack probe: expose the Python factory packs as JSON.

Offline one-shot for the Electron main process (no key, no network):
prints one JSON document with the factory game prompt packs and their
editable-field metadata straight from ``ai_commentator.prompts``. The
renderer must never hardcode its own copy; it receives this document
through IPC instead.

Exit codes: 0 with ``{"ok": true, ...}`` on success, 1 with
``{"ok": false, "error": ...}`` on unexpected failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ai_commentator.prompts import list_factory_packs


def main() -> int:
    try:
        document = list_factory_packs()
    except Exception as exc:  # defensive: never die without a document
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}) + "\n")
        sys.stdout.flush()
        return 1
    sys.stdout.write(json.dumps({"ok": True, **document}) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
