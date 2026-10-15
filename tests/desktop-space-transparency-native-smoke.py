"""Compare actual Windows screen pixels with and without the desktop WebView.

Uses an isolated executable identifier. The existing desktop wallpaper/icons are
never changed. Explorer's MinimizeAll/UndoMinimizeALL exposes the desktop briefly
and is restored in finally. Screenshots are GDI screen captures, not CDP PNGs.
"""

import argparse
import ctypes
from ctypes import wintypes
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

from PIL import ImageGrab, ImageChops, ImageStat
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('desktop_native', ROOT / 'tests/desktop-space-native-smoke.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
ARTIFACTS = Path(tempfile.mkdtemp(prefix='dtkit-screen-transparency-'))
USER = ctypes.WinDLL('user32', use_last_error=True)
USER.GetForegroundWindow.restype = wintypes.HWND
INITIAL_FOREGROUND = USER.GetForegroundWindow()


def shell_desktop(action):
    subprocess.run(['powershell', '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
                    f'(New-Object -ComObject Shell.Application).{action}()'], check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW)


def capture(name, bounds):
    image = ImageGrab.grab(bbox=tuple(bounds), all_screens=True)
    image.save(ARTIFACTS / f'{name}.png')
    return image


def screen_difference(desktop, baseline, bounds, name):
    native.settle(desktop)
    empty=capture(name,bounds)
    difference=ImageChops.difference(baseline.convert('RGB'),empty.convert('RGB'))
    surfaces=desktop.evaluate('''Array.from(document.querySelectorAll('.space-block,.space-zone,.space-drawer-handle,.space-drawer,.desktop-tools,.space-shelf-rail,.space-shelf-panel')).map(node=>{
        const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height];
    }).filter(r=>r[2]>1&&r[3]>1)''')
    scale=desktop.evaluate('devicePixelRatio')
    samples=[]
    for x,y,width,height in surfaces:
        rect=(round(x*scale),round(y*scale),round((x+width)*scale),round((y+height)*scale))
        samples.append({'rect':rect,'meanDifference':ImageStat.Stat(difference.crop(rect)).mean})
    assert samples, 'No actual desktop furniture was measured'
    assert all(max(sample['meanDifference'])<2 for sample in samples), (name,samples)
    return samples


def z_order(windows):
    result=[]
    @windows.callback
    def callback(hwnd,_):
        result.append(int(hwnd))
        return True
    windows.user.EnumWindows(callback,0)
    return result


def check_desktop_layering(main,desktop,windows,process,host,bounds):
    user=windows.user
    desktop.evaluate('document.querySelector("[data-layout-choice=zones]").click()')
    native.helpers.wait_until(lambda:desktop.locator('#desktopSpaceView').get_attribute('data-layout')=='zones')
    native.settle(desktop)
    main_hwnd=next(hwnd for hwnd in windows.owned(process) if windows.name(hwnd,'title')=='DtKit')
    main.evaluate('window.__TAURI__.window.getCurrentWindow().show()')
    desktop.evaluate('document.getElementById("panel").style.opacity="1"')
    desktop.wait_for_timeout(250)
    user.SetWindowPos.argtypes=[wintypes.HWND,wintypes.HWND,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,wintypes.UINT]
    user.SetWindowPos(main_hwnd,wintypes.HWND(0),0,0,0,0,0x0001|0x0002)
    order=z_order(windows)
    assert order.index(main_hwnd)<order.index(host), 'Desktop furniture is above an application window'
    # This is the exact promotion sent when a window is clicked/activated.
    user.SetWindowPos(host,wintypes.HWND(0),0,0,0,0,0x0001|0x0002)
    order=z_order(windows)
    assert order.index(main_hwnd)<order.index(host), 'Activation lifted the desktop above an application'
    user.WindowFromPoint.argtypes=[wintypes.POINT]
    user.WindowFromPoint.restype=wintypes.HWND
    user.GetAncestor.argtypes=[wintypes.HWND,wintypes.UINT]
    user.GetAncestor.restype=wintypes.HWND
    main_rect=windows.rect(main_hwnd)
    point=wintypes.POINT((main_rect[0]+main_rect[2])//2,(main_rect[1]+main_rect[3])//2)
    assert user.GetAncestor(user.WindowFromPoint(point),2)==main_hwnd, 'An application cannot cover the desktop layer'
    overlaps=[]
    for box in desktop.locator('.space-zone').evaluate_all('nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})'):
        scale=desktop.evaluate('devicePixelRatio')
        left=max(main_rect[0],round(box[0]*scale)+bounds[0])
        top=max(main_rect[1],round(box[1]*scale)+bounds[1])
        right=min(main_rect[2],round((box[0]+box[2])*scale)+bounds[0])
        bottom=min(main_rect[3],round((box[1]+box[3])*scale)+bounds[1])
        if right-left>20 and bottom-top>20:
            overlaps.append(wintypes.POINT((left+right)//2,(top+bottom)//2))
    assert overlaps, 'The application did not overlap a real desktop control'
    assert all(user.GetAncestor(user.WindowFromPoint(point),2)==main_hwnd for point in overlaps), 'A desktop control covered the foreground application'
    capture('application-covers-desktop',bounds)
    # ToggleDesktop follows the same Explorer path as Win+D without synthesizing
    # shortcuts into an unknown foreground app. Always toggle back in finally.
    toggled=False
    try:
        shell_desktop('ToggleDesktop')
        toggled=True
        desktop.wait_for_timeout(500)
        assert user.IsWindowVisible(host), 'Win+D hid the permanent desktop furniture'
        assert native.mode_is(desktop,'space',True,False)
        capture('show-desktop',bounds)
    finally:
        if toggled:
            shell_desktop('ToggleDesktop')
    main.evaluate('window.__TAURI__.window.getCurrentWindow().hide()')
    if INITIAL_FOREGROUND and user.IsWindow(INITIAL_FOREGROUND):
        user.ShowWindow(INITIAL_FOREGROUND,6)
    desktop.wait_for_timeout(250)
    blank=user.WindowFromPoint(wintypes.POINT(bounds[0]+100,bounds[1]+700))
    assert windows.name(blank)=='SysListView32', ('Blank wallpaper did not reach Explorer',windows.name(blank))
    assert windows.icon_visibility(), 'Explorer icons lost their native surface'


def check_real_editor_keyboard(desktop,windows,host):
    user=windows.user
    user.SetCursorPos.argtypes=[ctypes.c_int,ctypes.c_int]
    user.GetCursorPos.argtypes=[ctypes.POINTER(wintypes.POINT)]
    user.mouse_event.argtypes=[wintypes.DWORD,wintypes.DWORD,wintypes.DWORD,wintypes.DWORD,ctypes.c_size_t]
    user.keybd_event.argtypes=[ctypes.c_ubyte,ctypes.c_ubyte,wintypes.DWORD,ctypes.c_size_t]
    user.GetForegroundWindow.restype=wintypes.HWND
    original=wintypes.POINT()
    user.GetCursorPos(ctypes.byref(original))
    def click(locator,right=False):
        box=locator.bounding_box()
        scale=desktop.evaluate('devicePixelRatio')
        user.SetCursorPos(round((box['x']+box['width']/2)*scale),round((box['y']+box['height']/2)*scale))
        user.mouse_event(0x0008 if right else 0x0002,0,0,0,0)
        user.mouse_event(0x0010 if right else 0x0004,0,0,0,0)
    try:
        desktop.evaluate('document.querySelector("[data-layout-choice=islands]").click()')
        native.helpers.wait_until(lambda:desktop.locator('#desktopSpaceView').get_attribute('data-layout')=='islands')
        native.settle(desktop)
        click(desktop.locator('.space-folder-shell').first,right=True)
        desktop.locator('[data-space-edit]').wait_for(state='visible')
        click(desktop.locator('[data-space-edit]'))
        field=desktop.locator('#spaceEditorName')
        field.wait_for(state='visible')
        native.settle(desktop)
        click(field)
        assert user.GetForegroundWindow()==host, 'Desktop editor did not receive actual Windows keyboard focus'
        before=field.input_value()
        user.keybd_event(0x58,0,0,0)
        user.keybd_event(0x58,0,2,0)
        native.helpers.wait_until(lambda:field.input_value()!=before)
        capture('actual-mouse-keyboard-editor',windows.rect(host))
        click(desktop.locator('.space-editor-actions [data-space-editor-cancel]'))
        desktop.locator('.space-editor').wait_for(state='hidden')
    finally:
        user.SetCursorPos(original.x,original.y)


def scenario(main, context, process):
    windows = native.DesktopWindows()
    initial_icons = windows.icon_visibility()
    # Verify isolation before touching even the launched application's own mode.
    storage = native.invoke(main, 'get_storage_layout')['root']
    assert native.helpers.IDENTIFIER in storage, storage
    main.locator('[data-view="settings"]').click()
    main.locator('.settings-side-nav__item[href="#configSection"]').click()
    main.locator('#desktopOrganizerToggle').uncheck(force=True)
    native.choose(main,'presentation','space')
    native.choose(main,'layout','islands')
    native.choose(main,'appearance','warm')
    native.helpers.wait_until(lambda:not native.invoke(main,'get_desktop_organizer_mode')['enabled'])
    exposed = False
    try:
        main.evaluate('window.__TAURI__.window.getCurrentWindow().hide()')
        shell_desktop('MinimizeAll')
        exposed = True
        if INITIAL_FOREGROUND and windows.user.IsWindow(INITIAL_FOREGROUND) and windows.pid(INITIAL_FOREGROUND) != process.pid:
            windows.user.ShowWindow(INITIAL_FOREGROUND,6)
        main.wait_for_timeout(600)
        baseline_full = ImageGrab.grab(all_screens=True)
        main.evaluate('document.getElementById("desktopOrganizerToggle").click()')
        native.helpers.wait_until(lambda:main.locator('#confirmDesktopOrganizer').is_visible())
        main.evaluate('document.getElementById("confirmDesktopOrganizer").click()')
        native.helpers.wait_until(lambda:native.mode_is(main,'space',True,False))
        desktop = native.space_page(main, context)
        native.settle(desktop)
        hosts=[hwnd for hwnd in windows.owned(process)
               if windows.name(windows.user.GetParent(hwnd)) in ('WorkerW','Progman')
               and windows.name(hwnd,'title') == '桌面空间']
        assert len(hosts) == 1, hosts
        host=hosts[0]
        bounds = windows.rect(host)
        desktop.wait_for_timeout(300)
        origin_x,origin_y=windows.user.GetSystemMetrics(76),windows.user.GetSystemMetrics(77)
        crop = baseline_full.crop((bounds[0]-origin_x,bounds[1]-origin_y,bounds[2]-origin_x,bounds[3]-origin_y))
        crop.save(ARTIFACTS / 'baseline.png')
        capture('visible', bounds)
        desktop.evaluate('document.getElementById("panel").style.opacity = "0"')
        desktop.wait_for_timeout(450)
        empty = capture('empty-alpha', bounds)
        difference = ImageChops.difference(crop.convert('RGB'), empty.convert('RGB'))
        difference.save(ARTIFACTS / 'difference.png')
        regions = desktop.evaluate('''Array.from(document.querySelectorAll('.space-block,.desktop-tools')).map(node => {
            const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height];
        })''')
        scale = desktop.evaluate('devicePixelRatio')
        samples = []
        for x, y, width, height in regions:
            rect = (round(x*scale),round(y*scale),round((x+width)*scale),round((y+height)*scale))
            piece = difference.crop(rect)
            samples.append({'rect':rect, 'meanDifference':ImageStat.Stat(piece).mean,
                            'emptyMean':ImageStat.Stat(empty.crop(rect)).mean,
                            'wallpaperMean':ImageStat.Stat(crop.crop(rect)).mean})
        diagnostic = {'host':hex(host),'parent':hex(windows.user.GetParent(host)),
                      'parentClass':windows.name(windows.user.GetParent(host)),
                      'style':hex(windows.user.GetWindowLongPtrW(host,-16)),
                      'extendedStyle':hex(windows.user.GetWindowLongPtrW(host,-20)),
                      'bounds':bounds,'samples':samples}
        (ARTIFACTS / 'diagnostic.json').write_text(json.dumps(diagnostic,indent=2),encoding='utf-8')
        print(f"Actual native alpha sample max difference: {max(max(sample['meanDifference']) for sample in samples):.3f}",flush=True)
        assert windows.icon_visibility() == initial_icons, 'Desktop space changed original icon visibility'
        assert all(max(sample['meanDifference']) < 2 for sample in samples), 'Transparent WebView does not preserve real desktop pixels'
        # Cover every layout/material combination through the actual persisted UI
        # choices rather than rewriting a class and bypassing its transition.
        for appearance in ['warm','liquid']:
            desktop.evaluate('value=>document.querySelector(`[data-appearance-choice="${value}"]`).click()',appearance)
            native.helpers.wait_until(lambda:desktop.locator('#desktopSpaceView').get_attribute('data-appearance')==appearance)
            for layout in ['shelf','islands','zones','drawer']:
                desktop.evaluate('value=>document.querySelector(`[data-layout-choice="${value}"]`).click()',layout)
                native.helpers.wait_until(lambda:desktop.locator('#desktopSpaceView').get_attribute('data-layout')==layout)
                screen_difference(desktop,crop,bounds,f'empty-{appearance}-{layout}')
        check_desktop_layering(main,desktop,windows,process,host,bounds)
        check_real_editor_keyboard(desktop,windows,host)
    finally:
        try:
            if process.poll() is None and not main.is_closed():
                native.invoke(main, 'set_desktop_organizer_mode', {'enabled': False, 'presentation': 'classic'})
        finally:
            if exposed:
                shell_desktop('UndoMinimizeALL')
                if INITIAL_FOREGROUND and windows.user.IsWindow(INITIAL_FOREGROUND):
                    windows.user.ShowWindow(INITIAL_FOREGROUND,9)
    print(f'Actual screen alpha compositing passed; artifacts={ARTIFACTS}',flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe',type=Path,required=True)
    args=parser.parse_args()
    executable=args.exe.resolve()
    print(f'Screen artifacts={ARTIFACTS}',flush=True)
    with sync_playwright() as playwright:
        native.helpers.run_case(playwright,executable,[],scenario)
