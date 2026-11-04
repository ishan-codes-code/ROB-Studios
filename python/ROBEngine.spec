import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


if sys.platform != "win32":
    raise SystemExit("ROBEngine.spec must be built on Windows; cross-platform output is not supported.")

PYTHON_ROOT = Path(SPECPATH)
genai_datas, genai_binaries, genai_hiddenimports = collect_all("google.genai")
openai_hiddenimports = collect_submodules("openai")

analysis = Analysis(
    [str(PYTHON_ROOT / "desktop_runtime.py")],
    pathex=[str(PYTHON_ROOT)],
    binaries=genai_binaries,
    datas=genai_datas,
    hiddenimports=(
        collect_submodules("ai_commentator")
        + genai_hiddenimports
        + openai_hiddenimports
    ),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(analysis.pure)
executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="ROBEngine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="ROBEngine",
)