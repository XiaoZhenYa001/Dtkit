"""Verify whole-window classic sidebar fades, reversals and saved geometry.

Uses the exact isolated native-smoke application, restores its known config
files, creates no desktop files and only terminates the shared harness child.
"""
import argparse
import ctypes
from ctypes import wintypes
import importlib.util
from pathlib import Path
import time
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('classic_native_helpers',ROOT/'tests/desktop-launcher-native-smoke.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)


class ClassicWindow:
    def __init__(self,process):
        self.process=process
        self.user=ctypes.WinDLL('user32',use_last_error=True)
        self.user.SetThreadDpiAwarenessContext.argtypes=[ctypes.c_void_p]
        self.user.SetThreadDpiAwarenessContext.restype=ctypes.c_void_p
        self.user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        self.callback=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
        self.user.EnumWindows.argtypes=[self.callback,wintypes.LPARAM]
        self.user.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]
        self.user.GetWindowTextW.argtypes=[wintypes.HWND,wintypes.LPWSTR,ctypes.c_int]
        self.user.IsWindowVisible.argtypes=[wintypes.HWND]
        self.user.GetWindowRect.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.RECT)]
        self.user.GetLayeredWindowAttributes.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD),ctypes.POINTER(wintypes.BYTE),ctypes.POINTER(wintypes.DWORD)]

    def find(self):
        matches=[]
        @self.callback
        def visit(hwnd,_):
            pid=wintypes.DWORD();self.user.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
            title=ctypes.create_unicode_buffer(256);self.user.GetWindowTextW(hwnd,title,256)
            if pid.value==self.process.pid and title.value=='桌面整理':matches.append(hwnd)
            return True
        self.user.EnumWindows(visit,0)
        return matches[0] if matches else None

    def sample(self):
        hwnd=self.find()
        if hwnd is None:return None
        rect=wintypes.RECT();self.user.GetWindowRect(hwnd,ctypes.byref(rect))
        color=wintypes.DWORD();alpha=wintypes.BYTE();flags=wintypes.DWORD()
        layered=self.user.GetLayeredWindowAttributes(hwnd,ctypes.byref(color),ctypes.byref(alpha),ctypes.byref(flags))
        return {'visible':bool(self.user.IsWindowVisible(hwnd)),'alpha':alpha.value if layered else None,
                'rect':(rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top)}

    def frames(self,milliseconds=400):
        start=time.monotonic();samples=[]
        while (time.monotonic()-start)*1000<milliseconds:
            current=self.sample()
            if current:samples.append(((time.monotonic()-start)*1000,current))
            time.sleep(.006)
        return samples


def scenario(seed,context,process):
    main=h.main_page(seed,context)
    config=h.check_isolation(main)
    backups={name:(config/name).read_bytes() if (config/name).exists() else None for name in h.CONFIG_NAMES}
    local_keys=['dtkit_desktop_organizer','desktopOrganizerPrefs']
    local_backup=main.evaluate('keys=>Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)]))',local_keys)
    try:
        h.invoke(main,'set_desktop_organizer_mode',enabled=True,presentation='classic')
        h.invoke(main,'stop_hotzone')
        main.evaluate("localStorage.setItem('dtkit_desktop_organizer',JSON.stringify({enabled:true,presentation:'classic',reducedMotion:false}));localStorage.setItem('desktopOrganizerPrefs',JSON.stringify({width:620,height:470,positionX:150,expandedCategories:['recent']}))")
        h.invoke(main,'set_classic_motion_preferences',reducedMotion=False)
        h.invoke(main,'toggle_desktop_organizer',show=True)
        windows=ClassicWindow(process)
        entering=windows.frames(700)
        h.native.wait_until(lambda:windows.sample() and windows.sample()['visible'] and windows.sample()['alpha']==255)
        baseline=windows.sample()['rect']
        assert baseline[0]==150 and baseline[2:]==(620,470),baseline
        assert any(0<frame['alpha']<255 for _,frame in entering if frame['alpha'] is not None),entering
        assert any(frame['rect'][1]<baseline[1] for _,frame in entering),entering
        h.invoke(main,'toggle_desktop_organizer',show=False)
        exiting=windows.frames(300)
        assert any(frame['visible'] and 0<frame['alpha']<255 for _,frame in exiting if frame['alpha'] is not None),exiting
        assert not windows.sample()['visible'] and windows.sample()['rect']==baseline,windows.sample()
        print('PASS: complete native sidebar fades/slides in and out; initial saved geometry survives first animation',flush=True)

        h.invoke(main,'toggle_desktop_organizer',show=True)
        h.native.wait_until(lambda:windows.sample()['alpha']==255)
        h.invoke(main,'toggle_desktop_organizer',show=False)
        time.sleep(.045)
        mid=windows.sample()
        h.invoke(main,'toggle_desktop_organizer',show=True)
        reverse=windows.frames(300)
        assert mid['alpha']<255 and any(frame['alpha']>mid['alpha'] for _,frame in reverse),mid
        assert windows.sample()['visible'] and windows.sample()['rect']==baseline,windows.sample()
        print('PASS: quick close/open retargets from the current native opacity and restores the same resting rectangle',flush=True)

        organizer=next(page for page in context.pages if '/desktop-organizer/index.html' in page.url)
        cdp=context.new_cdp_session(organizer)
        cdp.send('Emulation.setScriptExecutionDisabled',{'value':True})
        try:
            h.invoke(main,'toggle_desktop_organizer',show=False)
            frozen=windows.frames(320)
            assert not windows.sample()['visible']
            assert any(frame['visible'] and 0<frame['alpha']<255 for _,frame in frozen),frozen
        finally:
            cdp.send('Emulation.setScriptExecutionDisabled',{'value':False});cdp.detach()
        h.invoke(main,'set_classic_motion_preferences',reducedMotion=True)
        h.invoke(main,'toggle_desktop_organizer',show=True)
        h.native.wait_until(lambda:windows.sample()['visible'] and windows.sample()['alpha']==255)
        reduced=windows.frames(80)
        assert all(frame['rect']==baseline and frame['alpha']==255 for _,frame in reduced),reduced
        h.invoke(main,'toggle_desktop_organizer',show=False)
        h.native.wait_until(lambda:not windows.sample()['visible'])
        print('PASS: exit finishes with renderer frozen; reduced motion skips displacement and intermediate opacity',flush=True)
        h.invoke(main,'stop_hotzone')
        h.invoke(main,'toggle_desktop_organizer',show=True)
        h.invoke(main,'set_desktop_organizer_mode',enabled=False,presentation='classic')
        cancelled=windows.frames(1700)
        assert not windows.sample()['visible'],windows.sample()
        assert not any(frame['visible'] for elapsed,frame in cancelled if elapsed>250),cancelled
        print('PASS: disabling classic during first-show readiness cancels the delayed native entrance',flush=True)
    finally:
        try:
            if not main.is_closed():
                main.evaluate('values=>Object.entries(values).forEach(([key,value])=>value===null?localStorage.removeItem(key):localStorage.setItem(key,value))',local_backup)
        finally:
            for name,data in backups.items():
                path=config/name
                if data is None:
                    if path.exists():path.unlink()
                else:path.write_bytes(data)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--exe',type=Path,required=True)
    args=parser.parse_args()
    with sync_playwright() as p:h.native.run_case(p,args.exe.resolve(strict=True),[],scenario)


if __name__=='__main__':main()
