"""Exercise a real Windows login launch without touching the user's startup entry.

Build the isolated binary first:
  npm run build
  npm run tauri build -- --debug --no-bundle --config tests/native-webview.config.json

Run:
  python tests/autostart-native-smoke.py --exe src-tauri/target/debug/DtKit.exe

The test copies only the verified native-smoke binary into a fresh portable
directory. It never calls the mutating autostart IPC or writes an HKCU Run value.
Only child PIDs launched here are stopped. A failure preserves diagnostics.
"""

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen

from playwright.sync_api import Error, sync_playwright


IDENTIFIER = 'com.administrator.dtkit.native-smoke'
ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PREFIX = 'dtkit-autostart-native-'


def wait_until(predicate, message, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except Error as error:
            if 'Execution context was destroyed' not in str(error):
                raise
        time.sleep(0.1)
    raise AssertionError(message)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def debug_endpoint(port):
    try:
        with urlopen(f'http://127.0.0.1:{port}/json/version', timeout=0.25) as response:
            return bool(json.load(response).get('webSocketDebuggerUrl'))
    except (OSError, ValueError):
        return False


class OwnedWindows:
    """Inspect and close only native windows owned by this test's app PID."""

    def __init__(self):
        user = ctypes.WinDLL('user32', use_last_error=True)
        self.user = user
        self.callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user.EnumWindows.argtypes = [self.callback, wintypes.LPARAM]
        user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        user.IsWindowVisible.argtypes = [wintypes.HWND]
        user.IsWindowVisible.restype = wintypes.BOOL
        user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

    def owned(self, pid):
        found = []

        @self.callback
        def collect(hwnd, _):
            owner = wintypes.DWORD()
            self.user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == pid:
                title = ctypes.create_unicode_buffer(512)
                self.user.GetWindowTextW(hwnd, title, len(title))
                found.append((hwnd, title.value, bool(self.user.IsWindowVisible(hwnd))))
            return True

        # EnumWindows can return zero on a noninteractive test desktop with no
        # enumerated windows; later assertions still require our actual window.
        self.user.EnumWindows(collect, 0)
        return found

    def visible(self, pid):
        result = []
        for hwnd, title, visible in self.owned(pid):
            if not visible:
                continue
            rect = wintypes.RECT()
            if self.user.GetWindowRect(hwnd, ctypes.byref(rect)):
                width = rect.right - rect.left
                height = rect.bottom - rect.top
                # Tauri and its single-instance plugin may keep tiny helper
                # HWNDs visible to Win32. They have no user-facing surface.
                if width >= 100 and height >= 100:
                    result.append((hwnd, title, (rect.left, rect.top, width, height)))
        return result

    def main(self, pid):
        matches = [(hwnd, visible) for hwnd, title, visible in self.owned(pid) if title == 'DtKit']
        assert len(matches) <= 1, f'Multiple main windows belong to test PID {pid}: {matches}'
        return matches[0] if matches else None

    def close_main(self, pid):
        main = self.main(pid)
        assert main and main[1], 'Only the visible test main window may receive WM_CLOSE'
        assert self.user.PostMessageW(main[0], 0x0010, 0, 0), ctypes.get_last_error()


class OwnedProcesses:
    """Find WebView2 descendants through the Windows Toolhelp snapshot API."""

    class Entry(ctypes.Structure):
        _fields_ = [
            ('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
            ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_void_p),
            ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
            ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG),
            ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260),
        ]

    def __init__(self):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel = kernel
        kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(self.Entry)]
        kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(self.Entry)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    def descendants(self, pid):
        snapshot = self.kernel.CreateToolhelp32Snapshot(0x00000002, 0)
        assert snapshot not in (0, ctypes.c_void_p(-1).value), ctypes.get_last_error()
        entries = []
        try:
            item = self.Entry()
            item.dwSize = ctypes.sizeof(item)
            present = self.kernel.Process32FirstW(snapshot, ctypes.byref(item))
            while present:
                entries.append((item.th32ProcessID, item.th32ParentProcessID, item.szExeFile))
                present = self.kernel.Process32NextW(snapshot, ctypes.byref(item))
        finally:
            self.kernel.CloseHandle(snapshot)
        descendants = []
        pending = {pid}
        while pending:
            children = [entry for entry in entries if entry[1] in pending]
            descendants.extend(children)
            pending = {entry[0] for entry in children}
        return descendants


