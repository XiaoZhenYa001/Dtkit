"""Verify desktop-space hosting in a real, isolated Windows WebView2 build.

Build: npm run build
  npm run tauri build -- --debug --no-bundle --config tests/native-webview.config.json
Run: python tests/desktop-space-native-smoke.py --exe src-tauri/target/debug/DtKit.exe

The shared helper rejects production storage before any action. Window inspection
is restricted to the launched test PID. Dragging only changes an isolated UI order;
no desktop files are created, renamed, moved, deleted, or opened. Desktop icon
visibility is observed throughout and must remain exactly as the user set it.
"""

import argparse
import ctypes
from ctypes import wintypes
import importlib.util
import os
from pathlib import Path
import tempfile

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_smoke_helpers', ROOT / 'tests/native-webview-ui-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
ARTIFACTS = Path(tempfile.mkdtemp(prefix='dtkit-desktop-space-native-'))
INITIAL_ICON_VISIBILITY = {}

WS_CHILD = 0x40000000
WS_POPUP = 0x80000000
WS_EX_TOPMOST = 0x00000008
WS_EX_APPWINDOW = 0x00040000
GWL_STYLE = -16
GWL_EXSTYLE = -20
SW_HIDE = 0
SW_SHOWNA = 8


class DesktopWindows:
    """Read host/region state through Win32 without relying on application reports."""

    def __init__(self):
        assert os.name == 'nt', 'This smoke test requires Windows and Explorer'
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.gdi = ctypes.WinDLL('gdi32', use_last_error=True)
        if hasattr(self.user, 'SetThreadDpiAwarenessContext'):
            self.user.SetThreadDpiAwarenessContext.argtypes = [wintypes.HANDLE]
            self.user.SetThreadDpiAwarenessContext.restype = wintypes.HANDLE
            self.user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        self.callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        self.user.EnumWindows.argtypes = [self.callback, wintypes.LPARAM]
        self.user.EnumChildWindows.argtypes = [wintypes.HWND, self.callback, wintypes.LPARAM]
        self.user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user.GetParent.argtypes = [wintypes.HWND]
        self.user.GetParent.restype = wintypes.HWND
        self.user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.user.IsWindowVisible.argtypes = [wintypes.HWND]
        self.user.IsWindow.argtypes = [wintypes.HWND]
        self.user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        self.user.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self.user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self.user.GetWindowRgn.argtypes = [wintypes.HWND, wintypes.HANDLE]
        self.user.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user.GetWindowLongPtrW.restype = ctypes.c_ssize_t
        self.gdi.CreateRectRgn.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
        self.gdi.CreateRectRgn.restype = wintypes.HANDLE
        self.gdi.GetRgnBox.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.RECT)]
        self.gdi.PtInRegion.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_int]
        self.gdi.DeleteObject.argtypes = [wintypes.HANDLE]

    def windows(self):
        result = set()

        @self.callback
        def child(hwnd, _):
            result.add(int(hwnd))
            return True

        @self.callback
        def parent(hwnd, _):
            result.add(int(hwnd))
            self.user.EnumChildWindows(hwnd, child, 0)
            return True

        self.user.EnumWindows(parent, 0)
        return result

    def pid(self, hwnd):
        value = wintypes.DWORD()
        self.user.GetWindowThreadProcessId(hwnd, ctypes.byref(value))
        return value.value

    def name(self, hwnd, kind='class'):
        value = ctypes.create_unicode_buffer(1024)
        call = self.user.GetClassNameW if kind == 'class' else self.user.GetWindowTextW
        call(hwnd, value, len(value))
        return value.value

    def rect(self, hwnd, client=False):
        value = wintypes.RECT()
        call = self.user.GetClientRect if client else self.user.GetWindowRect
        assert call(hwnd, ctypes.byref(value)), ctypes.get_last_error()
        return [value.left, value.top, value.right, value.bottom]

    def owned(self, process):
        return [hwnd for hwnd in self.windows() if self.pid(hwnd) == process.pid]

    def desktop_host(self, process):
        candidates = [hwnd for hwnd in self.owned(process)
                      if self.name(self.user.GetParent(hwnd)) in ('WorkerW', 'Progman')
                      and self.name(hwnd, 'title') == '桌面空间'
                      and not self.user.GetWindowLongPtrW(hwnd, GWL_STYLE) & WS_CHILD]
        assert len(candidates) == 1, [(hex(hwnd), self.name(hwnd, 'title')) for hwnd in candidates]
        return candidates[0]

    def icon_lists(self):
        return [hwnd for hwnd in self.windows() if self.name(hwnd) == 'SysListView32'
                and self.name(self.user.GetParent(hwnd)) == 'SHELLDLL_DefView']

    def icon_visibility(self):
        return {hwnd: bool(self.user.IsWindowVisible(hwnd)) for hwnd in self.icon_lists()}

    def restore_icons(self, baseline):
        # Avoid touching an unrelated list view. Explorer may recreate the desktop
        # handle during the test; only its SHELLDLL_DefView icon child is eligible.
        current = self.icon_lists()
        old_values = set(baseline.values())
        for hwnd in current:
            expected = baseline.get(hwnd)
            if expected is None and len(old_values) == 1:
                expected = next(iter(old_values))
            if expected is not None and bool(self.user.IsWindowVisible(hwnd)) != expected:
                self.user.ShowWindow(hwnd, SW_SHOWNA if expected else SW_HIDE)

    def check_host(self, process):
        hwnd = self.desktop_host(process)
        assert self.user.IsWindowVisible(hwnd), 'Desktop surface is hidden'
        style = self.user.GetWindowLongPtrW(hwnd, GWL_STYLE)
        extended = self.user.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
        assert not style & WS_CHILD and style & WS_POPUP, f'Desktop host is not a transparent top-level surface: {style:#x}'
        assert not style & 0x00CF0000, f'Desktop host still has a native caption/frame: {style:#x}'
        assert not extended & 0x00000301, f'Desktop host still has a native raised edge: {extended:#x}'
        assert not extended & WS_EX_TOPMOST, f'Desktop host floats over applications: {extended:#x}'
        assert not extended & WS_EX_APPWINDOW, f'Desktop host has a taskbar entry: {extended:#x}'
        return hwnd

    def check_shape(self, process, page):
        hwnd = self.check_host(process)
        region = self.gdi.CreateRectRgn(0, 0, 0, 0)
        try:
            kind = self.user.GetWindowRgn(hwnd, region)
            assert kind in (2, 3), f'Desktop child must have a nonempty native window region: {kind}'
            bounds = self.rect(hwnd, client=True)
            viewport = page.evaluate('[innerWidth, innerHeight]')
            scale = [(bounds[2] - bounds[0]) / viewport[0], (bounds[3] - bounds[1]) / viewport[1]]
            rectangles = page.locator('[data-desktop-interactive]').evaluate_all('''nodes => nodes.flatMap(node => {
                if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return [];
                const box = node.getBoundingClientRect();
                return box.width > 0 && box.height > 0
                    ? [{x:box.x, y:box.y, width:box.width, height:box.height}] : [];
            })''')
            assert rectangles, 'No real desktop interaction regions were reported by the UI'
            for box in rectangles:
                x = round((box['x'] + box['width'] / 2) * scale[0])
                y = round((box['y'] + box['height'] / 2) * scale[1])
                if 0 <= x < bounds[2] and 0 <= y < bounds[3]:
                    assert self.gdi.PtInRegion(region, x, y), f'Interactive surface is outside native shape: {box}'
            blank_points = [(x * viewport[0], y * viewport[1])
                            for x in (0.02, 0.1, 0.25, 0.4, 0.5, 0.7, 0.95)
                            for y in (0.03, 0.15, 0.4, 0.7, 0.95)]
            # Require click-through space well outside the antialiased rounded edges.
            blanks = [(x, y) for x, y in blank_points if not any(
                box['x'] - 18 <= x <= box['x'] + box['width'] + 18
                and box['y'] - 18 <= y <= box['y'] + box['height'] + 18 for box in rectangles)]
            assert blanks, 'Desktop UI covers the entire wallpaper instead of leaving desktop space'
            for x, y in blanks:
                if self.gdi.PtInRegion(region, round(x * scale[0]), round(y * scale[1])):
                    print({'unexpectedPoint': [x, y], 'surfaces': rectangles, 'scale': scale, 'viewport': viewport,
                           'motions': page.locator('.space-motion-host,.space-motion-material').count(),
                           'moving': page.locator('.space-shelf-moving').count()}, flush=True)
                assert not self.gdi.PtInRegion(region, round(x * scale[0]), round(y * scale[1])), (
                    f'Blank wallpaper intercepts clicks: {(x, y)}')
            box = wintypes.RECT()
            self.gdi.GetRgnBox(region, ctypes.byref(box))
            return [box.left, box.top, box.right, box.bottom]
        finally:
            self.gdi.DeleteObject(region)


