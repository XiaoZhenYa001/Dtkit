"""Shared material input feedback and accessible fallback; headless, mocked IPC."""
import importlib.util
from io import BytesIO
import math
from pathlib import Path
from PIL import Image
from playwright.sync_api import expect, sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'tests/artifacts/desktop-liquid-glass'
spec=importlib.util.spec_from_file_location('launcher_helpers',ROOT/'tests/desktop-launcher-ui-smoke.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

def rounded_material_pixels(browser,base):
    for scale in (1,1.5,2):
        context=browser.new_context(viewport={'width':440,'height':280},device_scale_factor=scale)
        context.add_init_script(h.MOCK_TAURI)
        page=context.new_page()
        page.goto(base+'/desktop-organizer/space.html',wait_until='networkidle')
        page.evaluate('''() => {
            document.querySelector('#launcher').style.display='none';
            document.body.style.background='repeating-conic-gradient(#f1e6dc 0 25%,#294b6e 0 50%) 0/16px 16px';
            const surface=document.createElement('div');surface.id='cornerProbe';surface.className='liquid-glass';
            Object.assign(surface.style,{position:'absolute',left:'70px',top:'50px',width:'280px',height:'160px'});
            document.body.append(surface);
        }''')
        surface=page.locator('#cornerProbe')
        for radius in (17,28):
            surface.evaluate('(node,radius)=>node.style.setProperty("--glass-radius",radius+"px")',radius)
            for fallback in (False,True):
                page.evaluate('fallback=>document.documentElement.dataset.nativeBackdrop=fallback?"unavailable":"available"',fallback)
                surface.evaluate('node=>node.style.visibility="hidden"')
                background=Image.open(BytesIO(page.screenshot())).convert('RGB')
                surface.evaluate('node=>node.style.visibility="visible"')
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                active=Image.open(BytesIO(page.screenshot())).convert('RGB')
                r=radius*scale;left=70*scale;top=50*scale;w=280*scale;hh=160*scale
                leaks=[];samples=0
                for dx in range(math.ceil(r)):
                    for dy in range(math.ceil(r)):
                        if math.hypot(r-dx-.5,r-dy-.5)<=r+2:continue
                        for x,y in ((left+dx,top+dy),(left+w-1-dx,top+dy),(left+dx,top+hh-1-dy),(left+w-1-dx,top+hh-1-dy)):
                            point=(round(x),round(y));samples+=1
                            delta=max(abs(a-b) for a,b in zip(active.getpixel(point),background.getpixel(point)))
                            if delta>2:leaks.append((point,delta))
                if leaks:
                    page.screenshot(path=str(OUT/f'corner-failure-{scale}-{radius}-{fallback}.png'))
                assert not leaks,{'scale':scale,'radius':radius,'fallback':fallback,'samples':samples,'leaks':leaks[:8]}
        context.close()
    print('PASS: whole corner exterior stays unchanged at 1x/1.5x/2x in translucent and fallback material')

def main():
    base,close=h.local_test_url()
    OUT.mkdir(parents=True,exist_ok=True)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            rounded_material_pixels(browser,base)
            context=browser.new_context(viewport={'width':1120,'height':620})
            context.add_init_script(h.MOCK_TAURI)
            page=context.new_page();errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(base+'/desktop-organizer/space.html',wait_until='networkidle')
            h.open_panel(page);h.idle(page)
            surface=page.locator('.launcher-material')
            page.evaluate("document.body.style.background='radial-gradient(ellipse at 18% 20%,#89b0c5,transparent 55%),radial-gradient(ellipse at 80% 80%,#b2a2bd,transparent 60%),#25364e'")
            before=surface.evaluate("node=>getComputedStyle(node,'::before').backgroundImage")
            page.mouse.move(900,180)
            page.wait_for_function("document.querySelector('.launcher-material').style.getPropertyValue('--glass-light-x') !== ''")
            after=surface.evaluate("node=>getComputedStyle(node,'::before').backgroundImage")
            assert before!=after,(before,after)
            page.mouse.down()
            expect(surface).to_have_attribute('data-glass-pressed','true')
            assert surface.evaluate("node=>getComputedStyle(node).getPropertyValue('--glass-press-boost').trim()")=='.08'
            page.mouse.up()
            expect(surface).not_to_have_attribute('data-glass-pressed','true')
            page.screenshot(path=str(OUT/'space-dark.png'))
            print('PASS: geometry-based lighting follows input, press/release feedback clears')

            page.evaluate("window.__emit('desktop-space-settings-changed',{reducedMotion:true})")
            page.mouse.move(250,190)
            assert surface.evaluate("node=>node.style.getPropertyValue('--glass-light-x')")==''
            page.mouse.down()
            expect(surface).not_to_have_attribute('data-glass-pressed','true')
            page.mouse.up()
            page.emulate_media(reduced_motion='reduce')
            page.evaluate("window.__emit('desktop-space-settings-changed',{reducedMotion:false})")
            page.mouse.move(700,190)
            assert surface.evaluate("node=>node.style.getPropertyValue('--glass-light-x')")==''
            print('PASS: application and OS reduced motion both disable moving material lighting')

            page.emulate_media(reduced_motion='no-preference')
            page.evaluate("window.__emit('desktop-space-opened',{session:50,lightBackground:true})")
            h.idle(page)
            page.screenshot(path=str(OUT/'space-light.png'))
            # The fallback is one uniform surface: old local desktop ink must
            # not survive on top of it, even on a mixed-brightness desktop.
            page.evaluate("window.__emit('desktop-space-opened',{session:51,lightBackground:false,backgroundLuminance:Array(45).fill(.95)})")
            page.wait_for_function("!!document.querySelector('.launcher-card[data-ink=light]')")
            page.evaluate("window.__emit('desktop-space-material',{available:false})")
            expect(page.locator('html')).to_have_attribute('data-native-backdrop','unavailable')
            assert surface.evaluate('node=>getComputedStyle(node).backdropFilter')=='none'
            assert surface.evaluate('node=>getComputedStyle(node).backgroundColor').endswith('0.96)')
            page.wait_for_function("!document.querySelector('.launcher-card[data-ink]')")
            assert page.locator('.launcher-file').first.evaluate('node=>getComputedStyle(node).color')=='rgb(244, 246, 251)'
            page.evaluate("window.__emit('desktop-space-material',{available:true})")
            assert surface.evaluate('node=>getComputedStyle(node).backdropFilter')!='none'
            page.wait_for_function("!!document.querySelector('.launcher-card[data-ink=light]')")
            page.emulate_media(forced_colors='active')
            assert surface.evaluate("node=>getComputedStyle(node,'::after').display")=='none'
            assert surface.evaluate('node=>getComputedStyle(node).backdropFilter')=='none'
            assert not errors,errors
            context.close();browser.close()
            print('PASS: native blur failure has readable fallback and Windows high contrast removes decorative effects')
    finally:close()

if __name__=='__main__':main()
