"""Exercise real desktop-host recovery without restarting Explorer.

Build: npm run build
  npm run tauri build -- --debug --no-bundle --config tests/native-webview.config.json
Run: python tests/desktop-space-recovery-native-smoke.py --exe src-tauri/target/debug/DtKit.exe

The shared runner verifies the isolated native-smoke storage identifier before
either scenario runs. Only a window belonging to the launched test PID is closed,
and only that parent PID is terminated. Its recovery child is deliberately left
alive. No production DtKit process or desktop file is changed. Assertions about
automatic icon recovery run before the final icon/configuration cleanup fallback.
A final standalone-tool scenario verifies that a saved enabled desktop choice
does not start desktop services until the full application is requested.
"""

import argparse
import ctypes
from ctypes import wintypes
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def load_helper(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tests' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helpers = load_helper('recovery_native_helpers', 'native-webview-ui-smoke.py')
desktop_helpers = load_helper('recovery_desktop_helpers', 'desktop-space-native-smoke.py')
DesktopWindows = desktop_helpers.DesktopWindows
invoke = desktop_helpers.invoke
ARTIFACTS = Path(tempfile.mkdtemp(prefix='dtkit-desktop-recovery-'))
INITIAL_ICONS = {}
ISOLATED_STORAGE_ROOT = None
ISOLATED_CONFIG_PATH = None
WM_CLOSE = 0x0010
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258
PROCESS_SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TH32CS_SNAPPROCESS = 0x00000002


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
        ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
        ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
        ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG),
        ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260),
    ]


class RecoveryProcesses:
    """Observe only exact-executable children of the launched test PID."""

    def __init__(self):
        assert os.name == 'nt', 'The recovery smoke test requires Windows'
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        self.kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        self.kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        self.kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    def children(self, process):
        executable = Path(process.args[0]).resolve()
        snapshot = self.kernel.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        assert snapshot not in (None, ctypes.c_void_p(-1).value), ctypes.get_last_error()
        result = []
        try:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(entry)
            available = self.kernel.Process32FirstW(snapshot, ctypes.byref(entry))
            while available:
                if (entry.th32ParentProcessID == process.pid
                        and entry.szExeFile.casefold() == executable.name.casefold()):
                    handle = self.kernel.OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                                                     False, entry.th32ProcessID)
                    assert handle, f'Cannot inspect the test recovery child: {ctypes.get_last_error()}'
                    buffer = ctypes.create_unicode_buffer(32768)
                    length = wintypes.DWORD(len(buffer))
                    try:
                        assert self.kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)), ctypes.get_last_error()
                        assert Path(buffer.value).resolve() == executable, 'Child executable differs from the isolated test build'
                        result.append((int(entry.th32ProcessID), handle))
                    except Exception:
                        self.kernel.CloseHandle(handle)
                        raise
                available = self.kernel.Process32NextW(snapshot, ctypes.byref(entry))
        except Exception:
            for _, handle in result:
                self.kernel.CloseHandle(handle)
            raise
        finally:
            self.kernel.CloseHandle(snapshot)
        return result


def storage_cleanup_path(main):
    global ISOLATED_STORAGE_ROOT, ISOLATED_CONFIG_PATH
    layout = invoke(main, 'get_storage_layout')
    root = Path(layout['root']).resolve()
    config = Path(layout['config']).resolve()
    assert helpers.IDENTIFIER.casefold() in {part.casefold() for part in root.parts}, (
        f'Refusing to alter configuration outside the isolated test directory: {root}')
    assert config.is_relative_to(root), f'Configuration is outside the isolated storage root: {config}'
    path = config / 'desktop-organizer-mode.json'
    if ISOLATED_CONFIG_PATH is not None:
        assert path == ISOLATED_CONFIG_PATH and root == ISOLATED_STORAGE_ROOT, 'Isolated storage changed between recovery scenarios'
    ISOLATED_STORAGE_ROOT = root
    ISOLATED_CONFIG_PATH = path
    return path