def invoke(page, command, args=None):
    return page.evaluate('''async ({command,args}) => Promise.race([
        window.__TAURI__.core.invoke(command,args || {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${command} timed out`)), 20000))
    ])''', {'command': command, 'args': args})


def choose(page, kind, value):
    page.locator(f'[data-organizer-{kind}="{value}"]').locator('xpath=..').click()


def space_page(main, context):
    def created():
        main.wait_for_timeout(50)
        return any(not page.is_closed() and 'host=desktop' in page.url for page in context.pages)
    helpers.wait_until(created)
    page = next(page for page in context.pages if not page.is_closed() and 'host=desktop' in page.url)
    page.set_default_timeout(20_000)
    return page


def settle(page):
    page.wait_for_timeout(550)
    assert page.locator('[data-presentation-ghost]').count() == 0


def mode_is(page, presentation, visible, hotzone):
    mode = invoke(page, 'get_desktop_organizer_mode')
    return (mode['enabled'] and mode['presentation'] == presentation
            and mode['desktopSpaceVisible'] == visible and mode['hotzoneRunning'] == hotzone)


def reorder_real_files(page):
    for grid in page.locator('.space-zone .space-file-grid').all():
        if grid.locator('[data-space-id]').count() < 2:
            continue
        grid.scroll_into_view_if_needed()
        grid.evaluate('node => { node.scrollTop = 0; }')
        files = grid.locator('[data-space-id]')
        before = files.evaluate_all('nodes => nodes.map(node => node.dataset.spaceId)')
        start, end = files.nth(1).bounding_box(), files.nth(0).bounding_box()
        if not start or not end:
            continue
        page.mouse.move(start['x'] + start['width'] / 2, start['y'] + start['height'] / 2)
        page.mouse.down()
        try:
            page.mouse.move(start['x'] + start['width'] / 2 + 12, start['y'] + start['height'] / 2, steps=5)
            page.mouse.move(end['x'] + end['width'] / 2, end['y'] + end['height'] / 2, steps=12)
            page.mouse.move(end['x'] + end['width'] / 2 + 1, end['y'] + end['height'] / 2, steps=2)
            page.locator('.space-drop-placeholder').wait_for(state='visible')
        finally:
            page.mouse.up()
        page.locator('.space-drop-placeholder').wait_for(state='hidden')
        after = files.evaluate_all('nodes => nodes.map(node => node.dataset.spaceId)')
        assert after == [before[1], before[0], *before[2:]], (before, after)
        print('Real WebView2 HTML5 drag reordering passed without moving desktop files', flush=True)
        return
    print('No native group contains two files; drag check skipped', flush=True)


