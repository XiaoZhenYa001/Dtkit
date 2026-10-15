"""Compatibility entry point for the real Windows desktop-space native smoke.

Run: python tests/desktop-presentation-native-smoke.py --exe src-tauri/target/debug/DtKit.exe

Desktop space now belongs to Explorer rather than the classic organizer window.
Keep the existing test command useful by forwarding it to the current native
hosting, mode exclusivity, transparent hit region and lifecycle verification.
Build with tests/native-webview.config.json; production storage is rejected.
"""

from pathlib import Path
import runpy


if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('desktop-space-native-smoke.py')), run_name='__main__')