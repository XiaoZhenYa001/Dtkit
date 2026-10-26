"""Exercise the packaged desktop launcher through a real Windows WebView2 bridge.

Build first:
  npm run build
  npm run tauri build -- --debug --no-bundle --config tests/native-webview.config.json
Run:
  python tests/desktop-launcher-native-smoke.py --exe src-tauri/target/debug/DtKit.exe

Optional --capture-window records only this test process's launcher rectangle.
The exact native-smoke app identifier and its isolated storage are checked before
any mutation. The shared harness exposes CDP only in each launched child and only
terminates that child. No default file application or real global hotkey is used.
Fixtures live in one newly created UUID desktop subdirectory; cleanup only unlinks
its known files after checking the resolved parent and exact generated name.
"""

import argparse
import base64
import ctypes
from ctypes import wintypes
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tempfile
import uuid

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
IDENTIFIER = 'com.administrator.dtkit.native-smoke'
STORAGE_KEY = 'dtkit_desktop_space_v2'
FIXTURE_PREFIX = 'DtKit-launcher-smoke-'
CONFIG_NAMES = {'desktop-organizer-mode.json', 'tool-shortcuts.json', 'desktop-space-settings.json'}
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=')
TEXT = 'DtKit launcher native preview\n真实 UTF-8 内容\n<script>window.__fixtureExecuted = true</script>'

spec = importlib.util.spec_from_file_location('native_launcher_helpers', ROOT / 'tests/native-webview-ui-smoke.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def invoke(page, command, **args):
    return page.evaluate('''({command,args}) => Promise.race([
        window.__TAURI__.core.invoke(command,args),
        new Promise((_, reject) => setTimeout(() => reject(new Error(command + ' timed out')), 20000))
    ])''', {'command': command, 'args': args})


def rejected(page, command, contains, **args):
    result = page.evaluate('''async ({command,args}) => {
        try { return {ok:true, value:await window.__TAURI__.core.invoke(command,args)}; }
        catch(error) { return {ok:false, error:String(error)}; }
    }''', {'command': command, 'args': args})
    assert not result['ok'], f'{command} unexpectedly succeeded: {result}'
    assert contains in result['error'], result


def check_isolation(main):
    # Verify the actual compiled identifier, not a substring of a chosen path.
    identifier = invoke(main, 'plugin:app|identifier')
    assert identifier == IDENTIFIER, f'Refusing non-test application identifier: {identifier}'
    layout = invoke(main, 'get_storage_layout')
    root, config = Path(layout['root']).resolve(strict=True), Path(layout['config']).resolve(strict=True)
    assert root.name == IDENTIFIER, f'Refusing nonstandard test storage: {root}'
    assert config.parent == root and config.name == 'Config', config
    return config


def main_page(seed, context):
    # A restored hidden launcher can race creation of the main target.
    def ready():
        seed.wait_for_timeout(40)
        return any(not page.is_closed() and '/desktop-organizer/' not in page.url
                   and page.evaluate('window.__TAURI__?.window?.getCurrentWindow().label === "main"')
                   for page in context.pages)
    native.wait_until(ready)
    return next(page for page in context.pages if not page.is_closed()
                and '/desktop-organizer/' not in page.url
                and page.evaluate('window.__TAURI__?.window?.getCurrentWindow().label === "main"'))


class NativeWindows:
    """Read or post WM_CLOSE only to the launcher belonging to the launched PID."""

    def __init__(self):
        assert os.name == 'nt', 'This smoke test requires Windows'
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        self.user.EnumWindows.argtypes = [self.callback, wintypes.LPARAM]
        self.user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.user.IsWindowVisible.argtypes = [wintypes.HWND]
        self.user.IsWindowVisible.restype = wintypes.BOOL
        self.user.GetParent.argtypes = [wintypes.HWND]
        self.user.GetParent.restype = wintypes.HWND
        self.user.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user.GetWindowLongPtrW.restype = ctypes.c_ssize_t
        self.user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        self.user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]

    def find(self, process):
        found = []

        @self.callback
        def collect(hwnd, _):
            pid = wintypes.DWORD()
            self.user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value == process.pid:
                title = ctypes.create_unicode_buffer(512)
                self.user.GetWindowTextW(hwnd, title, len(title))
                if title.value == '桌面空间':
                    found.append(hwnd)
            return True

        self.user.EnumWindows(collect, 0)
        assert len(found) <= 1, f'Multiple launcher HWNDs for the test PID: {found}'
        return found[0] if found else None

    def visible(self, process):
        hwnd = self.find(process)
        return bool(hwnd and self.user.IsWindowVisible(hwnd))

    def check_transient(self, process):
        hwnd = self.find(process)
        assert hwnd, 'The launcher has no native top-level window'
        assert not self.user.GetParent(hwnd), 'Launcher still has an Explorer or owner parent'
        style = self.user.GetWindowLongPtrW(hwnd, -16)
        extended = self.user.GetWindowLongPtrW(hwnd, -20)
        assert not style & 0x40000000, 'Launcher is still a child window'
        assert extended & 0x00000008, 'Launcher does not float above the active application'
        # Tao hides this window through ITaskbarList::DeleteTab; WS_EX_APPWINDOW
        # remains set and cannot be used to infer taskbar membership.

    def close_test_launcher(self, process):
        hwnd = self.find(process)
        assert hwnd and self.visible(process), 'Only a visible test launcher may receive WM_CLOSE'
        assert self.user.PostMessageW(hwnd, 0x0010, 0, 0), ctypes.get_last_error()

    def capture(self, process, destination):
        from PIL import ImageGrab
        hwnd = self.find(process)
        assert hwnd and self.visible(process)
        rect = wintypes.RECT()
        # DWM frame bounds are physical pixels even when this Python process
        # is DPI-unaware; GetWindowRect would yield a virtualized crop.
        dwm = ctypes.WinDLL('dwmapi')
        dwm.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        assert dwm.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)) == 0
        ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom), all_screens=True).save(destination)