def assert_windowless(process, port, windows, processes, duration):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        assert process.poll() is None, f'Autostart process exited: {process.returncode}'
        assert not debug_endpoint(port), 'Autostart created a WebView2 CDP endpoint'
        webviews = [entry for entry in processes.descendants(process.pid)
                    if entry[2].lower() == 'msedgewebview2.exe']
        assert not webviews, f'Autostart created WebView2 processes: {webviews}'
        visible = windows.visible(process.pid)
        assert not visible, f'Autostart created visible native windows: {visible}'
        time.sleep(0.2)


def invoke(page, command, **args):
    return page.evaluate('''({command,args}) => Promise.race([
        window.__TAURI__.core.invoke(command,args),
        new Promise((_, reject) => setTimeout(() => reject(new Error(command + ' timed out')), 20000))
    ])''', {'command': command, 'args': args})


def page_for_label(context, label):
    def located():
        # Pump Playwright's CDP event loop while native windows are created.
        for page in context.pages:
            if page.is_closed():
                continue
            try:
                if page.evaluate('window.__TAURI__?.window?.getCurrentWindow().label') == label:
                    return page
            except Error:
                pass
        return None

    found = None

    def ready():
        nonlocal found
        found = located()
        return found is not None

    wait_until(ready, f'Native {label} WebView did not appear')
    found.set_default_timeout(20_000)
    found.wait_for_function('Boolean(window.__TAURI__?.core?.invoke)')
    return found


def assert_isolation(page, expected_root, check_identifier=True):
    # The quick-host capability deliberately cannot call plugin:app|identifier.
    if check_identifier:
        identifier = invoke(page, 'plugin:app|identifier')
        assert identifier == IDENTIFIER, f'Refusing a production identifier: {identifier}'
    layout = invoke(page, 'get_storage_layout')
    actual = Path(layout['root']).resolve(strict=True)
    assert actual == expected_root.resolve(strict=True), f'Refusing nonportable storage: {actual}'
    assert Path(layout['config']).resolve(strict=True) == actual / 'Config', layout


