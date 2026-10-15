"""Shelf gestures against the production DOM; the desktop native bridge is mocked."""
import importlib.util
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('desktop_helper', ROOT / 'tests/desktop-presentation-ui-smoke.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

def move(page, handle, dx, dy):
    box = handle.bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx, y + dy, steps=16)
    page.mouse.up()
    page.wait_for_timeout(350)

def main():
    base, close = helper.local_test_url()
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            context.add_init_script(helper.MOCK_TAURI)
            context.add_init_script("localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({enabled:true,presentation:'space',layout:'shelf',appearance:'liquid'}));")
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/desktop-organizer/index.html?host=desktop', wait_until='networkidle')
            page.wait_for_function("Number(getComputedStyle(document.querySelector('#panel')).opacity) === 1")
            rail = page.locator('.space-shelf-rail').first
            tabs = rail.locator('.space-shelf-tab')
            expect(tabs).to_have_count(5)
            expect(page.locator('.space-shelf-panel')).to_be_hidden()
            doc = page.locator('[data-shelf-tab="document"]')
            image = page.locator('[data-shelf-tab="image"]')
            doc.click()
            panel = page.locator('.space-shelf-panel').first
            expect(panel).to_be_visible()
            page.wait_for_timeout(460)
            rect = panel.bounding_box()
            image.click()
            page.wait_for_timeout(220)
            assert panel.bounding_box() == rect, 'Tab switch moved the panel'
            expect(panel.locator('.space-file')).to_have_count(4)
            doc.click()
            page.wait_for_timeout(200)
            grid = panel.locator('.space-file-grid')
            before = helper.grid_order(grid)
            page.screenshot(path=str(helper.SCREENSHOTS / 'shelf-open.png'))
            grid.locator('.space-file').first.drag_to(grid.locator('.space-file').nth(2), timeout=3000)
            page.wait_for_timeout(250)
            after = helper.grid_order(grid)
            assert before != after and sorted(before) == sorted(after)
            assert not page.locator('.space-drop-placeholder').count()
            # Keep an active HTML drag alive while hovering a tab switches grids.
            program = page.locator('[data-shelf-tab="program"]')
            program.click()
            source = panel.locator('.space-file').first
            start, end = source.bounding_box(), image.bounding_box()
            page.mouse.move(start['x'] + start['width'] / 2, start['y'] + start['height'] / 2)
            page.mouse.down()
            page.mouse.move(start['x'] + start['width'] / 2 + 15, start['y'] + start['height'] / 2 + 10, steps=5)
            page.mouse.move(end['x'] + end['width'] / 2, end['y'] + end['height'] / 2, steps=15)
            page.wait_for_timeout(420)
            expect(panel.locator('.space-file-grid')).to_have_attribute('data-space-drop', 'image')
            target = panel.locator('.space-file').nth(1).bounding_box()
            page.mouse.move(target['x'] + target['width'] / 2, target['y'] + target['height'] / 2, steps=10)
            expect(page.locator('.space-drop-placeholder')).to_be_visible()
            page.mouse.up()
            page.wait_for_timeout(250)
            expect(panel.locator('.space-file')).to_have_count(5)
            expect(page.locator('[data-shelf-tab="program"]')).to_be_visible()
            assert '0 个项目' in program.inner_text()
            # Interrupted close and open retain a visible, interactive surface.
            doc.click()
            page.wait_for_timeout(220)
            doc.click()
            page.wait_for_timeout(50)
            doc.click()
            page.wait_for_timeout(480)
            expect(panel).to_be_visible()
            assert page.locator('.space-motion-host,.space-motion-material').count() == 0
            # Clicking the real file uses the existing native open command.
            panel.locator('.space-file').first.dblclick()
            page.wait_for_function("window.__calls.some(c => c.command === 'desktop_open_file')")
            # Moving the base moves only the shelf. It must not accidentally fold.
            old = rail.bounding_box()
            move(page, rail.locator('.space-shelf-grip'), -240, -200)
            new = rail.bounding_box()
            assert abs(new['x'] - old['x'] + 240) < 2 and abs(new['y'] - old['y'] + 200) < 2
            expect(panel).to_be_visible()
            page.reload(wait_until='networkidle')
            restored = rail.bounding_box()
            assert abs(restored['x'] - new['x']) < 2 and abs(restored['y'] - new['y']) < 2
            # Detach a group onto empty desktop and merge it back via its title.
            move(page, image, 100, -220)
            expect(page.locator('.space-shelf')).to_have_count(2)
            second = page.locator('.space-shelf').filter(has=page.locator('[data-shelf-tab="image"]'))
            expect(second).to_have_attribute('data-form', 'card')
            expect(second.locator('.space-face')).to_be_visible()
            image.click(button='right')
            page.locator('[data-shelf-action="form"]').click()
            expect(second).to_have_attribute('data-form', 'capsule')
            main_box = page.locator('.space-shelf-rail').first.bounding_box()
            grip_box = second.locator('.space-shelf-grip').bounding_box()
            move(page, second.locator('.space-shelf-grip'), main_box['x'] + main_box['width'] / 2 - grip_box['x'] - grip_box['width'] / 2, main_box['y'] + main_box['height'] / 2 - grip_box['y'] - grip_box['height'] / 2)
            expect(page.locator('.space-shelf')).to_have_count(1)
            assert len(set(page.locator('[data-shelf-tab]').evaluate_all('tabs => tabs.map(t => t.dataset.shelfTab)'))) == 5
            # Positioning near left edge previews docking then converts to vertical.
            rail = page.locator('.space-shelf-rail').first
            old = rail.bounding_box()
            move(page, rail.locator('.space-shelf-grip'), 16 - old['x'], 0)
            expect(page.locator('.space-shelf')).to_have_attribute('data-dock', 'left')
            expect(page.locator('.space-shelf')).to_have_attribute('data-orientation', 'vertical')
            image.click()
            page.wait_for_timeout(460)
            panel_box = page.locator('.space-shelf-panel').bounding_box()
            assert panel_box['x'] > rail.bounding_box()['x'] + rail.bounding_box()['width']
            assert panel_box['x'] + panel_box['width'] < 1440 and panel_box['y'] + panel_box['height'] < 900
            # Resize and remember the new file surface, without moving the base.
            panel = page.locator('.space-shelf-panel')
            rail_box = rail.bounding_box()
            move(page, panel.locator('.space-shelf-resize'), 80, 55)
            assert rail.bounding_box() == rail_box
            assert panel.bounding_box()['width'] > panel_box['width'] + 60
            page.screenshot(path=str(helper.SCREENSHOTS / 'shelf-left-liquid.png'))
            # Logical display work areas are independent, including negative
            # physical monitor origins translated by the native host.
            page.evaluate("window.__TAURI__.event.emit('desktop-space-workarea-changed', {displays:[{id:'A',x:0,y:0,width:720,height:900},{id:'B',x:720,y:0,width:720,height:900}]})")
            move(page, rail.locator('.space-shelf-grip'), 850, -150)
            saved = page.evaluate("JSON.parse(localStorage.getItem('dtkit_desktop_shelves_v1'))")
            assert saved[0]['display'] == 'B'
            original_b = rail.bounding_box()
            page.evaluate("window.__TAURI__.event.emit('desktop-space-workarea-changed', {displays:[{id:'A',x:0,y:0,width:720,height:900}]})")
            assert rail.bounding_box()['x'] < 720
            page.evaluate("window.__TAURI__.event.emit('desktop-space-workarea-changed', {displays:[{id:'A',x:0,y:0,width:720,height:900},{id:'B',x:720,y:0,width:720,height:900}]})")
            assert abs(rail.bounding_box()['x'] - original_b['x']) < 2
            # Both styles retain transparency and the same interactions.
            helper.choose(page, 'appearance', 'warm')
            page.locator('[data-appearance-close]').click()
            helper.settle(page)
            expect(page.locator('.space-shelf')).to_have_attribute('data-orientation', 'horizontal')
            assert page.evaluate("getComputedStyle(document.body).backgroundColor") == 'rgba(0, 0, 0, 0)'
            page.wait_for_timeout(500)
            count = page.evaluate("window.__calls.filter(c => c.command === 'desktop_space_set_regions').length")
            page.wait_for_timeout(650)
            assert page.evaluate("window.__calls.filter(c => c.command === 'desktop_space_set_regions').length") == count
            assert not errors, errors
            browser.close()
    finally:
        close()
    print('Desktop shelf UI passed. Screenshots:', helper.SCREENSHOTS)

if __name__ == '__main__':
    main()