def small_pdf():
    from PIL import Image
    encoded = io.BytesIO()
    Image.new('RGB', (64, 64), (210, 20, 160)).save(encoded, format='JPEG2000')
    image = encoded.getvalue()
    stream = b'q 600 0 0 800 0 0 cm /Im0 Do Q\n'
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
               b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'endstream',
               b'<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length '
               + str(len(image)).encode() + b' >>\nstream\n' + image + b'\nendstream']
    output = b'%PDF-1.5\n'
    offsets = [0]
    for index, body in enumerate(objects, 1):
        offsets.append(len(output))
        output += f'{index} 0 obj\n'.encode() + body + b'\nendobj\n'
    xref = len(output)
    output += f'xref\n0 {len(offsets)}\n'.encode() + b'0000000000 65535 f \n'
    output += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return output + f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()


class DesktopFixtures:
    def __init__(self, desktop):
        self.desktop = Path(desktop).resolve(strict=True)
        assert self.desktop.is_dir()
        self.name = FIXTURE_PREFIX + uuid.uuid4().hex
        self.directory = self.desktop / self.name
        self.directory.mkdir(exist_ok=False)
        assert self.directory.resolve(strict=True).parent == self.desktop
        self.files = {
            'notes.txt': TEXT.encode('utf-8'), 'pixel.png': PNG,
            'reference.pdf': small_pdf(), 'proposal.docx': b'fixture metadata only',
            'invalid.txt': bytes([0xff, 0xfe]), 'large.txt': b'x' * (512 * 1024 + 1),
        }
        try:
            for name, contents in self.files.items():
                (self.directory / name).write_bytes(contents)
        except BaseException:
            self.cleanup()
            raise

    def path(self, name):
        assert name in self.files
        return str(self.directory / name)

    def cleanup(self):
        # Deliberately avoid rmtree: refuse unexpected files or redirections.
        assert self.directory.name == self.name
        assert re.fullmatch(re.escape(FIXTURE_PREFIX) + r'[0-9a-f]{32}', self.name)
        resolved = self.directory.resolve(strict=True)
        assert resolved.parent == self.desktop and resolved.name == self.name, resolved
        entries = list(self.directory.iterdir())
        assert {entry.name for entry in entries}.issubset(self.files), 'Unexpected file in fixture directory; preserving it'
        for entry in entries:
            assert not entry.is_symlink() and entry.resolve(strict=True).parent == resolved, entry
            assert entry.is_file(), entry
            entry.unlink()
        self.directory.rmdir()