def write_test_mode(path, enabled, presentation):
    assert ISOLATED_STORAGE_ROOT is not None and ISOLATED_CONFIG_PATH is not None
    root = ISOLATED_STORAGE_ROOT.resolve()
    resolved = path.resolve()
    assert helpers.IDENTIFIER.casefold() in {part.casefold() for part in root.parts}
    assert resolved == ISOLATED_CONFIG_PATH.resolve() and resolved.is_relative_to(root), (
        f'Refusing to write a configuration outside the validated isolated root: {resolved}')
    assert resolved.name == 'desktop-organizer-mode.json'
    resolved.write_text(json.dumps({'version': 1, 'enabled': enabled, 'presentation': presentation}), encoding='utf-8')


def settings(main):
    return main.evaluate('JSON.parse(localStorage.getItem("dtkit_desktop_organizer") || "{}")')


def confirm_toggle(main):
    button = main.locator('#confirmDesktopOrganizer')
    if button.is_visible():
        button.click()


def enable_space(main, context, process):
    assert process.poll() is None, 'The launched test process is not running'
    main.locator('[data-view="settings"]').click()
    main.locator('.settings-side-nav__item[href="#configSection"]').click()
    toggle = main.locator('#desktopOrganizerToggle')
    expect(toggle).to_be_attached()
    # Reuse the real UI lifecycle, so its persisted enabled flag and native mode
    # cannot disagree when the desktop page is recreated.
    if toggle.is_checked():
        toggle.uncheck(force=True)
        confirm_toggle(main)
        helpers.wait_until(lambda: invoke(main, 'get_desktop_organizer_mode')['enabled'] is False)
        expect(toggle).to_be_enabled()
    desktop_helpers.choose(main, 'presentation', 'space')
    desktop_helpers.choose(main, 'layout', 'zones')
    desktop_helpers.choose(main, 'appearance', 'liquid')
    helpers.wait_until(lambda: settings(main).get('presentation') == 'space'
                       and settings(main).get('layout') == 'zones'
                       and settings(main).get('appearance') == 'liquid')
    expect(toggle).to_be_enabled()
    toggle.check(force=True)
    confirm_toggle(main)
    helpers.wait_until(lambda: desktop_helpers.mode_is(main, 'space', True, False))
    assert settings(main)['enabled'] is True
    desktop = desktop_helpers.space_page(main, context)
    expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-layout', 'zones')
    expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-appearance', 'liquid')
    desktop_helpers.settle(desktop)
    return desktop


def raw_file_paths(page):
    snapshot = invoke(page, 'desktop_scan')
    return {file['path'] for key, files in snapshot.items()
            if isinstance(files, list) and key != 'recent' for file in files}


def assert_real_files(page, expected):
    assert raw_file_paths(page) == expected, 'Native recovery changed the real desktop file index'
    rendered = set(page.locator('.space-file[data-path]').evaluate_all('nodes => nodes.map(node => node.dataset.path)'))
    assert rendered.issubset(expected), 'Recovered desktop renders sample files'
    if expected:
        assert rendered, 'Recovered desktop did not render native files'


def icons_match(windows, baseline):
    current = windows.icon_visibility()
    # Explorer is never restarted by these tests; every original icon-list HWND
    # must still exist. This prevents a missing window from passing vacuously.
    return set(current) == set(baseline) and all(current[hwnd] == visible for hwnd, visible in baseline.items())


def clean_case(main, process, config_path, windows, baseline):
    try:
        if process.poll() is None and not main.is_closed():
            invoke(main, 'set_desktop_organizer_mode', {'enabled': False, 'presentation': 'classic'})
            main.evaluate('''() => {
                const current = JSON.parse(localStorage.getItem('dtkit_desktop_organizer') || '{}');
                localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({...current, enabled:false, presentation:'classic'}));
            }''')
        elif config_path is not None:
            # The crash case has no surviving bridge. Reset only the exact
            # test-identifier configuration validated before terminating it.
            write_test_mode(config_path, False, 'classic')
    finally:
        assert icons_match(windows, baseline), 'Desktop lifecycle altered user icon visibility'


