"""Real HWND regression: matching DPI-aware corners and no delayed glass plate.

Uses the existing isolated native-smoke identifier and restores its configuration.
No production process, system appearance setting, or desktop files are changed.
"""
import argparse
import ctypes
from ctypes import wintypes
import importlib.util
import math
from pathlib import Path
import time
from playwright.sync_api import sync_playwright
from native_glass_backdrop import NativeBackdrop

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('launcher_native',ROOT/'tests/desktop-launcher-native-smoke.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
OUT=ROOT/'tests/artifacts/desktop-surface'

def scenario(seed,context,process):
    main=h.main_page(seed,context);config=h.check_isolation(main)
    names=['desktop-organizer-mode.json','desktop-space-settings.json','tool-shortcuts.json']
    backups={name:(config/name).read_bytes() if (config/name).exists() else None for name in names}
    backdrop=None
    try:
        h.invoke(main,'set_desktop_organizer_mode',enabled=True,presentation='space')
        h.invoke(main,'update_desktop_space_settings',patch={'closeOnBlur':False})
        page=h.launcher_page(main,context);windows=h.NativeWindows()
        h.show(main,page,windows,process)
        page.wait_for_function("() => !document.querySelector('#launcher').classList.contains('is-moving')")
        hwnd=windows.find(process)
        assert not windows.user.GetWindowLongPtrW(hwnd,-16)&0x00c00000,'Native title bar must stay disabled'
        dwm=ctypes.WinDLL('dwmapi')
        dwm.DwmGetWindowAttribute.argtypes=[wintypes.HWND,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD]
        frame=wintypes.RECT()
        assert dwm.DwmGetWindowAttribute(hwnd,9,ctypes.byref(frame),ctypes.sizeof(frame))==0
        backdrop=NativeBackdrop(hwnd,frame)
        page.wait_for_timeout(250)
        gdi=ctypes.WinDLL('gdi32')
        gdi.CreateRectRgn.argtypes=[ctypes.c_int]*4;gdi.CreateRectRgn.restype=wintypes.HRGN
        gdi.PtInRegion.argtypes=[wintypes.HRGN,ctypes.c_int,ctypes.c_int]
        gdi.GetRgnBox.argtypes=[wintypes.HRGN,ctypes.POINTER(wintypes.RECT)]
        gdi.DeleteObject.argtypes=[wintypes.HRGN]
        windows.user.GetWindowRgn.argtypes=[wintypes.HWND,wintypes.HRGN]
        region=gdi.CreateRectRgn(0,0,0,0)
        try:
            assert windows.user.GetWindowRgn(hwnd,region)>0,'HWND has no actual rounded region'
            bounds=wintypes.RECT();assert gdi.GetRgnBox(region,ctypes.byref(bounds))>0
            assert not gdi.PtInRegion(region,0,0),'Top-left corner is still opaque/clickable'
            assert not gdi.PtInRegion(region,bounds.right-1,0),'Top-right corner is still opaque/clickable'
            assert gdi.PtInRegion(region,bounds.right//2,bounds.bottom//2),'Region lost its center'
            scale=page.evaluate('devicePixelRatio')
            radius=page.locator('#launcher').evaluate('node=>parseFloat(getComputedStyle(node).borderTopLeftRadius)')
            assert gdi.PtInRegion(region,round(radius*scale),1),'Round region does not match CSS/DPI radius'
            # Check the whole removed corner fan, leaving a two-pixel band for
            # the antialiased contour. Four extreme pixels miss a rectangular
            # native tint/shadow that differs only slightly from the backdrop.
            width,height=frame.right-frame.left,frame.bottom-frame.top
            corner_points=[]
            corner_side=math.ceil(radius*scale)
            for corner in range(4):
                for y in range(corner_side):
                    for x in range(corner_side):
                        px=x if corner%2==0 else width-1-x
                        py=y if corner<2 else height-1-y
                        if all(not gdi.PtInRegion(region,px+dx,py+dy) for dx in range(-2,3) for dy in range(-2,3)):
                            corner_points.append((px,py))
            assert len(corner_points)>100,('Corner sampling did not cover all four fans',len(corner_points))
        finally:gdi.DeleteObject(region)
        OUT.mkdir(parents=True,exist_ok=True)
        from PIL import Image, ImageGrab
        def set_backdrop(color, expected):
            backdrop.set_color(tuple(bytes.fromhex(color.lstrip('#'))))
            deadline=time.monotonic()+5
            while True:
                pixel=ImageGrab.grab(bbox=(frame.left-10,frame.top+100,frame.left-9,frame.top+101),all_screens=True).getpixel((0,0))
                if expected(pixel):break
                assert time.monotonic()<deadline,(color,pixel,'Test backdrop did not paint')
                time.sleep(.03)
            dwm.DwmFlush()
            page.wait_for_timeout(100)
        set_backdrop('#ba3045',lambda p:p[0]>120 and p[2]<100)
        windows.capture(process,OUT/'native-glass.png')
        def check_corners(path, color):
            image=Image.open(path).convert('RGB');width,height=image.size
            samples=[(max(abs(a-b) for a,b in zip(image.getpixel(point),color)),point,image.getpixel(point)) for point in corner_points]
            worst=max(samples)
            print(f'corner fans: samples={len(samples)} max_error={worst[0]} worst={worst[1:]}',flush=True)
            assert worst[0]<=4,(worst,'Native tint or shadow leaked across a removed corner fan')
            # Compare two empty positions in the gap between the title and
            # search, so a changed CSS tint is not mistaken for a native strip.
            # A leftover caption paints only the upper one a different color.
            top=image.getpixel((width//5,round(8*scale)))
            below=image.getpixel((width//5,round(48*scale)))
            assert max(abs(a-b) for a,b in zip(top,below))<18,(top,below,'Native caption strip was painted over the glass')
        check_corners(OUT/'native-glass.png',(186,48,69))
        sample=(round(160*scale),round(75*scale))
        first=Image.open(OUT/'native-glass.png').convert('RGB').getpixel(sample)
        set_backdrop('#225fae',lambda p:p[2]>120 and p[0]<100)
        windows.capture(process,OUT/'native-glass-blue.png')
        check_corners(OUT/'native-glass-blue.png',(34,95,174))
        second=Image.open(OUT/'native-glass-blue.png').convert('RGB').getpixel(sample)
        assert sum(abs(a-b) for a,b in zip(first,second))>40,(first,second,'Native glass does not transmit the live background')
        print(f'PASS: live background transmission RGB {first} -> {second}',flush=True)
        # Transparency alone can satisfy the color transmission assertion. A
        # black/white boundary must actually scatter across neighboring pixels.
        backdrop.set_split_color((20,20,20),(240,240,240))
        dwm.DwmFlush();page.wait_for_timeout(150)
        windows.capture(process,OUT/'native-glass-blur-boundary.png')
        blurred=Image.open(OUT/'native-glass-blur-boundary.png').convert('RGB')
        width,height=blurred.size
        brightness=lambda dx:sum(blurred.getpixel((width//2+dx,round(height*.7))))/3
        edge_jump=abs(brightness(0)-brightness(-1))
        edge_span=brightness(32)-brightness(-32)
        assert edge_jump<18,(edge_jump,'Desktop boundary is sharp: native blur was replaced with transparency')
        assert edge_span>25,(edge_span,'Desktop boundary was hidden by an opaque fallback')
        print(f'PASS: real desktop scattering edge_jump={edge_jump:.1f} span={edge_span:.1f}',flush=True)
        for color,appearance in [('#e5ebf2','light'),('#152031','dark')]:
            backdrop.set_color(tuple(bytes.fromhex(color[1:])))
            page.evaluate('document.querySelector("#closeSpace").click()')
            h.native.wait_until(lambda:not windows.visible(process))
            dwm.DwmFlush()
            h.show(main,page,windows,process)
            page.wait_for_function('appearance=>document.documentElement.dataset.appearance===appearance',arg=appearance)
            page.wait_for_function("() => !document.querySelector('#launcher').classList.contains('is-moving')")
            windows.capture(process,OUT/f'glass-{appearance}.png')
        print('PASS: bright/dark desktop backgrounds select legible native appearance on reopen',flush=True)
        backdrop.set_split_color((240,244,248),(20,27,38))
        page.evaluate('document.querySelector("#closeSpace").click()')
        h.native.wait_until(lambda:not windows.visible(process));dwm.DwmFlush()
        h.show(main,page,windows,process)
        page.wait_for_function("() => document.querySelector('.launcher-header h1').dataset.ink==='light' && document.querySelector('.launcher-search').dataset.ink==='light' && document.querySelector('#closeSpace').dataset.ink==='dark'")
        page.wait_for_function("() => !document.querySelector('#launcher').classList.contains('is-moving')")
        windows.capture(process,OUT/'glass-mixed.png')
        print('PASS: mixed bright/dark backdrop keeps independent control contrast',flush=True)
        # The retained Composition target must update its size and clip after a
        # settings change; otherwise only the first window size is clean.
        for width_percent,height_percent in [(60,45),(96,90)]:
            h.invoke(main,'update_desktop_space_settings',patch={'windowWidth':width_percent,'windowHeight':height_percent})
            h.show(main,page,windows,process)
            page.wait_for_function("() => !document.querySelector('#launcher').classList.contains('is-moving')")
            current=wintypes.RECT()
            assert dwm.DwmGetWindowAttribute(hwnd,9,ctypes.byref(current),ctypes.sizeof(current))==0
            backdrop.close();backdrop=NativeBackdrop(hwnd,current)
            backdrop.set_color((34,95,174));dwm.DwmFlush();page.wait_for_timeout(200)
            destination=OUT/f'glass-resized-{width_percent}-{height_percent}.png'
            windows.capture(process,destination)
            image=Image.open(destination).convert('RGB');width,height=image.size
            r=radius*scale;samples=[]
            for x in range(math.ceil(r)):
                for y in range(math.ceil(r)):
                    if math.hypot(r-x-.5,r-y-.5)<=r+3:continue
                    for point in [(x,y),(width-1-x,y),(x,height-1-y),(width-1-x,height-1-y)]:
                        samples.append(max(abs(a-b) for a,b in zip(image.getpixel(point),(34,95,174))))
            assert samples and max(samples)<=4,(width_percent,height_percent,max(samples),'Resized native material clip left corner residue')
            page.locator('#closeSpace').click();h.native.wait_until(lambda:not windows.visible(process))
        print('PASS: retained backdrop clip remains clean after shrinking and expanding window preferences',flush=True)
        timings=[]
        for native_close in [False,True,False,True]:
            h.show(main,page,windows,process)
            cdp=context.new_cdp_session(page)
            try:
                if native_close:
                    cdp.send('Emulation.setScriptExecutionDisabled',{'value':True})
                    started=time.monotonic();windows.close_test_launcher(process)
                else:
                    started=time.monotonic();page.evaluate('document.querySelector("#closeSpace").click()')
                deadline=started+.18
                while windows.visible(process) and time.monotonic()<deadline:time.sleep(.005)
                elapsed=(time.monotonic()-started)*1000
                assert not windows.visible(process),f'Native glass remained visible after {elapsed:.0f}ms'
                timings.append(round(elapsed,1))
            finally:
                cdp.send('Emulation.setScriptExecutionDisabled',{'value':False});cdp.detach()
        print(f'PASS: rounded HWND, DPI geometry, native/JS close without glass residue; hide_ms={timings}',flush=True)
    finally:
        if backdrop:backdrop.close()
        for name,data in backups.items():
            path=config/name
            if data is None:
                if path.exists():path.unlink()
            else:path.write_bytes(data)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe',type=Path,required=True)
    args=parser.parse_args()
    with sync_playwright() as p:h.native.run_case(p,args.exe.resolve(strict=True),[],scenario)

if __name__=='__main__':main()