def launcher_page(main, context):
    def created():
        main.wait_for_timeout(40)  # Pump CDP target-created events.
        return any(not page.is_closed() and '/desktop-organizer/space.html' in page.url for page in context.pages)
    native.wait_until(created)
    page = next(page for page in context.pages if not page.is_closed() and '/desktop-organizer/space.html' in page.url)
    page.set_default_timeout(20_000)
    page.wait_for_function("Boolean(window.__TAURI__?.core?.invoke && document.getElementById('launcher'))")
    # Scanning begins only after the application's event listeners and ready ACK.
    page.wait_for_function("!document.getElementById('spaceStatus').textContent.startsWith('正在读取文件')")
    page.evaluate('''async () => {
        window.__nativeLauncherSession = -1;
        await window.__TAURI__.event.listen('desktop-space-opened', event => {
            window.__nativeLauncherSession = event.payload.session;
        });
    }''')
    return page


def show(main, page, windows, process):
    previous = page.evaluate('window.__nativeLauncherSession')
    invoke(main, 'desktop_space_show')
    page.wait_for_function('previous => window.__nativeLauncherSession > previous', arg=previous)
    expect(page.locator('#launcher')).to_have_attribute('aria-hidden', 'false')
    expect(page.locator('#launcher')).to_be_visible()
    native.wait_until(lambda: windows.visible(process))
    return page.evaluate('window.__nativeLauncherSession')


def card(page, name, lane='#fileGrid'):
    return page.locator(f'{lane} .launcher-card[data-id]').filter(
        has=page.locator('.file-name', has_text=re.compile('^' + re.escape(name) + '$')))


def preview_in_ui(page, name):
    card(page, name).locator('button.launcher-file').click()
    page.keyboard.press('Space')
    expect(page.locator('#filePreview')).to_be_visible()
    expect(page.locator('#previewName')).to_have_text(name)


