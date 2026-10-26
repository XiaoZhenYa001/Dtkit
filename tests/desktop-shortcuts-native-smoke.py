"""Isolated native regression for partial restoration and atomic shortcut edits.

Run against the native-smoke identifier only. The helper owns one temporary
RegisterHotKey reservation, never injects keys, and restores the exact test
configuration after its child processes have stopped.
"""
import argparse
import ctypes
from ctypes import wintypes
import importlib.util
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('shortcut_native_helpers', ROOT / 'tests/desktop-launcher-native-smoke.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class Scenario:
    def __init__(self):
        self.config = None
        self.backups = {}
        self.keys = []
        self.held = None
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.user.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
        self.user.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]

    def prime(self, main, context, process):
        main = helper.main_page(main, context)
        self.config = helper.check_isolation(main)
        for name in helper.CONFIG_NAMES:
            path = self.config / name
            self.backups[name] = path.read_bytes() if path.exists() else None
        helper.invoke(main, 'set_desktop_organizer_mode', enabled=False, presentation='classic')
        helper.invoke(main, 'replace_shortcut_bindings', bindings=[])

    def reserve(self):
        # Probe only our own uncommon test combinations, then release four for
        # the test app and retain one external conflict for the restoration run.
        reservations = []
        for number in range(24, 12, -1):
            identity = 0x5A00 + number
            if self.user.RegisterHotKey(None, identity, 0x4007, 0x70 + number - 1):
                reservations.append((identity, f'Ctrl+Alt+Shift+F{number}'))
                if len(reservations) == 5:
                    break
        if len(reservations) < 5:
            for identity, _ in reservations:
                self.user.UnregisterHotKey(None, identity)
            raise AssertionError('Could not reserve five isolated test shortcuts')
        self.held, self.conflict = reservations[0]
        self.keys = [key for _, key in reservations[1:]]
        for identity, _ in reservations[1:]:
            assert self.user.UnregisterHotKey(None, identity)

    def seed(self):
        assert self.config.name == 'Config' and self.config.parent.name == helper.IDENTIFIER
        self.original = [
            {'accelerator': self.keys[0], 'target': {'kind': 'tool', 'toolId': 'timestamp-converter'}, 'enabled': True},
            {'accelerator': self.conflict, 'target': {'kind': 'desktopSpace'}, 'enabled': True},
        ]
        (self.config / 'tool-shortcuts.json').write_text(json.dumps(self.original), encoding='utf-8')
        (self.config / 'desktop-organizer-mode.json').write_text(json.dumps({
            'version': 1, 'enabled': True, 'presentation': 'space', 'shortcutInitialized': True
        }), encoding='utf-8')

    def conflict_and_edits(self, main, context, process):
        main = helper.main_page(main, context)
        assert helper.check_isolation(main) == self.config
        statuses = helper.invoke(main, 'get_shortcut_bindings')
        assert len(statuses) == 2, statuses
        tool = next(item for item in statuses if item['target']['kind'] == 'tool')
        space = next(item for item in statuses if item['target']['kind'] == 'desktopSpace')
        assert tool['registered'] is True, statuses
        assert space['registered'] is False and space['registrationError'], statuses
        assert json.loads((self.config / 'tool-shortcuts.json').read_text(encoding='utf-8-sig')) == self.original
        mode = helper.invoke(main, 'get_desktop_organizer_mode')
        assert mode['enabled'] and mode['presentation'] == 'space' and mode['shortcutWarning'], mode

        # Editing an unrelated target must preserve the failed configured key.
        helper.invoke(main, 'upsert_shortcut_binding', binding={
            'accelerator': self.keys[1], 'target': {'kind': 'palette'}, 'enabled': True
        })
        after = helper.invoke(main, 'get_shortcut_bindings')
        assert len(after) == 3
        assert next(item for item in after if item['target']['kind'] == 'desktopSpace')['registered'] is False

        # Both async IPCs enter the native target transaction independently.
        main.evaluate('''edits => Promise.all(edits.map(binding =>
            window.__TAURI__.core.invoke('upsert_shortcut_binding', {binding})))''', [
            {'accelerator': self.keys[2], 'target': {'kind': 'desktopSpace'}, 'enabled': True},
            {'accelerator': self.keys[3], 'target': {'kind': 'palette'}, 'enabled': True},
        ])
        merged = helper.invoke(main, 'get_shortcut_bindings')
        assert len(merged) == 3 and all(item['registered'] for item in merged), merged
        assert next(item for item in merged if item['target']['kind'] == 'tool')['accelerator'] == tool['accelerator']
        assert next(item for item in merged if item['target']['kind'] == 'desktopSpace')['accelerator'].endswith(self.keys[2].split('+')[-1])
        assert next(item for item in merged if item['target']['kind'] == 'palette')['accelerator'].endswith(self.keys[3].split('+')[-1])
        assert 'shortcutWarning' not in helper.invoke(main, 'get_desktop_organizer_mode')
        removed = helper.invoke(main, 'remove_shortcut_binding', target={'kind': 'palette'})
        assert len(removed) == 2 and all(item['registered'] for item in removed)
        assert all(item['target']['kind'] != 'palette' for item in removed)
        saved = json.loads((self.config / 'tool-shortcuts.json').read_text(encoding='utf-8-sig'))
        assert all('registered' not in item and 'registrationError' not in item for item in saved)
        print('PASS: occupied startup key preserved; usable key active; conflict visible; concurrent target edits merged; removal isolated', flush=True)

    def recovered(self, main, context, process):
        main = helper.main_page(main, context)
        assert helper.check_isolation(main) == self.config
        statuses = helper.invoke(main, 'get_shortcut_bindings')
        assert len(statuses) == 2 and all(item['registered'] for item in statuses), statuses
        assert all('registrationError' not in item for item in statuses)
        assert 'shortcutWarning' not in helper.invoke(main, 'get_desktop_organizer_mode')
        print('PASS: original saved shortcuts recover after only the external reservation is released', flush=True)

    def cleanup(self):
        if self.held is not None:
            self.user.UnregisterHotKey(None, self.held)
            self.held = None
        if self.config:
            assert self.config.name == 'Config' and self.config.parent.name == helper.IDENTIFIER
            for name, content in self.backups.items():
                path = self.config / name
                if content is None:
                    if path.exists():
                        path.unlink()
                else:
                    path.write_bytes(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', required=True, type=Path)
    executable = parser.parse_args().exe.resolve(strict=True)
    state = Scenario()
    try:
        with sync_playwright() as playwright:
            helper.native.run_case(playwright, executable, [], state.prime)
            state.reserve()
            state.seed()
            helper.native.run_case(playwright, executable, [], state.conflict_and_edits)
            assert state.user.UnregisterHotKey(None, state.held)
            state.held = None
            state.seed()
            helper.native.run_case(playwright, executable, [], state.recovered)
    finally:
        state.cleanup()
    print('desktop shortcut native transaction smoke passed; test configuration restored', flush=True)


if __name__ == '__main__':
    main()