def scenario(main, context, process):
    windows = DesktopWindows()
    baseline_icons = INITIAL_ICON_VISIBILITY or windows.icon_visibility()
    assert baseline_icons, 'Explorer desktop icon list was not found'
    violation_messages = []
    page_errors = []

    def watch(page):
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        page.on('console', lambda message: violation_messages.append(message.text)
                if 'content security policy' in message.text.lower() and 'refused' in message.text.lower() else None)

    watch(main)
    context.on('page', watch)
    try:
        invoke(main, 'set_desktop_organizer_mode', {'enabled': False, 'presentation': 'classic'})
        main.locator('[data-view="settings"]').click()
        main.locator('.settings-side-nav__item[href="#configSection"]').click()
        choose(main, 'presentation', 'space')
        choose(main, 'layout', 'zones')
        choose(main, 'appearance', 'liquid')
        # Use the user-facing switch so mode switching later also verifies that
        # settings and the native persisted lifecycle agree on enablement.
        main.locator('#desktopOrganizerToggle').check(force=True)
        if main.locator('#confirmDesktopOrganizer').is_visible():
            main.locator('#confirmDesktopOrganizer').click()
        desktop = space_page(main, context)
        expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-layout', 'zones')
        expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-appearance', 'liquid')
        helpers.wait_until(lambda: mode_is(main, 'space', True, False))
        settle(desktop)
        host = windows.check_host(process)
        native_geometry = windows.rect(host)
        windows.check_shape(process, desktop)
        mode = invoke(main, 'get_desktop_organizer_mode')
        assert mode['configured'] is True
        assert mode['iconsHidden'] is False
        assert windows.icon_visibility() == baseline_icons, 'Enabling space changed the user desktop icon visibility'
        assert desktop.evaluate(r'''[document.documentElement,document.body].every(node => {
            const color = getComputedStyle(node).backgroundColor;
            return color === 'transparent' || /rgba\([^)]*,\s*0\s*\)/.test(color);
        })'''), 'Desktop-space has an opaque application background'
        assert desktop.locator('.organizer-header:visible, .status-bar:visible, #dragHandle:visible, .resize-handle:visible').count() == 0
        assert not any('desktop-organizer' in page.url and 'host=desktop' not in page.url
                       and page.evaluate('document.visibilityState === "visible"') for page in context.pages)

        files_before = invoke(desktop, 'desktop_scan')
        native_paths = {file['path'] for key, group in files_before.items()
                        if isinstance(group, list) and key != 'recent' for file in group}
        displayed_paths = set(desktop.locator('.space-file[data-path]').evaluate_all('nodes => nodes.map(node => node.dataset.path)'))
        assert displayed_paths.issubset(native_paths), 'Desktop-space renders sample files instead of the native index'
        if native_paths:
            assert displayed_paths, 'Real desktop index is not visible'
        reorder_real_files(desktop)
        files_after = invoke(desktop, 'desktop_scan')
        assert {file['path'] for key, group in files_after.items()
                if isinstance(group, list) and key != 'recent' for file in group} == native_paths
        desktop.screenshot(path=str(ARTIFACTS / 'desktop-zones.png'))

        for layout in ('islands', 'drawer', 'zones', 'islands'):
            choose(main, 'layout', layout)
            expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-layout', layout)
            settle(desktop)
            assert windows.rect(windows.check_host(process)) == native_geometry
            windows.check_shape(process, desktop)
            assert windows.icon_visibility() == baseline_icons, 'A layout change altered desktop icons'
        choose(main, 'appearance', 'warm')
        expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-appearance', 'warm')
        settle(desktop)
        desktop.reload(wait_until='networkidle')
        expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-layout', 'islands')
        expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-appearance', 'warm')
        helpers.wait_until(lambda: mode_is(main, 'space', True, False))
        settle(desktop)
        windows.check_shape(process, desktop)
        desktop.screenshot(path=str(ARTIFACTS / 'desktop-islands.png'))

        # The new shelf uses the same real index on the Explorer desktop.
        choose(main, 'layout', 'shelf')
        expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-layout', 'shelf')
        settle(desktop)
        rail = desktop.locator('.space-shelf-rail').first
        expect(rail).to_be_visible()
        windows.check_shape(process, desktop)
        tab = rail.locator('.space-shelf-tab').first
        tab.click()
        panel = desktop.locator('.space-shelf-panel').first
        expect(panel).to_be_visible()
        settle(desktop)
        windows.check_shape(process, desktop)
        assert set(panel.locator('.space-file[data-path]').evaluate_all('nodes => nodes.map(node => node.dataset.path)')).issubset(native_paths)
        old = rail.bounding_box()
        grip = rail.locator('.space-shelf-grip').bounding_box()
        x, y = grip['x'] + grip['width'] / 2, grip['y'] + grip['height'] / 2
        desktop.mouse.move(x, y)
        desktop.mouse.down()
        desktop.mouse.move(x + 70, y - 110, steps=20)
        desktop.mouse.up()
        settle(desktop)
        moved = rail.bounding_box()
        assert abs(moved['x'] - old['x'] - 70) < 3 and abs(moved['y'] - old['y'] + 110) < 3
        windows.check_shape(process, desktop)
        desktop.reload(wait_until='networkidle')
        settle(desktop)
        restored = desktop.locator('.space-shelf-rail').first.bounding_box()
        assert abs(restored['x'] - moved['x']) < 3 and abs(restored['y'] - moved['y']) < 3
        viewport = invoke(desktop, 'desktop_space_ready')
        assert viewport['displays'] and all(area['width'] > 0 and area['height'] > 0 for area in viewport['displays'])
        assert windows.icon_visibility() == baseline_icons
        desktop.screenshot(path=str(ARTIFACTS / 'desktop-shelf.png'))

        choose(main, 'layout', 'drawer')
        expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-layout', 'drawer')
        settle(desktop)
        baseline_scroll = desktop.evaluate('[scrollX,scrollY]')
        closed_shape = windows.check_shape(process, desktop)
        for _ in range(2):
            desktop.locator('.space-drawer-handle').click()
            desktop.locator('.space-drawer').wait_for(state='visible')
            settle(desktop)
            opened_shape = windows.check_shape(process, desktop)
            assert opened_shape != closed_shape, 'Drawer did not extend the native hit region'
            assert desktop.evaluate('[scrollX,scrollY]') == baseline_scroll
            desktop.locator('.space-drawer [data-space-close]').click()
            desktop.locator('.space-drawer').wait_for(state='hidden')
            settle(desktop)
            assert windows.check_shape(process, desktop) == closed_shape
        desktop.screenshot(path=str(ARTIFACTS / 'desktop-drawer.png'))

        # Closing the main window to the tray must not destroy the desktop layer.
        invoke(main, 'set_minimize_mode', {'mode': 'standard'})
        main_hwnd = next(hwnd for hwnd in windows.owned(process) if windows.name(hwnd, 'title') == 'DtKit')
        assert windows.user.PostMessageW(main_hwnd, 0x0010, 0, 0)
        helpers.wait_until(lambda: not windows.user.IsWindowVisible(main_hwnd))
        assert mode_is(desktop, 'space', True, False)
        windows.check_host(process)
        invoke(desktop, 'release_idle_resources')
        assert mode_is(desktop, 'space', True, False), 'Idle cleanup removed the desktop surface'
        main.evaluate('window.__TAURI__.window.getCurrentWindow().show()')

        choose(main, 'presentation', 'classic')
        helpers.wait_until(lambda: mode_is(main, 'classic', False, True))
        assert all(windows.icon_visibility().get(hwnd) == visible for hwnd, visible in baseline_icons.items()
                   if windows.user.IsWindow(hwnd)), 'Classic mode changed original icon visibility'
        assert not any(windows.name(windows.user.GetParent(hwnd)) in ('WorkerW', 'Progman')
                       and windows.user.IsWindowVisible(hwnd) for hwnd in windows.owned(process))
        invoke(main, 'toggle_desktop_organizer', {'show': True})
        helpers.wait_until(lambda: any('desktop-organizer' in page.url and 'host=desktop' not in page.url
                                      and page.evaluate('document.visibilityState === "visible"') for page in context.pages))
        classic = next(page for page in context.pages if 'desktop-organizer' in page.url and 'host=desktop' not in page.url)
        expect(classic.locator('#categoryList')).to_be_visible()
        choose(main, 'presentation', 'space')
        helpers.wait_until(lambda: mode_is(main, 'space', True, False))
        desktop = space_page(main, context)
        expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-layout', 'drawer')
        expect(desktop.locator('#desktopSpaceView')).to_have_attribute('data-appearance', 'warm')
        settle(desktop)
        windows.check_shape(process, desktop)
        if not classic.is_closed():
            assert not any(windows.user.IsWindowVisible(hwnd) for hwnd in windows.owned(process)
                           if windows.name(hwnd, 'title') == '桌面整理')
        main.screenshot(path=str(ARTIFACTS / 'settings.png'))
        assert not violation_messages, violation_messages
        assert not page_errors, page_errors
        assert windows.icon_visibility() == baseline_icons, 'Space mode changed desktop icons after switching back'
        print('Explorer parent, hit shape, mode exclusivity, unchanged icons, tray lifecycle and persisted choices passed', flush=True)
    finally:
        if page_errors or violation_messages:
            print(f'Desktop runtime errors: {page_errors}; CSP: {violation_messages}', flush=True)
        try:
            cleanup_page = next((page for page in context.pages if not page.is_closed()), None)
            if cleanup_page:
                invoke(cleanup_page, 'set_desktop_organizer_mode', {'enabled': False, 'presentation': 'classic'})
        finally:
            assert windows.icon_visibility() == baseline_icons, 'Disabling space changed desktop icons'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    executable = parser.parse_args().exe.resolve()
    assert executable.is_file(), executable
    windows = DesktopWindows()
    initial_icons = windows.icon_visibility()
    INITIAL_ICON_VISIBILITY = initial_icons
    try:
        with sync_playwright() as playwright:
            helpers.run_case(playwright, executable, [], scenario)
    finally:
        assert windows.icon_visibility() == initial_icons, 'Native test changed desktop icon visibility'
    print(f'Real Windows desktop-space smoke passed; screenshots={ARTIFACTS}', flush=True)
