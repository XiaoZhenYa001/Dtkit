"""Native caption/frame and outside dismissal regression with real mouse input.

Only the isolated executable's own windows and preferences are changed. Desktop
files and icon visibility are preserved, and MinimizeAll is undone in finally.
"""
import argparse
import ctypes
import importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('alpha_probe', ROOT / 'tests/desktop-space-transparency-native-smoke.py')
alpha = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alpha)


def drag_probe(main, desktop, windows, process, host, bounds):
    desktop.evaluate('document.getElementById("panel").style.opacity="1"')
    windows.user.SetForegroundWindow.argtypes=[alpha.wintypes.HWND]
    windows.user.SetForegroundWindow(host)
    windows.check_host(process)
    original=alpha.wintypes.POINT()
    windows.user.GetCursorPos(ctypes.byref(original))
    for layout, selector in [('shelf', '.space-shelf-grip'), ('islands', '.space-caption'), ('zones', '.space-zone-head')]:
        desktop.evaluate('value=>document.querySelector(`[data-layout-choice="${value}"]`).click()', layout)
        alpha.native.settle(desktop)
        alpha.capture(f'{layout}-before', bounds)
        box = desktop.locator(selector).first.bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        scale=desktop.evaluate('devicePixelRatio')
        user=windows.user
        user.SetCursorPos(round(bounds[0]+x*scale),round(bounds[1]+y*scale))
        user.mouse_event(0x0002,0,0,0,0)
        user.GetForegroundWindow.restype=alpha.wintypes.HWND
        desktop.wait_for_timeout(80)
        try:
            assert user.GetForegroundWindow()==host, 'Real drag did not focus the desktop host'
            for index in range(1,36):
                delta_y=24-y if layout=='shelf' else 65
                user.SetCursorPos(round(bounds[0]+(x-190*index/35)*scale),round(bounds[1]+(y+delta_y*index/35)*scale))
                desktop.wait_for_timeout(12)
            desktop.wait_for_timeout(130)
            alpha.capture(f'{layout}-moving', bounds)
            desktop.screenshot(path=str(alpha.ARTIFACTS / f'{layout}-dom.png'))
            windows.check_host(process)
        finally:
            user.mouse_event(0x0004,0,0,0,0)
        alpha.native.settle(desktop)
        alpha.capture(f'{layout}-after', bounds)
        windows.check_shape(process,desktop)
        if layout=='shelf':
            tab=desktop.locator('.space-shelf-tab').first
            tab.click()
            panel=desktop.locator('.space-shelf-panel').first
            alpha.native.settle(desktop)
            assert panel.is_visible()
            user.SetCursorPos(bounds[0]+1100,bounds[1]+600)
            user.mouse_event(0x0002,0,0,0,0);user.mouse_event(0x0004,0,0,0,0)
            desktop.wait_for_timeout(350)
            alpha.native.helpers.wait_until(lambda:not panel.is_visible())
            assert user.GetForegroundWindow()!=host,'Wallpaper did not receive the real outside click'
            dial=desktop.locator('#desktopToolsToggle')
            dial.click()
            alpha.native.settle(desktop)
            assert desktop.locator('#desktopToolActions').is_visible()
            desktop.keyboard.press('Escape')
            alpha.native.settle(desktop)
            assert not desktop.locator('#desktopToolActions').is_visible()
    windows.user.SetCursorPos(original.x,original.y)
    print(f'Native drag, frame and outside dismissal passed; screenshots={alpha.ARTIFACTS}',flush=True)


def scenario(main, context, process):
    native=alpha.native
    windows=native.DesktopWindows()
    native.invoke(main,'set_desktop_organizer_mode',{'enabled':False,'presentation':'space'})
    main.locator('[data-view="settings"]').click()
    main.locator('.settings-side-nav__item[href="#configSection"]').click()
    native.choose(main,'presentation','space')
    native.choose(main,'layout','shelf')
    native.choose(main,'appearance','liquid')
    native.helpers.wait_until(lambda:main.locator('[data-organizer-presentation="space"]').is_checked())
    main.locator('#desktopOrganizerToggle').check(force=True)
    if main.locator('#confirmDesktopOrganizer').is_visible():
        main.locator('#confirmDesktopOrganizer').click()
    desktop=native.space_page(main,context)
    native.helpers.wait_until(lambda:native.mode_is(main,'space',True,False))
    native.helpers.wait_until(lambda:desktop.evaluate('getComputedStyle(document.getElementById("panel")).opacity')=='1')
    native.settle(desktop)
    host=windows.desktop_host(process)
    bounds=windows.rect(host)
    main.evaluate('window.__TAURI__.window.getCurrentWindow().hide()')
    alpha.shell_desktop('MinimizeAll')
    original=alpha.wintypes.POINT()
    windows.user.GetCursorPos(ctypes.byref(original))
    try:
        icons=windows.icon_visibility()
        drag_probe(main,desktop,windows,process,host,bounds)
        assert windows.icon_visibility()==icons,'Original desktop icons changed during dragging'
    finally:
        windows.user.mouse_event(0x0004,0,0,0,0)
        native.invoke(main,'set_desktop_organizer_mode',{'enabled':False,'presentation':'classic'})
        alpha.shell_desktop('UndoMinimizeALL')
        windows.user.SetCursorPos(original.x,original.y)


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--exe',type=Path,required=True)
    args=parser.parse_args()
    with sync_playwright() as p:
        alpha.native.helpers.run_case(p,args.exe.resolve(),[],scenario)
