"""End-to-end auto scrolling capture against generated desktop pixels."""
import argparse, base64, ctypes, importlib.util, time
from io import BytesIO
from pathlib import Path
from uuid import uuid4
from PIL import Image, ImageTk
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).with_name('screenshot-native-smoke.py'))
smoke = importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)

def scenario(owner, context, process):
    import tkinter as tk
    user=ctypes.windll.user32
    try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except OSError: pass
    vx,vy,vw,vh=[user.GetSystemMetrics(i) for i in (76,77,78,79)]
    fixture=tk.Tk(); fixture.overrideredirect(True); fixture.attributes('-topmost',True)
    fixture.geometry(f'{vw}x{vh}+0+0')
    board=tk.Canvas(fixture,highlightthickness=0); board.pack(fill='both',expand=True)
    pattern=Image.new('RGB',(600,1800))
    pattern.putdata([((x*13+y*17)%251,(x*3+y*23)%253,(x*31+y*7)%255) for y in range(1800) for x in range(600)])
    picture=ImageTk.PhotoImage(pattern,master=fixture); board.create_image(0,0,image=picture,anchor='nw')
    board.configure(scrollregion=(0,0,vw,max(vh+1000,1800)),yscrollincrement=1)
    fixture.update(); user.SetWindowPos(fixture.winfo_id(),-1,vx,vy,vw,vh,0x0040); fixture.update()
    movement=[60]; wheels=[]
    def scroll(event):
        wheels.append(event.delta); board.yview_scroll(movement[0],'units')
    board.bind('<MouseWheel>',scroll)
    def until(predicate, timeout=20):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            fixture.update(); owner.wait_for_timeout(30)
            if predicate(): return
        raise AssertionError('capture state did not settle')
    try:
        until(lambda:owner.evaluate('window.__DTKIT_TOOL_PAGE__?.ready===true'))
        owner.evaluate("async()=>{window.__autoShots=[];await window.__TAURI__.event.listen('screen-region-captured', e=>window.__autoShots.push(e.payload))}")
        for step in (60,300):
            movement[0]=step;wheels.clear();board.yview_moveto(0);fixture.update()
            request={'instanceId':owner.evaluate('window.__DTKIT_TOOL_PAGE_CONTEXT.instanceId'),'requestId':'auto-'+uuid4().hex}
            smoke.invoke(owner,'start_screen_region_capture',{**request,'longDirection':'vertical','longMode':'automatic','maxSegments':4})
            until(lambda:len(smoke.overlays(context))==1)
            overlay=smoke.overlays(context)[0];expect(overlay.locator('#regionLoading')).to_be_hidden(timeout=15000)
            overlay.mouse.move(100,100);overlay.mouse.down();overlay.mouse.move(480,350);overlay.mouse.up()
            selected_height=int(overlay.locator('#regionSize').inner_text().split('×')[1].strip())
            overlay.keyboard.press('Enter')
            until(lambda:any('long-capture-border.html' in p.url for p in context.pages) or owner.evaluate('r=>window.__autoShots.some(x=>x.requestId===r)',request['requestId']))
            previews=[p for p in context.pages if 'long-capture-border.html' in p.url]
            assert previews, 'A side preview should appear when there is enough space'
            preview=previews[0];until(lambda:preview.locator('.long-capture-preview__image').is_visible())
            if step==60:
                before=preview.locator('.long-capture-preview__image').get_attribute('src')
                until(lambda:preview.is_closed() or '2 段' in preview.locator('.long-capture-preview__dimensions').inner_text())
                assert not preview.is_closed(), 'Preview closed before the second frame'
                assert preview.locator('.long-capture-preview__image').get_attribute('src')!=before
            until(lambda:owner.evaluate('r=>window.__autoShots.some(x=>x.requestId===r)',request['requestId']))
            result=owner.evaluate('r=>window.__autoShots.find(x=>x.requestId===r)',request['requestId'])
            assert not result['cancelled'] and wheels,result
            cap=result['capture'];actual=Image.open(BytesIO(base64.b64decode(cap['dataUrl'].split(',')[1]))).convert('RGB')
            x,y=cap['x']-vx,cap['y']-vy
            expected=pattern.crop((x,y,x+actual.width,y+actual.height))
            assert actual.tobytes()==expected.tobytes(), 'auto output pixels differ from source'
            if step==60: assert actual.height>selected_height, actual.size
            else: assert actual.height==selected_height and '无法可靠匹配' in cap.get('warning',''), cap.get('warning')
            print(f'Auto capture step={step}, size={actual.size}, wheel={len(wheels)}, warning={cap.get("warning")}',flush=True)
    finally: fixture.destroy()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--exe',type=Path,required=True);args=parser.parse_args()
    with sync_playwright() as p: smoke.native.run_case(p,args.exe.resolve(),['--tool','html-preview'],scenario)
