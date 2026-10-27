"""Verify overlapping mosaics preserve opaque masks in both screenshot editors."""
import base64
import importlib.util
import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('screenshot_smoke', Path(__file__).with_name('screenshot-annotator-ui-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def assert_masked(image, point, expected):
    pixel = image.getpixel(point)
    assert pixel == expected, f'Mosaic exposed pixels beneath the mask at {point}: {pixel}'


def test_editor(context, base_url, errors):
    page, frame = smoke.main_editor(context, base_url, errors)
    smoke.upload(frame, smoke.image_fixture())
    smoke.mode(frame, 'redact')
    smoke.set_input(frame, '#captureColor', '#1c1c1e')
    smoke.drag_source(page, frame, (100, 80), (400, 300))
    smoke.mode(frame, 'mosaic')
    smoke.drag_source(page, frame, (160, 130), (340, 250))
    image = smoke.exported_image(page, frame)
    assert_masked(image, (250, 190), (28, 28, 30, 255))

    # Crop and output scale change the canvas transform used when sampling.
    smoke.mode(frame, 'crop')
    smoke.drag_source(page, frame, (50, 40), (450, 340))
    frame.locator('#captureCropApply').click()
    frame.locator('#captureCanvasTrigger').click()
    frame.locator('#captureExportScale').select_option('2')
    frame.locator('#captureCanvasTrigger').click()
    image = smoke.exported_image(page, frame)
    assert image.size == (800, 600)
    assert_masked(image, (400, 300), (28, 28, 30, 255))
    page.close()


def test_region(context, base_url, errors):
    page = context.new_page()
    smoke.errors_for(page, errors)
    page.add_init_script(r"""(() => {
      window.__overlayCalls=[];
      window.__TAURI__.core.invoke=async(command,args={})=>{
        window.__overlayCalls.push({command,args});
        if(command==='get_screen_region_capture')return {dataUrl:window.__captureFixture.image(),width:640,height:400,x:0,y:0};
        return null;
      };
    })();""")
    page.goto(base_url + '/screen-region.html', wait_until='networkidle')
    expect(page.locator('#regionLoading')).to_be_hidden()
    page.mouse.move(100, 80); page.mouse.down(); page.mouse.move(1000, 800); page.mouse.up()
    page.keyboard.press('b')
    page.mouse.move(250, 200); page.mouse.down(); page.mouse.move(750, 600); page.mouse.up()
    page.keyboard.press('m')
    page.mouse.move(350, 300); page.mouse.down(); page.mouse.move(650, 500); page.mouse.up()
    page.keyboard.press('Enter')
    page.wait_for_function('window.__overlayCalls.some(call=>call.command==="finish_screen_region_capture")')
    payload = page.evaluate('window.__overlayCalls.find(call=>call.command==="finish_screen_region_capture").args')
    image = Image.open(io.BytesIO(base64.b64decode(payload['dataUrl'].split(',')[1]))).convert('RGBA')
    # The fixture is 640x400 while the viewport is 1440x1000.
    x = round((500 - 100) * 640 / 1440)
    y = round((400 - 80) * 400 / 1000)
    assert_masked(image, (x, y), (0, 122, 255, 255))
    page.close()


def run(base_url):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for case in (test_editor, test_region):
                context = smoke.new_context(browser, base_url)
                try:
                    print('Testing ' + case.__name__, flush=True)
                    case(context, base_url, errors)
                    assert not errors, errors
                finally:
                    context.close()
        finally:
            browser.close()
    print('Mosaic-over-mask pixel regression passed for editor and region capture')


if __name__ == '__main__':
    with smoke.multi.production_url() as base_url:
        run(base_url)