def run(executable, keep, space_enabled=False):
    assert os.name == 'nt', 'This smoke test requires Windows'
    assert executable.is_file(), executable
    config = json.loads((ROOT / 'tests/native-webview.config.json').read_text(encoding='utf-8'))
    assert config['identifier'] == IDENTIFIER, 'The isolated build configuration changed'
    assert IDENTIFIER.encode('ascii') in executable.read_bytes(), (
        'Refusing to launch a binary without the native-smoke identifier')

    fixture = Path(tempfile.mkdtemp(prefix=FIXTURE_PREFIX)).resolve(strict=True)
    temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
    assert fixture.parent == temp_root and re.fullmatch(FIXTURE_PREFIX + r'[a-zA-Z0-9_]+', fixture.name)
    copied = fixture / 'DtKit 自启测试.exe'
    shutil.copy2(executable, copied)
    (fixture / 'portable.json').write_text('{}', encoding='utf-8')
    expected_root = fixture / 'data'
    if space_enabled:
        config = expected_root / 'Config'
        config.mkdir(parents=True)
        (config / 'desktop-organizer-mode.json').write_text(json.dumps({
            'version': 1, 'enabled': True, 'presentation': 'space',
            'shortcutInitialized': True,
        }), encoding='utf-8')
    port = free_port()
    environment = dict(os.environ)
    environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = f'--remote-debugging-port={port}'
    environment['WEBVIEW2_USER_DATA_FOLDER'] = str(fixture / 'webview-profile')
    log = (fixture / 'native.log').open('wb')
    launched = []
    browser = None
    success = False

    def start(*arguments):
        child = subprocess.Popen([str(copied), *arguments], cwd=fixture,
                                 env=environment, stdout=log, stderr=log,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        launched.append(child)
        return child

    def deliver(*arguments):
        child = start(*arguments)
        try:
            code = child.wait(timeout=15)
        except subprocess.TimeoutExpired as error:
            raise AssertionError(f'Secondary launch did not hand off {arguments}') from error
        assert code == 0, f'Secondary launch {arguments} failed: {code}'

    windows = OwnedWindows()
    processes = OwnedProcesses()
    try:
        first = start('--autostart')
        assert_windowless(first, port, windows, processes, 3.0)
        deliver('--autostart')
        assert_windowless(first, port, windows, processes, 1.0)

        deliver('--tool', 'html-preview')
        wait_until(lambda: debug_endpoint(port), 'Tool request did not create a WebView')
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            context = browser.contexts[0]
            quick = None
            wait_until(lambda: bool(context.pages), 'Tool page did not appear')
            for page in context.pages:
                if not page.is_closed():
                    quick = page
                    break
            assert quick is not None
            quick.set_default_timeout(20_000)
            quick.wait_for_function('Boolean(window.__TAURI__?.core?.invoke)')
            assert quick.evaluate('window.__TAURI__.window.getCurrentWindow().label').startswith('quick-host-')
            assert_isolation(quick, expected_root, check_identifier=False)
            assert invoke(quick, 'stop_background_alarm_audio', taskId=None) is False
            snapshot = invoke(quick, 'get_resource_snapshot')
            assert snapshot['mainWindowOpen'] is False, snapshot
            assert snapshot['toolOnly'] is False, snapshot
            assert snapshot['webviewCount'] == 1, snapshot
            denied = quick.evaluate('''async () => {
                try { await window.__TAURI__.core.invoke('get_autostart_status'); return null; }
                catch(error) { return String(error); }
            }''')
            assert denied and '主设置窗口' in denied, (
                f'Autostart settings must be restricted to the main window: {denied}')
            with quick.expect_event('close', timeout=20_000):
                quick.locator('#quickClose').click()
            assert first.poll() is None, 'Closing the tool exited the resident app'
            browser.close()
            browser = None

            deliver()
            wait_until(lambda: debug_endpoint(port), 'Manual launch did not create the main WebView')
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            context = browser.contexts[0]
            main = page_for_label(context, 'main')
            assert_isolation(main, expected_root)
            wait_until(lambda: bool(windows.main(first.pid) and windows.main(first.pid)[1]),
                       'Manual launch did not show the main window')
            snapshot = invoke(main, 'get_resource_snapshot')
            assert snapshot['mainWindowOpen'] is True and snapshot['toolOnly'] is False, snapshot
            status = invoke(main, 'get_autostart_status')
            assert isinstance(status.get('available'), bool), status
            assert isinstance(status.get('enabled'), bool), status

            deliver('--autostart')
            assert windows.main(first.pid)[1], 'Repeated autostart hid the visible main window'
            assert invoke(main, 'get_resource_snapshot')['mainWindowOpen'] is True

            windows.close_main(first.pid)
            wait_until(lambda: not windows.main(first.pid) or not windows.main(first.pid)[1],
                       'Main window did not close or hide', seconds=12)
            assert first.poll() is None, 'Closing main exited the resident app'
            deliver('--autostart')
            assert not windows.main(first.pid) or not windows.main(first.pid)[1], (
                'Repeated autostart restored the hidden main window')
            deliver()
            wait_until(lambda: bool(windows.main(first.pid) and windows.main(first.pid)[1]),
                       'Normal launch did not restore the main window')
            assert first.poll() is None
            success = True
            mode = 'saved desktop space' if space_enabled else 'default desktop mode'
            print(f'Autostart native smoke passed ({mode}): no startup WebView, resident tools, main restore', flush=True)
    finally:
        if browser:
            try:
                browser.close()
            except Error:
                pass
        for child in reversed(launched):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=10)
        log.close()
        if success and not keep:
            # The target is the exact, resolved child of the system temp directory
            # created above; never recursively remove a resolved user data path.
            assert fixture.resolve(strict=True).parent == temp_root
            assert re.fullmatch(FIXTURE_PREFIX + r'[a-zA-Z0-9_]+', fixture.name)
            for attempt in range(30):
                if not fixture.exists():
                    break
                # WebView2 may concurrently release or remove profile files.
                # Retry this verified fixture as its final child exits.
                shutil.rmtree(fixture, ignore_errors=True)
                if fixture.exists():
                    time.sleep(0.5)
            if fixture.exists():
                print(f'Autostart fixture remains locked: {fixture}', flush=True)
        else:
            print(f'Autostart diagnostics preserved: {fixture}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--keep', action='store_true', help='preserve the isolated test directory')
    arguments = parser.parse_args()
    run(arguments.exe.resolve(), arguments.keep)
    run(arguments.exe.resolve(), arguments.keep, space_enabled=True)