class RunState:
    def __init__(self, capture_window=False):
        self.config = None
        self.backups = {}
        self.capture_window = capture_window
        self.artifacts = Path(tempfile.mkdtemp(prefix='dtkit-launcher-native-'))

    def config_path(self, name):
        assert self.config and name in CONFIG_NAMES
        assert self.config.resolve(strict=True).name == 'Config'
        assert self.config.resolve(strict=True).parent.name == IDENTIFIER
        path = self.config / name
        assert path.resolve(strict=False).parent == self.config.resolve(strict=True)
        return path

    def prime(self, main, context, process):
        main = main_page(main, context)
        self.config = check_isolation(main)
        for name in CONFIG_NAMES:
            path = self.config_path(name)
            self.backups[name] = path.read_bytes() if path.exists() else None
        invoke(main, 'set_desktop_organizer_mode', enabled=False, presentation='classic')
        # Preserve real palette and tool bindings while activating the other mode.
        for key in ('Ctrl+Alt+Space', 'Ctrl+Alt+Shift+F23'):
            candidates = [
                {'accelerator': key, 'target': {'kind': 'palette'}, 'enabled': True},
                {'accelerator': 'Ctrl+Alt+Shift+F24', 'target': {'kind': 'tool', 'toolId': 'html-preview'}, 'enabled': True},
                {'accelerator': 'Ctrl+Alt+Shift+F22', 'target': {'kind': 'tool', 'toolId': 'whiteboard'}, 'enabled': True},
            ]
            try:
                self.existing_bindings = invoke(main, 'replace_shortcut_bindings', bindings=candidates)
                break
            except Exception:
                if key != 'Ctrl+Alt+Space':
                    raise
                print('Production application owns Ctrl+Alt+Space; isolated palette uses F23; Rust regression covers the exact original collision', flush=True)
        assert self.existing_bindings

    def seed_first_enable(self):
        self.config_path('desktop-organizer-mode.json').write_text(json.dumps({
            'version': 1, 'enabled': True, 'presentation': 'classic', 'shortcutInitialized': False
        }), encoding='utf-8')
        self.config_path('tool-shortcuts.json').write_text(json.dumps(self.existing_bindings), encoding='utf-8')

    def restore(self):
        if not self.config:
            return
        for name, contents in self.backups.items():
            path = self.config_path(name)
            if contents is None:
                if path.exists():
                    path.unlink()
            else:
                path.write_bytes(contents)

    def scenario(self, main, context, process):
        main = main_page(main, context)
        assert check_isolation(main) == self.config
        windows = NativeWindows()
        fixtures = DesktopFixtures(invoke(main, 'desktop_get_path'))
        try:
            previous_mode = invoke(main, 'get_desktop_organizer_mode')
            assert previous_mode['enabled'] and previous_mode['presentation'] == 'classic'
            assert previous_mode['hotzoneRunning']
            assert invoke(main, 'get_shortcut_bindings') == self.existing_bindings
            mode = invoke(main, 'set_desktop_organizer_mode', enabled=True, presentation='space')
            assert mode['enabled'] and mode['presentation'] == 'space'
            assert not mode['hotzoneRunning'] and not mode['desktopSpaceVisible']
            page = launcher_page(main, context)
            expect(page.locator('#launcher')).to_have_attribute('aria-hidden', 'true')
            assert not windows.visible(process), 'Enabling space unexpectedly showed it'
            assert not page.evaluate('window.__TAURI__.window.getCurrentWindow().isVisible()')
            bindings = invoke(main, 'get_shortcut_bindings')
            space_bindings = [binding for binding in bindings if binding['target']['kind'] == 'desktopSpace']
            assert [binding for binding in bindings if binding['target']['kind'] != 'desktopSpace'] == self.existing_bindings
            if space_bindings:
                assert len(space_bindings) == 1, bindings
                keys = set(space_bindings[0]['accelerator'].upper().replace('CONTROL', 'CTRL').split('+'))
                assert keys == {'CTRL', 'ALT', 'KEYD'}, space_bindings
                assert not mode.get('shortcutWarning'), mode
                print('Native enabled classic with existing palette/tools switched to space with independent Ctrl+Alt+D', flush=True)
            else:
                assert mode.get('shortcutWarning'), mode
                print('Native default Ctrl+Alt+D unavailable; space still enabled and button-show remains available', flush=True)
            assert json.loads(self.config_path('desktop-organizer-mode.json').read_text(encoding='utf-8-sig'))['shortcutInitialized']

            first_session = show(main, page, windows, process)
            windows.check_transient(process)
            second_session = show(main, page, windows, process)
            assert second_session > first_session
            invoke(page, 'desktop_space_hide', session=first_session)
            page.wait_for_timeout(100)
            assert windows.visible(process), 'An old frontend hide dismissed a newer show'
            assert invoke(main, 'get_desktop_organizer_mode')['desktopSpaceVisible']

            # IPC returns actual bounded file contents, with no external launch.
            result = invoke(page, 'desktop_preview_file', path=fixtures.path('notes.txt'))
            assert result['kind'] == 'text' and result['text'] == TEXT
            image = invoke(page, 'desktop_preview_file', path=fixtures.path('pixel.png'))
            assert image['kind'] == 'image' and base64.b64decode(image['dataUrl'].split(',', 1)[1]) == PNG
            pdf = invoke(page, 'desktop_preview_file', path=fixtures.path('reference.pdf'))
            assert pdf['kind'] == 'pdf' and base64.b64decode(pdf['dataUrl'].split(',', 1)[1]) == fixtures.files['reference.pdf']
            metadata = invoke(page, 'desktop_preview_file', path=fixtures.path('proposal.docx'))
            assert metadata['kind'] == 'metadata' and metadata['message'] and 'text' not in metadata
            rejected(main, 'desktop_preview_file', '此窗口', path=fixtures.path('notes.txt'))
            rejected(page, 'desktop_preview_file', '不存在', path=str(fixtures.directory / 'missing.txt'))
            rejected(page, 'desktop_preview_file', '文件夹', path=str(fixtures.directory))
            rejected(page, 'desktop_preview_file', 'UTF-8', path=fixtures.path('invalid.txt'))
            rejected(page, 'desktop_preview_file', '过大', path=fixtures.path('large.txt'))
            with tempfile.TemporaryDirectory(prefix='dtkit-launcher-outside-') as outside:
                outside_file = Path(outside) / 'outside.txt'
                outside_file.write_text('fixture outside desktop', encoding='utf-8')
                assert not outside_file.resolve().is_relative_to(fixtures.desktop)
                rejected(page, 'desktop_preview_file', '只允许操作桌面', path=str(outside_file))

            page.locator('#spaceSearch').fill(fixtures.name)
            card(page, fixtures.name).locator('button.launcher-file').dblclick()
            expect(page.locator('#folderName')).to_have_text(fixtures.name)
            preview_in_ui(page, 'notes.txt')
            expect(page.locator('#previewContent pre')).to_have_text(TEXT)
            assert page.locator('#previewContent script').count() == 0
            assert page.evaluate('window.__fixtureExecuted === undefined')
            page.keyboard.press('Escape')
            expect(page.locator('#filePreview')).to_be_hidden()
            assert windows.visible(process), 'Esc from a preview hid the whole launcher'
            preview_in_ui(page, 'pixel.png')
            page.wait_for_function("document.querySelector('#previewContent img')?.naturalWidth > 0")
            page.keyboard.press('Escape')
            preview_in_ui(page, 'reference.pdf')
            # PDF image decoders use WebAssembly under the packaged CSP.
            assert page.evaluate("WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => true)")
            page.wait_for_function("document.querySelector('#previewContent .pdf-stage canvas')?.width > 1")
            expect(page.locator('#previewContent .pdf-status')).to_be_hidden()
            colored_pdf = """() => {
                const canvas = document.querySelector('#previewContent .pdf-stage canvas');
                if (!document.querySelector('#previewContent .pdf-status')?.hidden) return false;
                return [Math.min(64, canvas.height - 1), Math.floor(canvas.height / 2)].every(y => {
                    const color = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), y, 1, 1).data;
                    return color[0] > 150 && color[1] < 80 && color[2] > 100;
                });
            }"""
            def stable_colored_pdf():
                # A single ready frame can hide a ResizeObserver/render loop.
                # Require the real pixels and ready status for 500 ms of frames.
                assert page.evaluate("() => { const ready = (" + colored_pdf + ");" + """
                    return new Promise(resolve => {
                        const start = performance.now(); let since = null;
                        function frame(now) {
                            if (ready()) { since ??= now; if (now - since >= 500) return resolve(true); }
                            else since = null;
                            if (now - start > 15000) return resolve(false);
                            requestAnimationFrame(frame);
                        }
                        requestAnimationFrame(frame);
                    });
                }"""), 'JPEG2000 PDF never kept stable visible pixels for 500 ms'
            for warm in (False, True):
                if warm:
                    page.locator('#previewContent .pdf-stage').focus()
                    page.keyboard.press('Escape')
                    expect(page.locator('#filePreview')).to_be_hidden()
                    preview_in_ui(page, 'reference.pdf')
                page.wait_for_function(colored_pdf)
                stable_colored_pdf()
                for action in ('out', 'fit'):
                    page.locator(f'#previewContent [data-pdf="{action}"]').click()
                    page.wait_for_function(colored_pdf)
                    stable_colored_pdf()
            page.locator('#previewContent .pdf-stage').focus()
            page.keyboard.press('Escape')
            expect(page.locator('#filePreview')).to_be_hidden()
            preview_in_ui(page, 'proposal.docx')
            expect(page.locator('#previewContent .preview-metadata')).to_contain_text('暂不支持内容预览')
            page.keyboard.press('Escape')

            card(page, 'notes.txt').locator('.pin-button').click()
            saved = page.evaluate('key => JSON.parse(localStorage.getItem(key))', STORAGE_KEY)
            expected_path = Path(fixtures.path('notes.txt')).resolve(strict=True)
            assert any(os.path.samefile(item['path'], expected_path) for item in saved['pinned']), saved
            page.keyboard.press('Escape')  # Return from folder to root.
            expect(page.locator('.launcher-breadcrumb')).to_be_hidden()
            expect(card(page, 'notes.txt', '#pinnedGrid')).to_be_visible()
            page.keyboard.press('Escape')  # Then hide the launcher.
            native.wait_until(lambda: not windows.visible(process))
            show(main, page, windows, process)
            expect(card(page, 'notes.txt', '#pinnedGrid')).to_be_visible()
            if self.capture_window:
                page.wait_for_function("() => !document.querySelector('#launcher').classList.contains('is-moving') && !document.querySelector('#refreshSpace').disabled && document.getAnimations().every(animation => animation.playState !== 'running' && animation.playState !== 'pending')")
                page.wait_for_timeout(5000)  # Let deferred native icon hydration settle before the optional screenshot.
                windows.capture(process, self.artifacts / 'launcher-native-acrylic.png')

            # Remove JavaScript execution only in this test WebView. WM_CLOSE
            # must still hide the native shell within the bounded fallback.
            cdp = context.new_cdp_session(page)
            try:
                cdp.send('Emulation.setScriptExecutionDisabled', {'value': True})
                windows.close_test_launcher(process)
                native.wait_until(lambda: not windows.visible(process), seconds=5)
            finally:
                cdp.send('Emulation.setScriptExecutionDisabled', {'value': False})
                cdp.detach()
            page.wait_for_timeout(200)
            show(main, page, windows, process)
            expect(card(page, 'notes.txt', '#pinnedGrid')).to_be_visible()

            # A newer show survives the older close timer, as well as stale IPC.
            session = page.evaluate('window.__nativeLauncherSession')
            windows.close_test_launcher(process)
            expect(page.locator('#launcher')).to_have_attribute('aria-hidden', 'true')
            current = show(main, page, windows, process)
            assert current > session
            invoke(page, 'desktop_space_hide', session=session)
            page.wait_for_timeout(1250)
            assert windows.visible(process), 'The previous close timer hid a new show'

            remaining = [binding for binding in bindings if binding['target']['kind'] != 'desktopSpace']
            invoke(main, 'replace_shortcut_bindings', bindings=remaining)
            assert not any(binding['target']['kind'] == 'desktopSpace' for binding in invoke(main, 'get_shortcut_bindings'))
            invoke(main, 'set_desktop_organizer_mode', enabled=True, presentation='classic')
            native.wait_until(lambda: page.is_closed() and windows.find(process) is None)
            mode = invoke(main, 'get_desktop_organizer_mode')
            assert mode['hotzoneRunning'] and not mode['desktopSpaceVisible']
            rejected(main, 'desktop_space_show', '尚未启用')
            invoke(main, 'set_desktop_organizer_mode', enabled=False, presentation='space')
            assert not windows.visible(process)
            rejected(main, 'desktop_space_show', '尚未启用')

            invoke(main, 'set_desktop_organizer_mode', enabled=True, presentation='space')
            reopened = launcher_page(main, context)
            assert not windows.visible(process)
            assert not any(binding['target']['kind'] == 'desktopSpace' for binding in invoke(main, 'get_shortcut_bindings'))
            show(main, reopened, windows, process)
            expect(card(reopened, 'notes.txt', '#pinnedGrid')).to_be_visible()
            card(reopened, 'notes.txt', '#pinnedGrid').locator('.pin-button').click()
            reopened.keyboard.press('Escape')
            native.wait_until(lambda: not windows.visible(process))
        finally:
            fixtures.cleanup()

    def restart(self, main, context, process):
        main = main_page(main, context)
        assert check_isolation(main) == self.config
        windows = NativeWindows()
        page = launcher_page(main, context)
        mode = invoke(main, 'get_desktop_organizer_mode')
        assert mode['enabled'] and mode['presentation'] == 'space'
        assert not mode['desktopSpaceVisible'] and not windows.visible(process)
        assert not any(binding['target']['kind'] == 'desktopSpace' for binding in invoke(main, 'get_shortcut_bindings')), 'Cleared shortcut was recreated after process restart'
        show(main, page, windows, process)
        page.keyboard.press('Escape')
        native.wait_until(lambda: not windows.visible(process))
        invoke(main, 'set_desktop_organizer_mode', enabled=False, presentation='classic')

    def occupied_default(self, main, context, process):
        main = main_page(main, context)
        assert check_isolation(main) == self.config
        previous = invoke(main, 'get_desktop_organizer_mode')
        assert previous['enabled'] and previous['presentation'] == 'classic'
        assert invoke(main, 'get_shortcut_bindings') == self.existing_bindings
        # Occupy the candidate in this test application's registry. If another
        # application already owns it, that OS conflict exercises the same path.
        try:
            preserved = invoke(main, 'replace_shortcut_bindings', bindings=[*self.existing_bindings, {
                'accelerator': 'control+alt+KeyD',
                'target': {'kind': 'tool', 'toolId': 'json-formatter'}, 'enabled': True,
            }])
        except Exception as error:
            assert '注册快捷键失败' in str(error) and 'KeyD' in str(error), error
            preserved = invoke(main, 'get_shortcut_bindings')
            assert preserved == self.existing_bindings
        mode = invoke(main, 'set_desktop_organizer_mode', enabled=True, presentation='space')
        assert mode['enabled'] and mode['presentation'] == 'space'
        assert '快捷键' in mode.get('shortcutWarning', '') and '打开空间' in mode['shortcutWarning'], mode
        assert not mode['hotzoneRunning'] and not mode['desktopSpaceVisible']
        assert invoke(main, 'get_shortcut_bindings') == preserved
        assert not any(binding['target']['kind'] == 'desktopSpace' for binding in preserved)
        assert json.loads(self.config_path('desktop-organizer-mode.json').read_text(encoding='utf-8-sig'))['shortcutInitialized']
        windows = NativeWindows()
        page = launcher_page(main, context)
        show(main, page, windows, process)
        page.keyboard.press('Escape')
        native.wait_until(lambda: not windows.visible(process))
        print('Native occupied Ctrl+Alt+D kept every existing binding, enabled space with a warning, and allowed button-show', flush=True)

    def settings_routes(self, main, context, process):
        main = main_page(main, context)
        assert check_isolation(main) == self.config
        windows = NativeWindows()
        # Match saved WebView settings to the real native mode before navigating.
        invoke(main, 'set_desktop_organizer_mode', enabled=True, presentation='classic')
        main.evaluate("localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({enabled:true,presentation:'classic',reducedMotion:false}))")
        main.reload(wait_until='networkidle')
        main.locator('[data-view="settings"]').click()
        expect(main.locator('#desktopOrganizerToggle')).to_be_checked()
        main.locator('[data-organizer-presentation="space"]').check()
        main.wait_for_function("window.__TAURI__.core.invoke('get_desktop_organizer_mode').then(mode => mode.enabled && mode.presentation === 'space')")
        expect(main.locator('[data-organizer-presentation="space"]')).to_be_checked()
        expect(main.locator('.desktop-presentation-error[role="alert"]')).to_be_hidden()
        page = launcher_page(main, context)
        expect(main.locator('#openDesktopSpace')).to_be_enabled()
        main.locator('#openDesktopSpace').click()
        native.wait_until(lambda: windows.visible(process))
        expect(page.locator('#launcher')).to_have_attribute('aria-hidden', 'false')
        page.keyboard.press('Escape')
        native.wait_until(lambda: not windows.visible(process))

        invoke(main, 'set_desktop_organizer_mode', enabled=False, presentation='space')
        native.wait_until(lambda: page.is_closed())
        main.evaluate("localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({enabled:false,presentation:'space',reducedMotion:false}))")
        main.reload(wait_until='networkidle')
        main.locator('[data-view="settings"]').click()
        expect(main.locator('#desktopOrganizerToggle')).not_to_be_checked()
        expect(main.locator('[data-organizer-presentation="space"]')).to_be_checked()
        expect(main.locator('#openDesktopSpace')).to_have_text('启用并打开')
        expect(main.locator('#openDesktopSpace')).to_be_enabled()
        main.locator('#openDesktopSpace').click()
        reopened = launcher_page(main, context)
        native.wait_until(lambda: windows.visible(process))
        expect(reopened.locator('#launcher')).to_have_attribute('aria-hidden', 'false')
        expect(main.locator('#desktopOrganizerToggle')).to_be_checked()
        mode = invoke(main, 'get_desktop_organizer_mode')
        assert mode['enabled'] and mode['presentation'] == 'space' and mode['desktopSpaceVisible'], mode
        expect(main.locator('.desktop-presentation-error[role="alert"]')).to_be_hidden()
        reopened.keyboard.press('Escape')
        native.wait_until(lambda: not windows.visible(process))
        invoke(main, 'set_desktop_organizer_mode', enabled=False, presentation='classic')
        print('Native settings DOM passed: enabled classic radio -> space -> open, disabled space -> enable-and-open with synchronized master toggle', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--capture-window', action='store_true', help='Capture only the visible test launcher rectangle using Pillow')
    parser.add_argument('--settings-only', action='store_true', help='Run only the real settings DOM activation routes, preserving isolated test configuration')
    args = parser.parse_args()
    assert os.name == 'nt', 'Native launcher smoke requires Windows'
    executable = args.exe.resolve(strict=True)
    assert executable.is_file(), executable
    state = RunState(capture_window=args.capture_window)
    try:
        with sync_playwright() as playwright:
            native.run_case(playwright, executable, [], state.prime)
            if not args.settings_only:
                state.seed_first_enable()
                native.run_case(playwright, executable, [], state.scenario)
                native.run_case(playwright, executable, [], state.restart)
                state.seed_first_enable()
                native.run_case(playwright, executable, [], state.occupied_default)
                native.run_case(playwright, executable, [], state.restart)
            native.run_case(playwright, executable, [], state.settings_routes)
    finally:
        # run_case has already stopped each launched child before this point.
        state.restore()
    print('PASS: real settings DOM activation routes' if args.settings_only else
          'PASS: classic-to-space with preserved palette/tools, occupied default with warning and button-show, real settings DOM activation, hidden startup/show, sessions/fallback, previews, Esc, pins, shortcut clearing/restart, classic/disabled exclusion', flush=True)
    print(f'Launcher artifacts: {state.artifacts}', flush=True)
    print('Global keyboard injection was intentionally not used; native shortcut bindings were verified through the registry.', flush=True)


if __name__ == '__main__':
    main()