def check_window_recreation(main, context, process):
    windows = DesktopWindows()
    baseline = INITIAL_ICONS.copy()
    config_path = storage_cleanup_path(main)
    try:
        desktop = enable_space(main, context, process)
        old_host = windows.check_host(process)
        windows.check_shape(process, desktop)
        expected_preferences = settings(main)
        expected_files = raw_file_paths(desktop)
        desktop.screenshot(path=str(ARTIFACTS / 'before-window-recovery.png'))
        # WM_CLOSE reaches the owning UI thread and destroys only this exact
        # validated test desktop HWND; it neither stops Explorer nor the parent.
        assert windows.pid(old_host) == process.pid
        windows.user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        assert windows.user.PostMessageW(old_host, WM_CLOSE, 0, 0), ctypes.get_last_error()
        helpers.wait_until(lambda: not windows.user.IsWindow(old_host))

        def old_page_closed():
            main.wait_for_timeout(50)
            return desktop.is_closed()

        helpers.wait_until(old_page_closed)

        def recreated():
            main.wait_for_timeout(50)
            return any(not page.is_closed() and page is not desktop and 'host=desktop' in page.url
                       for page in context.pages)

        helpers.wait_until(recreated)
        recovered = next(page for page in context.pages
                         if not page.is_closed() and page is not desktop and 'host=desktop' in page.url)
        recovered.set_default_timeout(20_000)
        helpers.wait_until(lambda: desktop_helpers.mode_is(main, 'space', True, False))
        expect(recovered.locator('#desktopSpaceView')).to_have_attribute('data-layout', 'zones')
        expect(recovered.locator('#desktopSpaceView')).to_have_attribute('data-appearance', 'liquid')
        desktop_helpers.settle(recovered)
        assert process.poll() is None
        new_host = windows.check_host(process)
        assert new_host != old_host, 'The destroyed desktop HWND was reused instead of rebuilding the host'
        windows.check_shape(process, recovered)
        assert settings(main) == expected_preferences, 'Host recovery lost saved layout or appearance'
        assert settings(recovered) == expected_preferences, 'The rebuilt host did not read the saved native-enabled presentation'
        assert_real_files(recovered, expected_files)
        recovered.screenshot(path=str(ARTIFACTS / 'after-window-recovery.png'))
        print('Destroyed test desktop window automatically rebuilt with Explorer parent, nonempty shape and native files', flush=True)
    finally:
        clean_case(main, process, config_path, windows, baseline)


def check_parent_crash(main, context, process):
    windows = DesktopWindows()
    recovery = RecoveryProcesses()
    baseline = INITIAL_ICONS.copy()
    config_path = storage_cleanup_path(main)
    children = []
    try:
        desktop = enable_space(main, context, process)
        host = windows.check_host(process)
        windows.check_shape(process, desktop)
        parent = windows.user.GetParent(host)
        managed_icons = [hwnd for hwnd in baseline
                         if windows.user.GetParent(windows.user.GetParent(hwnd)) == parent]
        assert len(managed_icons) == 1, 'Cannot identify the icon list managed by this test desktop host'
        assert invoke(main, 'get_desktop_organizer_mode')['iconsHidden'] is False
        assert icons_match(windows, baseline), 'Enabling space changed user icon visibility'
        children = recovery.children(process)
        assert not children, 'Desktop space started an unnecessary icon recovery helper'
        desktop.screenshot(path=str(ARTIFACTS / 'before-parent-crash.png'))
        assert process.poll() is None
        # Popen.terminate on Windows calls TerminateProcess for this PID only.
        # Deliberately avoid taskkill /T, process trees and recovery-child stops.
        process.terminate()
        process.wait(timeout=10)
        assert process.returncode != 0, 'The crash scenario unexpectedly performed a normal application exit'
        helpers.wait_until(lambda: not windows.user.IsWindow(host) and not windows.owned(process))
        helpers.wait_until(lambda: icons_match(windows, baseline), seconds=10)
        assert icons_match(windows, baseline), 'A desktop-space crash changed user icon visibility'
        for pid, handle in children:
            helpers.wait_until(lambda handle=handle: recovery.kernel.WaitForSingleObject(handle, 0) == WAIT_OBJECT_0, seconds=10)
            assert not windows.owned(SimpleNamespace(pid=pid)), 'Recovery child left an auxiliary window after restoring icons'
        print('Terminating only the isolated test parent left user icon visibility unchanged; no desktop/helper UI remains', flush=True)
    finally:
        for _, handle in children:
            recovery.kernel.CloseHandle(handle)
        clean_case(main, process, config_path, windows, baseline)


