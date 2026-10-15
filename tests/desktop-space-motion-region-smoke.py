"""Measure real DOM motion reservations, not just the final transparent page."""
import importlib.util
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('presentation_helpers', ROOT / 'tests/desktop-presentation-ui-smoke.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

with sync_playwright() as playwright:
    base, close = helper.local_test_url()
    browser = playwright.chromium.launch(headless=True)
    try:
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        context.add_init_script(helper.MOCK_TAURI)
        context.add_init_script("localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({enabled:true,presentation:'space',layout:'islands',appearance:'liquid'}));")
        page = context.new_page()
        page.goto(base + '/desktop-organizer/index.html?host=desktop', wait_until='networkidle')
        page.wait_for_function("getComputedStyle(document.querySelector('#panel')).opacity === '1'")
        page.wait_for_timeout(500)
        result = page.evaluate("""async () => {
            const count = () => window.__calls.filter(call => call.command === 'desktop_space_set_regions').length;
            const opened = document.querySelector('.space-block[data-space-group="document"] .space-folder-surface');
            const reservations = [];
            document.addEventListener('dtkit:desktop-space-motion', event => {
                const a = event.detail.target, b = event.detail.source || a;
                reservations.push({x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), right: Math.max(a.x+a.width,b.x+b.width), bottom: Math.max(a.y+a.height,b.y+b.height)});
            });
            const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
            const before = count();
            opened.click();
            await wait(70);
            const regions = window.__calls.filter(call => call.command === 'desktop_space_set_regions').at(-1).args.regions;
            const envelope = reservations[0];
            const coversMotion = regions.some(region => region.x <= envelope.x && region.y <= envelope.y && region.x + region.width >= envelope.right && region.y + region.height >= envelope.bottom);
            await wait(470);
            const openingCalls = count() - before;
            const beforeClose = count();
            document.querySelector('.space-popup [data-space-close]').click();
            await wait(450);
            return {openingCalls, closingCalls: count() - beforeClose, coversMotion};
        }""")
        assert result['coversMotion'], f"Native region clips the path between the cabinet and panel: {result}"
        assert result['openingCalls'] <= 3 and result['closingCalls'] <= 3, f"Animation repeatedly changes the native input shape: {result}"
        caption = page.locator('.space-block[data-space-group="document"] .space-caption').bounding_box()
        before_drag = page.evaluate("window.__calls.filter(call => call.command === 'desktop_space_set_regions').length")
        page.mouse.move(caption['x'] + caption['width'] / 2, caption['y'] + caption['height'] / 2)
        page.mouse.down()
        page.mouse.move(caption['x'] + caption['width'] / 2 - 280, caption['y'] + caption['height'] / 2 + 100, steps=40)
        page.mouse.up()
        page.wait_for_timeout(100)
        drag_calls = page.evaluate("window.__calls.filter(call => call.command === 'desktop_space_set_regions').length") - before_drag
        assert drag_calls <= 3, f'Cabinet movement repeatedly repaints the native window: {drag_calls}'
        context.close()
        print(f'Desktop motion region reservation passed: {result}; cabinetDragCalls={drag_calls}')
    finally:
        browser.close()
        close()
