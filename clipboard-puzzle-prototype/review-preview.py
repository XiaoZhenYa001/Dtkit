"""Browser review utility for this throwaway prototype; does not start DtKit."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent
shots = root / 'review-images'
shots.mkdir(exist_ok=True)
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto((root / 'main.html').as_uri())
    page.wait_for_load_state('networkidle')
    page.evaluate('document.fonts.ready')
    page.screenshot(path=str(shots / 'main-A.png'))
    for variant in ['B', 'C']:
        page.get_by_role('button', name='下一个布局', exact=True).click()
        page.wait_for_function(f"document.body.dataset.variant === '{variant}'")
        page.screenshot(path=str(shots / f'main-{variant}.png'))
    page.get_by_role('button', name='下一个布局', exact=True).click()

    # Verify ordinary browser dragging without calling application internals.
    first = page.locator('.object').first
    box = first.bounding_box()
    original = first.get_attribute('style')
    page.mouse.move(box['x'] + 120, box['y'] + 120)
    page.mouse.down()
    page.mouse.move(box['x'] + 152, box['y'] + 140, steps=15)
    page.mouse.up()
    page.wait_for_timeout(150)
    dragged = first.get_attribute('style') != original

    handle = first.locator('.object-handle.se').bounding_box()
    before_resize = first.get_attribute('style')
    page.mouse.move(handle['x'] + 3, handle['y'] + 3)
    page.mouse.down()
    page.mouse.move(handle['x'] + 25, handle['y'] + 20, steps=8)
    page.mouse.up()
    assert first.get_attribute('style') != before_resize
    page.keyboard.press('Control+z')

    # Review object-specific context menu.
    first.click(button='right', position={'x': 90, 'y': 90})
    page.screenshot(path=str(shots / 'image-menu.png'))
    assert page.get_by_role('button', name='旋转图片', exact=True).is_visible()
    page.keyboard.press('Escape')

    # Exercise region capture as a user does, then export the result.
    page.get_by_role('button', name='区域截取', exact=True).click()
    box = first.bounding_box()
    before = page.locator('.image-object').count()
    page.mouse.move(box['x'] + 30, box['y'] + 45)
    page.mouse.down()
    page.mouse.move(box['x'] + 180, box['y'] + 155, steps=12)
    page.screenshot(path=str(shots / 'scissors.png'))
    page.mouse.up()
    page.wait_for_function(f"document.querySelectorAll('.image-object').length === {before+1}")
    page.get_by_role('button', name='复制拼图', exact=True).click()
    page.locator('.export-preview img').wait_for()
    page.screenshot(path=str(shots / 'export.png'))
    page.get_by_role('button', name='关闭导出面板', exact=True).click()

    mini = context.new_page()
    mini.on('pageerror', lambda error: errors.append(str(error)))
    mini.set_viewport_size({'width': 480, 'height': 700})
    mini.goto((root / 'floating.html').as_uri())
    mini.wait_for_load_state('networkidle')
    mini.evaluate('document.fonts.ready')
    mini.screenshot(path=str(shots / 'floating.png'))
    mini.get_by_role('button', name='对象属性', exact=True).click()
    mini.screenshot(path=str(shots / 'floating-properties.png'))
    mini.get_by_role('button', name='收起属性', exact=True).click()

    # Transport the actual browser drag payload between pages to review drop positioning.
    payload = page.locator('.object').first.evaluate("""el => {
      const data = new DataTransfer();
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent('dragstart', {bubbles:true,dataTransfer:data,clientX:rect.x+40,clientY:rect.y+40}));
      return data.getData('application/x-dtkit-puzzle-preview');
    }""")
    assert payload
    mini.evaluate("""payload => {
      const data = new DataTransfer(); data.setData('application/x-dtkit-puzzle-preview',payload);
      const stage=document.querySelector('#stage'),r=stage.getBoundingClientRect();
      stage.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data,clientX:r.x+120,clientY:r.y+190}));
    }""", payload)
    mini.wait_for_function("document.querySelectorAll('.object').length === 7")
    mini.screenshot(path=str(shots / 'cross-window-copy.png'))

    for width, height in [(360, 640), (640, 480)]:
        mini.set_viewport_size({'width': width, 'height': height})
        mini.wait_for_timeout(120)
        toolbar = mini.locator('.dock').bounding_box()
        assert toolbar['x'] >= 0 and toolbar['x'] + toolbar['width'] <= width
        assert mini.evaluate('document.documentElement.scrollWidth <= innerWidth')
        mini.screenshot(path=str(shots / f'floating-{width}.png'))
    assert not errors, errors
    print(json.dumps({'javascript_errors': errors, 'internal_drag_worked': dragged,
                      'handle_resize': 'verified',
                      'region_capture': 'verified', 'png_export': 'verified',
                      'cross_page_payload_copy': 'verified (synthetic browser drop)',
                      'screenshots': str(shots)}, ensure_ascii=False))
    browser.close()
