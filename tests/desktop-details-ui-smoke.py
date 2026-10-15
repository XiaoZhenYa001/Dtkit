"""Outside dismissal and the draggable desktop control, through real UI events."""
import importlib.util
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('desktop_helper',ROOT/'tests/desktop-presentation-ui-smoke.py')
helper=importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def main():
    base,close=helper.local_test_url()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            context=browser.new_context(viewport={'width':1440,'height':900})
            context.add_init_script(helper.MOCK_TAURI)
            context.add_init_script("localStorage.setItem('dtkit_desktop_organizer',JSON.stringify({enabled:true,presentation:'space',layout:'shelf',appearance:'liquid'}));")
            page=context.new_page()
            errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(base+'/desktop-organizer/index.html?host=desktop',wait_until='networkidle')
            tab=page.locator('[data-shelf-tab="document"]')
            panel=page.locator('.space-shelf-panel').first
            tab.click()
            page.wait_for_timeout(450)
            page.mouse.click(80,400)
            expect(panel).to_be_hidden(timeout=2000)
            tab.click()
            page.wait_for_timeout(450)
            page.keyboard.press('Escape')
            expect(panel).to_be_hidden(timeout=2000)
            tab.click()
            page.wait_for_timeout(450)
            panel.locator('.space-shelf-pin').click()
            page.mouse.click(80,400)
            expect(panel).to_be_visible()
            page.evaluate("window.dispatchEvent(new Event('blur'))")
            expect(panel).to_be_visible()
            panel.locator('.space-shelf-pin').click()
            page.evaluate("window.dispatchEvent(new Event('blur'))")
            expect(panel).to_be_hidden(timeout=2000)
            dial=page.locator('#desktopToolsToggle')
            tools=page.locator('#desktopTools')
            expect(dial).to_be_visible()
            expect(page.locator('#desktopToolActions')).to_be_hidden()
            start=dial.bounding_box()
            before_calls=page.evaluate("window.__calls.filter(c=>c.command==='desktop_space_set_regions').length")
            dial.click()
            page.wait_for_timeout(430)
            expect(page.locator('#desktopToolActions')).to_be_visible()
            assert abs(dial.bounding_box()['x']-start['x'])<1,'Unfolding moved its dial anchor'
            open_calls=page.evaluate("window.__calls.filter(c=>c.command==='desktop_space_set_regions').length")-before_calls
            assert open_calls<=3,f'Unfolding repaints the native shape per frame: {open_calls}'
            page.locator('#appearanceBtn').click()
            settings=page.locator('#appearancePanel')
            expect(settings).to_be_visible()
            bounds=settings.bounding_box()
            assert 0<=bounds['y'] and bounds['y']+bounds['height']<=900
            settings.locator('[data-appearance-close]').click()
            # Repeated reversals must end with a working compact button.
            for _ in range(6):
                dial.click()
                page.wait_for_timeout(45)
            page.wait_for_timeout(430)
            page.mouse.click(80,400)
            page.wait_for_timeout(260)
            expect(page.locator('#desktopToolActions')).to_be_hidden()
            box=dial.bounding_box()
            page.mouse.move(box['x']+26,box['y']+26)
            page.mouse.down()
            page.mouse.move(box['x']+26-240,box['y']+26-240,steps=20)
            page.mouse.up()
            page.wait_for_timeout(400)
            moved=dial.bounding_box()
            assert abs(moved['x']-box['x']+240)<2 and abs(moved['y']-box['y']+240)<2
            expect(page.locator('#desktopToolActions')).to_be_hidden()
            page.reload(wait_until='networkidle')
            restored=dial.bounding_box()
            assert abs(restored['x']-moved['x'])<2 and abs(restored['y']-moved['y'])<2
            # Dock to the shelf's left end, then move its base.
            rail=page.locator('.space-shelf-rail').first
            r=rail.bounding_box()
            box=dial.bounding_box()
            target={'x':r['x']-52-8,'y':r['y']+(r['height']-52)/2}
            page.mouse.move(box['x']+26,box['y']+26)
            page.mouse.down()
            page.mouse.move(target['x']+26,target['y']+26,steps=20)
            page.mouse.up()
            page.wait_for_timeout(400)
            expect(tools).to_have_attribute('data-attached','shelf')
            docked=dial.bounding_box()
            grip=rail.locator('.space-shelf-grip').bounding_box()
            page.mouse.move(grip['x']+grip['width']/2,grip['y']+grip['height']/2)
            page.mouse.down()
            page.mouse.move(grip['x']+grip['width']/2,grip['y']+grip['height']/2-100,steps=20)
            page.mouse.up()
            page.wait_for_timeout(400)
            assert abs(dial.bounding_box()['y']-docked['y']+100)<2,'Attached dial did not follow the shelf'
            dial.click()
            page.wait_for_timeout(400)
            page.screenshot(path=str(helper.SCREENSHOTS/'desktop-controls-expanded.png'))
            helper.choose(page,'layout','drawer')
            helper.settle(page)
            page.mouse.click(80,400)
            page.wait_for_timeout(350)
            handle=page.locator('.space-drawer-handle')
            r=handle.bounding_box()
            target={'x':r['x']-60,'y':r['y']+(r['height']-52)/2}
            box=dial.bounding_box()
            page.mouse.move(box['x']+26,box['y']+26)
            page.mouse.down()
            page.mouse.move(target['x']+26,target['y']+26,steps=20)
            page.mouse.up()
            page.wait_for_timeout(400)
            expect(tools).to_have_attribute('data-attached','drawer')
            handle.click()
            page.wait_for_timeout(520)
            drawer=page.locator('.space-drawer')
            expect(drawer).to_be_visible()
            assert dial.bounding_box()['x']+52<drawer.bounding_box()['x'],'Attached tools cover the drawer contents'
            page.mouse.click(80,400)
            expect(drawer).to_be_hidden()
            page.wait_for_timeout(350)
            helper.choose(page,'appearance','warm')
            page.mouse.click(80,400)
            page.wait_for_timeout(350)
            page.set_viewport_size({'width':760,'height':600})
            page.wait_for_timeout(200)
            box=dial.bounding_box()
            assert 0<=box['x']<=708 and 0<=box['y']<=548
            assert not errors,errors
            print(f'Desktop detail interactions passed; screenshots={helper.SCREENSHOTS}',flush=True)
            browser.close()
    finally:
        close()


if __name__=='__main__':
    main()