def check_standalone_tool(quick, context, process):
    windows = DesktopWindows()
    baseline = INITIAL_ICONS.copy()
    config_path = storage_cleanup_path(quick)
    children = []
    recovery = RecoveryProcesses()
    try:
        assert json.loads(config_path.read_text(encoding='utf-8')) == {
            'version': 1, 'enabled': True, 'presentation': 'space'
        }, 'The standalone case did not start with a saved enabled desktop-space choice'
        expect(quick.locator('#htmlEditor')).to_be_visible()
        assert quick.evaluate('window.__TAURI__.window.getCurrentWindow().label').startswith('quick-host-')
        # Allow startup and a desktop monitor heartbeat to complete before checking
        # the isolation contract. This catches setup-level unconditional resume.
        quick.wait_for_timeout(1600)
        snapshot = invoke(quick, 'get_resource_snapshot')
        assert snapshot['toolOnly'] is True and snapshot['mainWindowOpen'] is False, snapshot
        assert snapshot['webviewCount'] == 1, 'A standalone tool started an unrelated WebView'
        assert invoke(quick, 'get_hotzone_status') is False, 'A standalone tool started the classic desktop hotzone'
        assert not any(windows.name(windows.user.GetParent(hwnd)) in ('WorkerW', 'Progman')
                       for hwnd in windows.owned(process)), 'A standalone tool created an Explorer desktop child'
        assert not any(not page.is_closed() and 'host=desktop' in page.url for page in context.pages)
        assert icons_match(windows, baseline), 'A standalone tool altered original desktop icon visibility'
        children = recovery.children(process)
        assert not children, 'A standalone tool started an unrelated desktop recovery helper'
        quick.screenshot(path=str(ARTIFACTS / 'standalone-tool.png'))
        quick.locator('#quickClose').click()
        helpers.wait_until(lambda: process.poll() is not None)
        assert process.returncode == 0, f'Standalone tool did not exit normally: {process.returncode}'
        assert not windows.owned(process), 'Standalone close left an auxiliary test window'
        assert icons_match(windows, baseline), 'Standalone exit changed original desktop icon visibility'
        print('Standalone html-preview ignored a saved enabled desktop choice, started no desktop services and exited normally', flush=True)
    finally:
        for _, handle in children:
            recovery.kernel.CloseHandle(handle)
        write_test_mode(config_path, False, 'classic')
        assert icons_match(windows, baseline), 'Standalone test altered user icon visibility'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    executable = parser.parse_args().exe.resolve()
    assert executable.is_file(), executable
    windows = DesktopWindows()
    INITIAL_ICONS = windows.icon_visibility()
    assert INITIAL_ICONS, 'Explorer desktop icon list was not found'
    try:
        with sync_playwright() as playwright:
            helpers.run_case(playwright, executable, [], check_window_recreation)
            assert icons_match(windows, INITIAL_ICONS), 'Window-recreation scenario did not restore the icon baseline'
            helpers.run_case(playwright, executable, [], check_parent_crash)
            assert icons_match(windows, INITIAL_ICONS), 'Crash scenario did not restore the icon baseline'
            # Both earlier test processes have exited before this exact isolated
            # configuration is changed. No live application shares this write.
            write_test_mode(ISOLATED_CONFIG_PATH, True, 'space')
            try:
                helpers.run_case(playwright, executable, ['--tool', 'html-preview'], check_standalone_tool)
            finally:
                write_test_mode(ISOLATED_CONFIG_PATH, False, 'classic')
    finally:
        assert icons_match(windows, INITIAL_ICONS), 'Recovery test altered user icon visibility'
    print(f'Desktop recovery, unchanged user icons and standalone-tool isolation passed; screenshots={ARTIFACTS}', flush=True)
