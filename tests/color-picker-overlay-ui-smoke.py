"""Verify the production screen-pick overlay against a generated screenshot.

The browser fixture only contains synthetic pixels. No desktop capture or
native application is involved in this suite.
"""
import importlib.util
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multipage', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)

FIXTURE = r"""
(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 960; canvas.height = 600;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F02433'; ctx.fillRect(0,0,480,600);
    ctx.fillStyle = '#1177CC'; ctx.fillRect(480,0,480,600);
    ctx.fillStyle = '#10E04A'; ctx.fillRect(481,300,1,1);
    const capture = {width:960,height:600,x:-1920,y:-120,dataUrl:canvas.toDataURL()};
    window.__overlayFixture = {calls:[],frames:0};
    const animation = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => animation(time => {
        window.__overlayFixture.frames++; callback(time);
    });
    window.__TAURI__ = {core:{invoke:async (command,args={}) => {
        window.__overlayFixture.calls.push({command,args});
        if (command === 'get_screen_color_pick_capture') return capture;
        if (command === 'finish_screen_color_pick') return new Promise(resolve => {
            window.__overlayFixture.finish = resolve;
        });
        throw new Error('Unexpected command '+command);
    }}};
})();
"""


def open_overlay(context, url):
    page = context.new_page()
    page.add_init_script(FIXTURE)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url + '/color-pick.html')
    expect(page.locator('#magnifier')).to_be_visible()
    expect(page.locator('#loading')).to_be_hidden()
    return page, errors


def run():
    with multi.production_url() as url, sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport={'width':640,'height':400},device_scale_factor=1.5)
        # Header injection uses the same production CSP without changing files.
        def csp(route):
            response = route.fetch()
            route.fulfill(response=response,headers={**response.headers,'Content-Security-Policy':multi.CSP})
        context.route('**/*',csp)
        page, errors = open_overlay(context,url)
        expect(page.locator('#pickedHex')).to_have_text('#1177CC')
        expect(page.locator('#pickedCoordinate')).to_have_text('-1440, 180 px')
        page.keyboard.press('ArrowRight')
        expect(page.locator('#pickedHex')).to_have_text('#10E04A')
        expect(page.locator('#pickedCoordinate')).to_have_text('-1439, 180 px')
        page.keyboard.press('Shift+ArrowRight')
        expect(page.locator('#pickedCoordinate')).to_have_text('-1429, 180 px')
        page.mouse.move(100,100)
        expect(page.locator('#pickedHex')).to_have_text('#F02433')
        before = page.evaluate('window.__overlayFixture.frames')
        page.evaluate("""() => {
            const canvas=document.getElementById('screenCanvas');
            for(let index=0;index<120;index++) canvas.dispatchEvent(
                new PointerEvent('pointermove',{clientX:100+index/10,clientY:100,bubbles:true}));
        }""")
        page.wait_for_timeout(100)
        assert page.evaluate('window.__overlayFixture.frames') - before == 1
        page.mouse.move(0,0)
        expect(page.locator('#pickedCoordinate')).to_have_text('-1920, -120 px')
        assert page.locator('#magnifierCanvas').evaluate(
            "node => [...node.getContext('2d').getImageData(3,3,1,1).data]") == [36,38,43,255]
        page.mouse.move(639,399)
        page.wait_for_timeout(50)
        box = page.locator('#magnifier').bounding_box()
        assert box['x'] >= 8 and box['y'] >= 8 and box['x']+box['width'] <= 632.5
        assert box['y']+box['height'] <= 392.5
        page.keyboard.press('Enter')
        page.keyboard.press('Enter')
        page.mouse.click(300,200)
        calls = page.evaluate("window.__overlayFixture.calls.filter(item=>item.command==='finish_screen_color_pick')")
        assert len(calls) == 1 and calls[0]['args']['color'] == '#1177CC', calls
        assert not errors, errors
        page.close()

        page, errors = open_overlay(context,url)
        page.keyboard.press('Escape')
        assert page.evaluate("window.__overlayFixture.calls.filter(item=>item.command==='finish_screen_color_pick')") == [
            {'command':'finish_screen_color_pick','args':{'color':None}}]
        assert not errors, errors
        page.close()

        context.close()
        context = browser.new_context(viewport={'width':390,'height':680},reduced_motion='reduce')
        page, errors = open_overlay(context,url)
        assert page.locator('#magnifier').evaluate("node=>getComputedStyle(node).animationName") == 'none'
        assert page.locator('.picker-hint').bounding_box()['width'] <= 358
        assert not errors, errors
        context.close()
        browser.close()
    print('Color overlay physical pixels, keyboard precision, frame coalescing, edge sampling, CSP and finish guards passed',flush=True)


if __name__ == '__main__':
    run()
