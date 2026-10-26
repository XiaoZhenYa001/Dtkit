"""Production-DOM keyboard, controlled PDF and detached-card lifetime regression.

Run after npm run build. Uses isolated mock files and never opens native apps.
"""

import base64
import importlib.util
import io
import os
from pathlib import Path
import tempfile

from playwright.sync_api import expect, sync_playwright
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('launcher_keyboard_helpers', ROOT / 'tests/desktop-launcher-ui-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
OUTPUT = Path(tempfile.mkdtemp(prefix='dtkit-launcher-keyboard-'))


def pdf_data_url(bodies):
    data = b'%PDF-1.5\n'
    offsets = [0]
    for index, body in enumerate(bodies, 1):
        offsets.append(len(data))
        data += f'{index} 0 obj\n'.encode() + body + b'\nendobj\n'
    xref = len(data)
    data += f'xref\n0 {len(offsets)}\n'.encode() + b'0000000000 65535 f \n'
    data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    data += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    return 'data:application/pdf;base64,' + base64.b64encode(data).decode()


def pdf_fixture():
    bodies = [b'<< /Type /Catalog /Pages 2 0 R >>',
              b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
              b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
              b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>']
    for color in (b'0.2 0.4 0.8', b'0.8 0.3 0.2'):
        stream = color + b' rg 50 50 300 400 re f\n0 0 0 rg BT /F1 18 Tf 50 700 Td (DtKit PDF preview) Tj ET\n'
        bodies.append(b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'endstream')
    bodies.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    return pdf_data_url(bodies)


def jpx_pdf_fixture():
    """JPEG 2000 requires PDF.js's bundled OpenJPEG WASM decoder."""
    encoded = io.BytesIO()
    Image.new('RGB', (64, 64), (210, 20, 160)).save(encoded, format='JPEG2000')
    image = encoded.getvalue()
    stream = b'q 600 0 0 800 0 0 cm /Im0 Do Q\n'
    return pdf_data_url([
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
        b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'endstream',
        b'<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length '
        + str(len(image)).encode() + b' >>\nstream\n' + image + b'\nendstream',
    ])


EXTRA_MOCK = r"""
window.__reviewTrip = 0;
window.__reviewFolderBatches = false;
window.__reviewJPX = false;
const originalInvoke = window.__TAURI__.core.invoke;
window.__TAURI__.core.invoke = async (command,args={}) => {
    if (command === 'get_desktop_space_settings') return {
        version:1,glassOpacity:68,blur:30,iconSize:'medium',windowWidth:90,windowHeight:70,
        closeOnBlur:true,closeAfterOpen:true,reducedMotion:false
    };
    if (command === 'desktop_list_folder' && window.__reviewFolderBatches) {
        const trip = ++window.__reviewTrip;
        return {path:args.path,name:'Project',items:Array.from({length:80},(_,index)=>({
            path:args.path+'\\Batch'+trip+'-'+index+'.txt',name:'Batch'+trip+'-'+index+'.txt',
            is_folder:false,category:'document',size:1
        })),total_count:80,truncated:false};
    }
    const result = await originalInvoke(command,args);
    if (command === 'desktop_preview_file' && args.path.endsWith('Reference.pdf')) {
        result.dataUrl = window.__reviewJPX ? __JPX_DATA__ : __PDF_DATA__;
    }
    return result;
};
"""


def pdf_ready(page):
    page.wait_for_function("""() => {
        const canvas=document.querySelector('.pdf-stage canvas');
        const status=document.querySelector('.pdf-status');
        return canvas?.width>1 && status?.hidden === true;
    }""")


def assert_jpx_color(page, console):
    # Sample the on-screen region to match the visible preview even when most
    # of a tall PDF page lies below the scroll viewport.
    pixel = page.locator('.pdf-stage canvas').evaluate('canvas=>Array.from(canvas.getContext("2d").getImageData(Math.floor(canvas.width/2),Math.min(64,Math.floor(canvas.height/2)),1,1).data)')
    assert pixel[0] > 150 and pixel[1] < 80 and pixel[2] > 100, (pixel, console)


def assert_pdf_stable(page):
    page.evaluate('''() => {
        window.__pdfCanvasResets = 0;
        window.__pdfCanvasObserver = new MutationObserver(records => window.__pdfCanvasResets += records.length);
        window.__pdfCanvasObserver.observe(document.querySelector('.pdf-stage canvas'), { attributes: true, attributeFilter: ['width', 'height'] });
    }''')
    page.wait_for_timeout(500)
    resets = page.evaluate('''() => {
        window.__pdfCanvasObserver.disconnect();
        return window.__pdfCanvasResets;
    }''')
    assert resets <= 2, f'PDF keeps resetting its canvas after rendering: {resets}'


def dom_counters(cdp):
    # Playwright's selector diagnostics log matching elements to DevTools. Those
    # console handles retain one detached card per wait_for even after app GC.
    cdp.send('Runtime.discardConsoleEntries')
    cdp.send('HeapProfiler.collectGarbage')
    return cdp.send('Memory.getDOMCounters')


def assert_roving_file_navigation(page):
    entries = page.locator('.launcher-card[data-id] .launcher-file')
    entry = page.locator('.launcher-card[data-id] .launcher-file[tabindex="0"]')
    expect(entry).to_have_count(1)
    assert page.locator('.launcher-card[data-id] .pin-button').evaluate_all(
        'buttons => buttons.every(button => button.tabIndex === -1)')
    expect(page.locator('#fileGrid')).to_have_attribute('role', 'list')
    assert page.locator('.launcher-card[data-id]').evaluate_all(
        'cards => cards.every(card => card.getAttribute("role") === "listitem")')
    assert page.locator('button button,[role="option"] button').count() == 0

    # The whole file area has one entry and one exit, including both lanes.
    page.evaluate('''() => {
        const exit = document.createElement('button');
        exit.id = 'rovingExitProbe'; exit.textContent = '文件区后的控件';
        document.body.append(exit);
    }''')
    page.locator('[data-filter="other"]').focus()
    page.keyboard.press('Tab')
    expect(entry).to_be_focused()
    expect(entry).to_have_attribute('aria-current', 'true')
    page.keyboard.press('ArrowRight')
    expect(entries.nth(1)).to_be_focused()
    expect(entries.nth(1)).to_have_attribute('tabindex', '0')
    expect(page.locator('.launcher-file[aria-current="true"]')).to_have_count(1)
    page.keyboard.press('Tab')
    expect(page.locator('#rovingExitProbe')).to_be_focused()
    page.keyboard.press('Shift+Tab')
    expect(entry).to_be_focused()
    page.keyboard.press('Shift+Tab')
    expect(page.locator('[data-filter="other"]')).to_be_focused()

    # Keyboard users can pin and unpin without visiting hidden auxiliary stops.
    entry.focus()
    name = entry.get_attribute('data-name')
    page.keyboard.press('Shift+F10')
    expect(page.locator('#fileMenu')).to_be_visible()
    expect(page.locator('#fileMenu [data-action="open"]')).to_be_focused()
    page.keyboard.press('ArrowDown'); page.keyboard.press('ArrowDown')
    expect(page.locator('#fileMenu [data-action="pin"]')).to_be_focused()
    page.keyboard.press('Enter')
    pinned = helpers.button(page, name, '#pinnedGrid')
    expect(pinned).to_be_focused()
    expect(pinned).to_have_attribute('tabindex', '0')
    expect(entry).to_have_count(1)
    page.keyboard.press('ContextMenu')
    expect(page.locator('#fileMenu')).to_be_visible()
    page.keyboard.press('ArrowDown'); page.keyboard.press('ArrowDown')
    page.keyboard.press('Enter')
    expect(helpers.button(page, name)).to_be_focused()
    expect(page.locator('#pinnedSection')).to_be_hidden()
    expect(entry).to_have_count(1)

    # Filtering away the anchor must create a usable entry without stealing
    # focus from the search or category controls. Empty results have no stop.
    page.locator('[data-filter="app"]').click()
    expect(page.locator('[data-filter="app"]')).to_be_focused()
    expect(entry).to_have_count(1)
    expect(entry).to_have_attribute('data-name', 'Demo Tool')
    page.locator('#spaceSearch').fill('no-matching-entry')
    expect(entry).to_have_count(0)
    expect(page.locator('#spaceSearch')).to_be_focused()
    page.locator('#spaceSearch').fill('')
    expect(entry).to_have_count(1)
    page.locator('[data-filter="all"]').click()
    expect(entry).to_have_count(1)
    page.locator('#rovingExitProbe').evaluate('node => node.remove()')
    helpers.idle(page)


def main():
    url, stop = helpers.local_test_url()
    try:
        with sync_playwright() as playwright:
            channel = os.environ.get('DTKIT_TEST_BROWSER_CHANNEL')
            browser = playwright.chromium.launch(headless=True, **({'channel': channel} if channel else {}))
            try:
                context = browser.new_context(viewport={'width':1280,'height':700})
                context.add_init_script(helpers.MOCK_TAURI + EXTRA_MOCK.replace('__PDF_DATA__', repr(pdf_fixture())).replace('__JPX_DATA__', repr(jpx_pdf_fixture())))
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                console = []
                def capture_console(message):
                    console.append(message.text)
                    for argument in message.args:
                        argument.dispose()
                page.on('console', capture_console)
                resources = []
                page.on('response', lambda response: resources.append((response.url, response.status)))
                page.goto(url + '/desktop-organizer/space.html', wait_until='networkidle')
                helpers.open_panel(page); helpers.idle(page)
                assert_roving_file_navigation(page)

                # A sparse pinned grid sits above an independent file grid.
                helpers.card(page,'Alpha.txt').locator('.pin-button').click()
                helpers.idle(page)
                pinned = helpers.button(page,'Alpha.txt','#pinnedGrid')
                pinned.focus(); page.keyboard.press('ArrowDown')
                expect(helpers.button(page,'Archive.bin')).to_be_focused()
                page.keyboard.press('ArrowUp'); expect(pinned).to_be_focused()
                helpers.card(page,'Alpha.txt','#pinnedGrid').locator('.pin-button').click()
                helpers.idle(page)

                # Preview returns to its actual trigger even if a different file
                # was selected, and also when there was no previous selection.
                helpers.button(page,'Alpha.txt').click()
                helpers.button(page,'Fast.txt').focus(); page.keyboard.press('Space')
                expect(page.locator('#previewName')).to_have_text('Fast.txt')
                page.keyboard.press('Escape'); expect(helpers.button(page,'Fast.txt')).to_be_focused()
                page.reload(wait_until='networkidle'); helpers.open_panel(page); helpers.idle(page)
                helpers.button(page,'Fast.txt').focus(); page.keyboard.press('Space')
                page.locator('#previewClose').click(); expect(helpers.button(page,'Fast.txt')).to_be_focused()

                helpers.button(page,'Bravo.txt').click(button='right')
                page.keyboard.press('ArrowDown')
                expect(page.locator('#fileMenu [data-action="preview"]')).to_be_focused()
                page.keyboard.press('End'); expect(page.locator('#fileMenu [data-action="copy"]')).to_be_focused()
                page.keyboard.press('Home'); expect(page.locator('#fileMenu [data-action="open"]')).to_be_focused()
                page.keyboard.press('Escape'); expect(helpers.button(page,'Bravo.txt')).to_be_focused()

                # Real, valid PDF content remains in the host document. Page and
                # zoom controls work, and Escape works from inside its page area.
                helpers.preview_file(page,'Reference.pdf'); pdf_ready(page)
                assert_pdf_stable(page)
                assert page.locator('#previewContent iframe').count() == 0
                expect(page.locator('.pdf-page-count')).to_have_text('/ 2')
                page.locator('.pdf-stage').focus(); page.keyboard.press('PageDown')
                expect(page.locator('.pdf-toolbar input')).to_have_value('2'); pdf_ready(page)
                page.keyboard.press('PageUp'); expect(page.locator('.pdf-toolbar input')).to_have_value('1'); pdf_ready(page)
                before_zoom = float(page.locator('.pdf-zoom').inner_text().rstrip('%'))
                page.locator('[data-pdf="in"]').click(); pdf_ready(page)
                after_zoom = float(page.locator('.pdf-zoom').inner_text().rstrip('%'))
                assert after_zoom > before_zoom, (before_zoom,after_zoom)
                size = page.locator('.pdf-stage canvas').evaluate('canvas=>({width:canvas.width,height:canvas.height})')
                assert size['width'] <= 4096 and size['height'] <= 4096 and size['width']*size['height'] <= 8_000_000, size
                page.screenshot(path=str(OUTPUT/'pdf-preview.png'))
                page.locator('.pdf-stage').focus(); page.keyboard.press('Escape')
                expect(page.locator('#filePreview')).to_be_hidden()
                expect(helpers.button(page,'Reference.pdf')).to_be_focused()
                assert page.locator('.pdf-preview').count() == 0

                # Decode real JPEG 2000 content using only bundled resources.
                page.evaluate('window.__reviewJPX=true')
                helpers.preview_file(page,'Reference.pdf'); pdf_ready(page)
                expect(page.locator('.pdf-page-count')).to_have_text('/ 1')
                assert_jpx_color(page, console)
                page.locator('[data-pdf="in"]').click(); pdf_ready(page)
                assert_jpx_color(page, console)
                page.locator('[data-pdf="fit"]').click(); pdf_ready(page)
                assert_jpx_color(page, console)
                assert_pdf_stable(page)
                assert any('/pdfjs/wasm/openjpeg.wasm' in url and status == 200 for url, status in resources), resources
                page.screenshot(path=str(OUTPUT/'pdf-jpeg2000-preview.png'))
                page.keyboard.press('Escape')
                page.evaluate('window.__reviewJPX=false')
                # Closing during a new PDF load cannot bring the old viewer back.
                helpers.preview_file(page,'Reference.pdf'); page.keyboard.press('Escape')
                helpers.preview_file(page,'Fast.txt')
                expect(page.locator('#previewContent')).to_contain_text('SAFE-PREVIEW:Fast.txt')
                page.wait_for_timeout(150)
                assert page.locator('.pdf-preview').count() == 0
                page.keyboard.press('Escape'); helpers.idle(page)

                # Return from many different file batches: detached cards and
                # their handlers must not remain in the long-lived launcher.
                cdp = context.new_cdp_session(page)
                baseline = dom_counters(cdp)
                page.evaluate('window.__reviewFolderBatches=true')
                snapshots = []
                for trip in range(20):
                    helpers.button(page,'Project').dblclick()
                    # A boolean probe avoids Playwright's selector diagnostics
                    # retaining each matched Element in its DevTools console.
                    page.wait_for_function('name => document.querySelector("#fileGrid .file-name")?.textContent === name', arg=f'Batch{trip+1}-0.txt')
                    page.locator('#folderRoot').click(); helpers.idle(page)
                    if trip in (4, 9, 19):
                        snapshots.append(dom_counters(cdp))
                after = dom_counters(cdp)
                print(f'GC snapshots after 5/10/20 batches: {snapshots}', flush=True)
                assert after['nodes'] <= baseline['nodes'] + 650, (baseline,after)
                assert after['jsEventListeners'] <= baseline['jsEventListeners'] + 30, (baseline,after)
                assert not errors, errors
                print(f'PASS: keyboard, controlled PDF, JPEG2000 pixels, detached card GC; DOM before={baseline}, after={after}; artifacts={OUTPUT}',flush=True)
                context.close()
            finally:
                browser.close()
    finally:
        stop()


if __name__ == '__main__':
    main()
