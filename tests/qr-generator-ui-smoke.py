"""Verify production QR pages using the real QR renderer and strict native IPC.

Native filesystem and LAN commands are fixtures only. Browser exports are real
Playwright downloads, and native export payloads must contain PNG/SVG bytes.
Build once first, or set DTKIT_TEST_BASE_URL to a production preview server.
"""

import base64
import importlib.util
import re
import struct
from pathlib import Path
from xml.etree import ElementTree

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location('multi_page', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)

DEFAULT_DIRECTORY = r'D:\DtKit\Downloads'
CUSTOM_DIRECTORY = r'D:\Fixtures\QR Exports'
SHARE_SOURCE = r'D:\Fixtures\share-me.txt'
PNG_SIGNATURE = bytes((137, 80, 78, 71, 13, 10, 26, 10))
DRAFT = '\n'.join(f'第 {index:02d} 行 · QR 😀 draft' for index in range(32))

INSTRUMENTATION = r"""
(() => {
  const fixture = window.__qrFixture = {
    calls: [], dialogs: [], dialogValue: null, pendingDialogs: [], deferDialog: false,
    pendingGet: [], pendingStart: [], pendingListen: [], writes: [], clipboardWrites: [],
    deferGet: new URLSearchParams(location.search).has('fixtureDeferShare'), deferStart: false,
    deferListen: new URLSearchParams(location.search).has('fixtureDeferListen'),
    rejectWrite: false, rejectClipboard: false, unlistened: 0, sequence: 0
  };
  Object.defineProperty(fixture, 'share', {
    get: () => JSON.parse(localStorage.getItem('__qrFixtureShare') || 'null'),
    set: value => localStorage.setItem('__qrFixtureShare', JSON.stringify(value))
  });
  Object.defineProperty(fixture, 'stopCount', {
    get: () => Number(localStorage.getItem('__qrFixtureStopCount') || 0)
  });
  const expectKeys = (args, expected) => {
    const keys = Object.keys(args).filter(key => key !== 'instanceId').sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected.sort())) throw new Error('Unexpected QR IPC fields: '+keys.join(','));
  };
  const originalInvoke = window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke = async (command, args = {}) => {
    if (!['get_storage_layout','write_qr_code','get_lan_share','import_transfer_files','start_lan_share','stop_lan_share'].includes(command)) return originalInvoke(command, args);
    fixture.calls.push({command, args: structuredClone(args)});
    if (command === 'get_storage_layout') return {root:'D:\\DtKit',downloads:'D:\\DtKit\\Downloads',writable:true,warning:null};
    if (command === 'write_qr_code') {
      expectKeys(args, ['directory','filename','data']);
      if (typeof args.directory !== 'string' || !args.directory || !/^qrcode-[a-z0-9-]+\.(png|svg)$/i.test(args.filename)
        || !Array.isArray(args.data) || !args.data.length || args.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Invalid native QR export payload');
      if (fixture.rejectWrite) throw new Error('Fixture directory is read-only');
      const path = args.directory+'\\'+args.filename;
      fixture.writes.push({...structuredClone(args), path});
      return path;
    }
    if (command === 'get_lan_share') {
      expectKeys(args, []);
      const value = fixture.share;
      return fixture.deferGet ? new Promise(resolve => fixture.pendingGet.push({resolve,value})) : value;
    }
    if (command === 'import_transfer_files') {
      expectKeys(args, ['request']);
      if (JSON.stringify(Object.keys(args.request).sort()) !== JSON.stringify(['sources','ttlSeconds'])
        || args.request.ttlSeconds !== 3600 || JSON.stringify(args.request.sources) !== JSON.stringify(['D:\\Fixtures\\share-me.txt'])) throw new Error('Invalid transfer import contract');
      return {imported:[{id:'qr-fixture-item',name:'share-me.txt',size:42,createdAt:Date.now(),expiresAt:Date.now()+3600000}],totalBytes:42};
    }
    if (command === 'start_lan_share') {
      expectKeys(args, ['itemId','durationSeconds']);
      if (args.itemId !== 'qr-fixture-item' || args.durationSeconds !== 600) throw new Error('Invalid LAN start contract');
      const number = ++fixture.sequence;
      const result = {shareId:'qr-fixture-share-'+number,itemId:args.itemId,itemName:'share-me.txt',
        url:'http://192.168.1.10:4050/download?token=qr-fixture-'+number,expiresAt:Date.now()+600000};
      if (fixture.deferStart) return new Promise(resolve => fixture.pendingStart.push({result,resolve:value => {fixture.share=value; resolve(value);}}));
      fixture.share = result;
      return result;
    }
    expectKeys(args, []);
    localStorage.setItem('__qrFixtureStopCount', String(fixture.stopCount+1));
    const share = fixture.share; fixture.share = null;
    // Native worker completion may reach the listener before stop IPC resolves.
    for (const callback of window.__multiListeners['lan-share-stopped'] || []) {
      if (share) callback({payload:{shareId:share.shareId,reason:'stopped'}});
    }
    return !!share;
  };
  window.__TAURI__.dialog.open = options => {
    fixture.dialogs.push(structuredClone(options));
    if (options.multiple !== false || typeof options.directory !== 'boolean') throw new Error('Unexpected QR chooser contract');
    return fixture.deferDialog ? new Promise(resolve => fixture.pendingDialogs.push(resolve)) : Promise.resolve(fixture.dialogValue);
  };
  const originalListen = window.__TAURI__.event.listen;
  window.__TAURI__.event.listen = async (name, callback, options) => {
    if (name !== 'lan-share-stopped' || !fixture.deferListen) return originalListen(name, callback, options);
    return new Promise(resolve => fixture.pendingListen.push(() => {
      const listeners = window.__multiListeners[name] ||= new Set(); listeners.add(callback);
      resolve(() => { listeners.delete(callback); fixture.unlistened++; });
    }));
  };
  Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{
    writeText: async text => { if (fixture.rejectClipboard) throw new Error('Clipboard denied'); fixture.clipboardWrites.push(String(text)); }
  }});
})();
"""


def record_errors(page, errors):
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())


def wait_ready(frame):
    expect(frame.locator('#qrCodePreview')).to_have_attribute('data-state', 'ready', timeout=15000)
    expect(frame.locator('#qrCodePreview')).to_be_visible()
    expect(frame.locator('#qrCodePreview svg')).to_have_count(1)
    for button in frame.locator('[data-qr-download],#qrCopyContent').all():
        expect(button).to_be_enabled()


def assert_unavailable(frame):
    for button in frame.locator('[data-qr-download],#qrCopyContent').all():
        expect(button).to_be_disabled()


def set_data(frame, value):
    frame.locator('#qrDataInput').fill(value)
    wait_ready(frame)


def set_input(frame, selector, value):
    # Chromium color/range controls are changed through their native input
    # events; Playwright fill only supports text-like inputs.
    frame.locator(selector).evaluate("(node,value) => {node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));}", value)


def assert_export(write, extension, directory):
    assert write['directory'] == directory, write['directory']
    assert re.fullmatch(r'qrcode-[a-z0-9-]+\.' + extension, write['filename'], re.I), write['filename']
    assert isinstance(write['data'], list) and len(write['data']) > 100
    assert all(isinstance(value, int) and 0 <= value <= 255 for value in write['data'])
    data = bytes(write['data'])
    if extension == 'png':
        assert data.startswith(PNG_SIGNATURE), data[:16]
        width, height = struct.unpack('>II', data[16:24])
        assert 180 <= width <= 720 and width == height, (width, height)
    else:
        root = ElementTree.fromstring(data)
        assert root.tag == '{http://www.w3.org/2000/svg}svg', root.tag
        assert len(list(root.iter())) > 30, 'Export must contain a real QR matrix'
    return data


def native_export(page, frame, extension):
    before = page.evaluate('window.__qrFixture.writes.length')
    frame.locator(f'[data-qr-download="{extension}"]').click()
    page.wait_for_function('before => window.__qrFixture.writes.length === before+1', arg=before, timeout=15000)
    expect(frame.locator('#qrStatus')).to_have_attribute('data-type', 'success')
    return page.evaluate('window.__qrFixture.writes.at(-1)')


def assert_segments(frame):
    groups = frame.locator('.qr-workspace .tool-motion-segmented')
    expect(groups).to_have_count(2)
    for group in groups.all():
        expect(group).to_have_class(re.compile(r'\btool-motion-ready\b'))
        colors = group.evaluate("""node => ({
          selected:getComputedStyle(node.querySelector('button[aria-selected="true"],button[aria-pressed="true"]')).backgroundColor,
          indicator:getComputedStyle(node.querySelector('.tool-segment-indicator')).backgroundColor
        })""")
        transparent = {'transparent', 'rgba(0,0,0,0)'}
        assert colors['selected'].replace(' ', '') in transparent, colors
        assert colors['indicator'].replace(' ', '') not in transparent, colors


def exercise_contents(page, frame):
    expect(frame.locator('.qr-workspace.dev-workbench')).to_be_visible()
    wait_ready(frame)
    assert_segments(frame)
    expect(frame.locator('#qrDataInput')).to_have_value('https://example.com')
    set_data(frame, 'mailto:hello@example.com')
    frame.locator('[data-qr-prefix="tel:"]').click()
    expect(frame.locator('#qrDataInput')).to_have_value('tel:hello@example.com')
    frame.locator('[data-qr-prefix=""]').click()
    expect(frame.locator('#qrDataInput')).to_have_value('hello@example.com')
    expect(frame.locator('#qrDataCount')).to_contain_text('17')
    wait_ready(frame)
    set_data(frame, '二维码 · DtKit 😀\nhttps://example.com/?q=中文')
    frame.locator('#qrCopyContent').click()
    page.wait_for_function('window.__qrFixture.clipboardWrites.at(-1) === "二维码 · DtKit 😀\\nhttps://example.com/?q=中文"')
    page.evaluate('window.__qrFixture.rejectClipboard = true')
    frame.locator('#qrCopyContent').click()
    expect(frame.locator('#qrStatus')).to_have_attribute('data-type', 'error')
    page.evaluate('window.__qrFixture.rejectClipboard = false')

    # Changes invalidate buttons in the same JS turn, before debounce or draw.
    frame.evaluate("""() => {
      const input = document.getElementById('qrDataInput'); input.value = 'new payload before debounce';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      window.__qrImmediateDisabled = [...document.querySelectorAll('[data-qr-download],#qrCopyContent')].every(button => button.disabled);
      document.querySelector('[data-qr-download="svg"]').click();
    }""")
    assert frame.evaluate('window.__qrImmediateDisabled') is True
    wait_ready(frame)
    for value, state in [('', 'empty'), (' \n\t ', 'empty'), ('中文😀' * 700, 'error')]:
        frame.locator('#qrDataInput').fill(value)
        expect(frame.locator('#qrCodePreview')).to_have_attribute('data-state', state, timeout=15000)
        expect(frame.locator('#qrCodePreview')).to_be_hidden()
        expect(frame.locator('#qrPreviewEmpty')).to_be_visible()
        assert_unavailable(frame)
        if state == 'error':
            expect(frame.locator('#qrStatus')).to_have_attribute('data-type', 'error')

    # A payload may fit QR capacity while its matrix cannot fit the selected
    # raster size. Increasing the size must recover the same unedited content.
    set_input(frame, '#qrSize', '180')
    frame.locator('#qrDataInput').fill('a' * 1300)
    expect(frame.locator('#qrCodePreview')).to_have_attribute('data-state', 'error', timeout=15000)
    expect(frame.locator('#qrStatus')).to_contain_text('尺寸')
    assert_unavailable(frame)
    set_input(frame, '#qrSize', '720')
    wait_ready(frame)
    expect(frame.locator('#qrDataInput')).to_have_value('a' * 1300)
    set_data(frame, 'ready again after capacity error')
    set_input(frame, '#qrForeground', '#ffffff')
    expect(frame.locator('#qrContrastBadge')).to_contain_text('对比度')
    wait_ready(frame)
    frame.locator('#qrResetStyle').click()
    wait_ready(frame)


def exercise_native_export(page, frame):
    expect(frame.locator('#qrSaveDirectory')).to_have_text('默认下载目录')
    set_data(frame, 'native export payload A')
    png = native_export(page, frame, 'png')
    assert_export(png, 'png', DEFAULT_DIRECTORY)
    old_svg = assert_export(native_export(page, frame, 'svg'), 'svg', DEFAULT_DIRECTORY)
    assert png['filename'] != page.evaluate('window.__qrFixture.writes.at(-1).filename')
    dialogs_before = page.evaluate('window.__qrFixture.dialogs.length')
    page.evaluate('window.__qrFixture.dialogValue = null')
    frame.locator('#qrChooseDirectory').click()
    expect(frame.locator('#qrSaveDirectory')).to_have_text('默认下载目录')
    page.wait_for_function('before => window.__qrFixture.dialogs.length === before+1', arg=dialogs_before)
    assert page.evaluate('window.__qrFixture.dialogs.at(-1).directory') is True
    page.evaluate('value => window.__qrFixture.dialogValue = value', CUSTOM_DIRECTORY)
    frame.locator('#qrChooseDirectory').click()
    expect(frame.locator('#qrSaveDirectory')).to_contain_text(CUSTOM_DIRECTORY)
    assert_export(native_export(page, frame, 'svg'), 'svg', CUSTOM_DIRECTORY)
    page.evaluate('window.__qrFixture.rejectWrite = true')
    frame.locator('[data-qr-download="png"]').click()
    expect(frame.locator('#qrStatus')).to_have_attribute('data-type', 'error')
    page.evaluate('window.__qrFixture.rejectWrite = false')
    wait_ready(frame)
    frame.locator('#qrDefaultDirectory').click()
    expect(frame.locator('#qrSaveDirectory')).to_have_text('默认下载目录')

    # A render selected after export began must prevent the old blob being saved.
    before = page.evaluate('window.__qrFixture.writes.length')
    frame.evaluate("""() => {
      window.__qrOriginalArrayBuffer = Blob.prototype.arrayBuffer; window.__qrPendingBlobReads = [];
      Blob.prototype.arrayBuffer = function() { const blob=this;
        return new Promise(resolve => window.__qrPendingBlobReads.push(async () => resolve(await window.__qrOriginalArrayBuffer.call(blob)))); };
    }""")
    try:
        frame.locator('[data-qr-download="svg"]').click()
        frame.wait_for_function('window.__qrPendingBlobReads.length >= 1')
        frame.locator('#qrDataInput').fill('latest export payload B · 中文 😀')
        frame.evaluate("""async () => {
          Blob.prototype.arrayBuffer = window.__qrOriginalArrayBuffer;
          for (const complete of window.__qrPendingBlobReads.splice(0)) await complete();
          await Promise.resolve();
        }""")
        wait_ready(frame)
        assert page.evaluate('window.__qrFixture.writes.length') == before, 'Stale export wrote old bytes'
    finally:
        frame.evaluate('() => { Blob.prototype.arrayBuffer = window.__qrOriginalArrayBuffer; }')
    latest_svg = assert_export(native_export(page, frame, 'svg'), 'svg', DEFAULT_DIRECTORY)
    assert latest_svg != old_svg
    # The exported SVG is the current real preview, including the matrix paths.
    expected_shapes = frame.locator('#qrCodePreview svg').evaluate("""svg => [...svg.querySelectorAll('path,rect,circle,ellipse,polygon')].map(node => [node.localName,
      [...node.attributes].filter(attr => !['id','fill','clip-path'].includes(attr.name)).map(attr => [attr.name,attr.value])])""")
    exported_shapes = frame.evaluate("""text => {
      const svg = new DOMParser().parseFromString(text,'image/svg+xml').documentElement;
      return [...svg.querySelectorAll('path,rect,circle,ellipse,polygon')].map(node => [node.localName,
        [...node.attributes].filter(attr => !['id','fill','clip-path'].includes(attr.name)).map(attr => [attr.name,attr.value])]);
    }""", latest_svg.decode('utf-8'))
    assert exported_shapes == expected_shapes, 'Export differs from latest QR preview'

    # Suspending invalidates an export even if the page resumes with the same
    # rendered payload before its Blob read completes.
    before = page.evaluate('window.__qrFixture.writes.length')
    frame.evaluate("""() => {
      window.__qrPendingBlobReads = [];
      Blob.prototype.arrayBuffer = function() { const blob=this;
        return new Promise(resolve => window.__qrPendingBlobReads.push(async () => resolve(await window.__qrOriginalArrayBuffer.call(blob)))); };
    }""")
    try:
        frame.locator('[data-qr-download="svg"]').click()
        frame.wait_for_function('window.__qrPendingBlobReads.length >= 1')
        frame.evaluate("""async () => {
          window.__DTKIT_TOOL_PAGE__.setSuspended(true);
          window.__DTKIT_TOOL_PAGE__.setSuspended(false);
          Blob.prototype.arrayBuffer = window.__qrOriginalArrayBuffer;
          for (const complete of window.__qrPendingBlobReads.splice(0)) await complete();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        }""")
        wait_ready(frame)
        assert page.evaluate('window.__qrFixture.writes.length') == before, 'Suspended export wrote bytes after resume'
    finally:
        frame.evaluate('() => { Blob.prototype.arrayBuffer = window.__qrOriginalArrayBuffer; }')
    assert_export(native_export(page, frame, 'svg'), 'svg', DEFAULT_DIRECTORY)
    filenames = page.evaluate('window.__qrFixture.writes.map(write => write.filename)')
    assert len(filenames) == len(set(filenames)), filenames


def exercise_logo(page, frame):
    png = frame.evaluate("""() => {
      const canvas=document.createElement('canvas'); canvas.width=512; canvas.height=128;
      const ctx=canvas.getContext('2d'); ctx.fillStyle='#0071e3';ctx.fillRect(0,0,512,128);
      return canvas.toDataURL('image/png').split(',')[1];
    }""")
    frame.locator('#qrLogo').set_input_files({'name':'logo.png','mimeType':'image/png','buffer':base64.b64decode(png)})
    wait_ready(frame)
    frame.wait_for_function('window.__DTKIT_TOOL_PAGE__.snapshot().state.image?.startsWith("data:image/png;base64,")')
    image = frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state.image')
    dimensions = frame.evaluate("""async src => {const image=new Image();image.src=src;await image.decode();return [image.width,image.height];}""", image)
    assert dimensions == [256, 64], dimensions
    svg = assert_export(native_export(page, frame, 'svg'), 'svg', DEFAULT_DIRECTORY)
    embedded_images = list(ElementTree.fromstring(svg).iter('{http://www.w3.org/2000/svg}image'))
    assert len(embedded_images) == 1
    assert embedded_images[0].get('href') == image, 'SVG must embed the normalized local logo'
    assert_export(native_export(page, frame, 'png'), 'png', DEFAULT_DIRECTORY)
    before = frame.locator('#qrStatus').text_content()
    frame.locator('#qrLogo').set_input_files([])
    assert frame.locator('#qrStatus').text_content() == before, 'Cancelling a logo chooser is not an error'
    frame.locator('#qrLogo').set_input_files({'name':'invalid.png','mimeType':'image/png','buffer':b'not a PNG'})
    expect(frame.locator('#qrStatus')).to_have_attribute('data-type', 'error')
    frame.locator('#qrLogo').set_input_files({'name':'too-large.png','mimeType':'image/png','buffer':b'x' * (5*1024*1024+1)})
    expect(frame.locator('#qrStatus')).to_have_attribute('data-type', 'error')
    expect(frame.locator('#qrStatus')).to_contain_text('5')
    frame.locator('#qrClearLogo').click()
    wait_ready(frame)
    assert frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state.image') is None
    # Keep a compact normalized logo in the persisted draft.
    frame.locator('#qrLogo').set_input_files({'name':'persisted.png','mimeType':'image/png','buffer':base64.b64decode(png)})
    wait_ready(frame)
    frame.wait_for_function('window.__DTKIT_TOOL_PAGE__.snapshot().state.image !== null')


def capture_draft(page, frame):
    set_data(frame, DRAFT)
    frame.locator('#qrDots').select_option('square')
    frame.locator('#qrCorners').select_option('square')
    set_input(frame, '#qrForeground', '#112233')
    set_input(frame, '#qrBackground', '#f4f6f8')
    set_input(frame, '#qrSize', '480')
    page.evaluate('value => window.__qrFixture.dialogValue = value', CUSTOM_DIRECTORY)
    frame.locator('#qrChooseDirectory').click()
    expect(frame.locator('#qrSaveDirectory')).to_contain_text(CUSTOM_DIRECTORY)
    wait_ready(frame)
    scroll = frame.locator('#qrDataInput').evaluate('node => {node.setSelectionRange(3,11);node.scrollTop=80;return node.scrollTop;}')
    snapshot = frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    assert snapshot['state'] is not None and snapshot['state']['version'] == 1
    assert snapshot['canRelease'] is True
    return snapshot, scroll


def expect_draft(frame, scroll):
    expect(frame.locator('#qrDataInput')).to_have_value(DRAFT)
    expect(frame.locator('[data-qr-tab="create"]')).to_have_attribute('aria-selected', 'true')
    expect(frame.locator('#qrDots')).to_have_value('square')
    expect(frame.locator('#qrCorners')).to_have_value('square')
    expect(frame.locator('#qrForeground')).to_have_value('#112233')
    expect(frame.locator('#qrBackground')).to_have_value('#f4f6f8')
    expect(frame.locator('#qrSize')).to_have_value('480')
    expect(frame.locator('#qrSaveDirectory')).to_contain_text(CUSTOM_DIRECTORY)
    wait_ready(frame)
    state = frame.locator('#qrDataInput').evaluate('node => ({selection:[node.selectionStart,node.selectionEnd],scroll:node.scrollTop})')
    assert state['selection'] == [3, 11], state
    assert abs(state['scroll']-scroll) <= 2, (state, scroll)
    assert frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state.image?.startsWith("data:image/png;base64,")') is True


def exercise_restore(page, frame):
    snapshot, scroll = capture_draft(page, frame)
    set_data(frame, 'changed after snapshot')
    frame.locator('#qrResetStyle').click()
    frame.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    expect_draft(frame, scroll)
    # A stale folder chooser must not overwrite a restored destination.
    page.evaluate('window.__qrFixture.deferDialog = true')
    frame.locator('#qrChooseDirectory').click()
    page.wait_for_function('window.__qrFixture.pendingDialogs.length === 1')
    frame.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    page.evaluate('() => {window.__qrFixture.pendingDialogs.shift()("D:\\Old Chooser");window.__qrFixture.deferDialog=false;}')
    expect_draft(frame, scroll)
    return scroll


def exercise_layout(page, frame, entry):
    for width in (680, 390):
        page.set_viewport_size({'width':page.evaluate('innerWidth')+width-frame.evaluate('innerWidth'),'height':940})
        frame.wait_for_function('width => innerWidth === width', arg=width)
        metrics = frame.evaluate("""() => ({viewport:innerWidth,document:document.documentElement.scrollWidth,
          tool:document.querySelector('.qr-workspace').scrollWidth,width:document.querySelector('.qr-workspace').clientWidth})""")
        assert metrics['document'] <= metrics['viewport']+1 and metrics['tool'] <= metrics['width']+1, metrics
        assert_segments(frame)
        page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-qr-{entry}-{width}.png'), full_page=True)
    page.emulate_media(color_scheme='dark', reduced_motion='reduce')
    expect(frame.locator('.qr-workspace')).to_have_css('color-scheme', 'dark')
    expect(frame.locator('[data-qr-download="png"]')).to_have_css('transition-duration', '0s')
    assert_segments(frame)
    page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-qr-{entry}-dark.png'), full_page=True)


def test_quick(context, base_url, errors):
    page = context.new_page(); record_errors(page, errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=qr-generator', wait_until='networkidle')
    expect(page.locator('#qrDataInput')).to_be_visible()
    assert page.locator('.sidebar,#tabBar,iframe.tool-page-frame').count() == 0
    exercise_contents(page, page)
    exercise_native_export(page, page)
    exercise_logo(page, page)
    exercise_restore(page, page)
    exercise_layout(page, page, 'quick')
    page.close()


def test_embedded(context, base_url, errors):
    page = context.new_page(); record_errors(page, errors)
    page.goto(base_url, wait_until='networkidle')
    page.locator('[data-tool-id="qr-generator"] .tool-card__title').click()
    frame = multi.active_tool_frame(page, '.qr-workspace.dev-workbench')
    exercise_contents(page, frame)
    exercise_native_export(page, frame)
    exercise_logo(page, frame)
    scroll = exercise_restore(page, frame)
    tab_a = multi.active_tab_id(page)
    multi.click_page_action(page, 'new')
    second = multi.active_tool_frame(page, '#qrDataInput')
    tab_b = multi.active_tab_id(page)
    expect(second.locator('#qrDataInput')).to_have_value('https://example.com')
    set_data(second, 'second independent QR draft')
    multi.switch_tab(page, tab_a)
    expect_draft(frame, scroll)
    assert page.evaluate('window.__DTKIT_TOOL_WORKSPACE__.persist({prepareSleep:true})') is True
    page.reload(wait_until='networkidle')
    restored = multi.active_tool_frame(page, '#qrDataInput')
    expect_draft(restored, scroll)
    multi.switch_tab(page, tab_b)
    expect(multi.active_tool_frame(page, '#qrDataInput').locator('#qrDataInput')).to_have_value('second independent QR draft')
    multi.switch_tab(page, tab_a)
    restored = multi.active_tool_frame(page, '#qrDataInput')
    exercise_layout(page, restored, 'embedded')
    page.close()


def test_browser_downloads(context, base_url, errors):
    page = context.new_page(); record_errors(page, errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=qr-generator', wait_until='networkidle')
    wait_ready(page)
    page.evaluate('() => {window.__qrSavedInvoke=window.__TAURI__.core.invoke;delete window.__TAURI__.core.invoke;}')
    set_data(page, 'real browser downloads · 中文 😀')
    for extension in ('png', 'svg'):
        with page.expect_download(timeout=15000) as event:
            page.locator(f'[data-qr-download="{extension}"]').click()
        download = event.value
        assert download.failure() is None
        data = Path(download.path()).read_bytes()
        assert_export({'directory':'browser','filename':download.suggested_filename,'data':list(data)}, extension, 'browser')
        expect(page.locator('#qrStatus')).to_have_attribute('data-type', 'success')
    assert page.evaluate('window.__qrFixture.writes.length') == 0
    page.close()


def emit_share_stopped(page, share_id):
    page.evaluate("""shareId => {for(const callback of window.__multiListeners['lan-share-stopped'] || []) callback({payload:{shareId,reason:'downloaded'}});}""", share_id)


def test_lan_lifecycle(context, base_url, errors):
    page = context.new_page(); record_errors(page, errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=qr-generator&fixtureDeferShare=1', wait_until='networkidle')
    expect(page.locator('#qrDataInput')).to_be_visible()
    page.wait_for_function('window.__qrFixture.pendingGet.length >= 1')
    page.locator('[data-qr-tab="temporary"]').click()
    expect(page.locator('#qrTemporaryPanel')).to_be_visible()
    expect(page.locator('#qrPreviewEmpty')).to_be_visible()
    expect(page.locator('#qrCodePreview')).to_be_hidden()
    expect(page.locator('.qr-temp-intro')).to_contain_text('10')
    assert_unavailable(page)
    page.evaluate('value => window.__qrFixture.dialogValue=value', SHARE_SOURCE)
    page.locator('#qrChooseFile').click()
    expect(page.locator('#qrShareCard')).to_be_visible()
    wait_ready(page)
    share = page.evaluate('window.__qrFixture.share')
    expect(page.locator('#qrShareUrl')).to_have_value(share['url'])
    page.evaluate('() => {for(const request of window.__qrFixture.pendingGet.splice(0)) request.resolve(request.value);window.__qrFixture.deferGet=false;}')
    expect(page.locator('#qrShareUrl')).to_have_value(share['url'])
    expect(page.locator('#qrShareCard')).to_be_visible()
    emit_share_stopped(page, 'foreign-share')
    expect(page.locator('#qrShareCard')).to_be_visible()
    page.locator('[data-qr-tab="create"]').click()
    expect(page.locator('#qrDataInput')).to_have_value('https://example.com')
    page.locator('[data-qr-tab="temporary"]').click()
    wait_ready(page)
    page.evaluate('window.__qrFixture.share=null')
    emit_share_stopped(page, share['shareId'])
    expect(page.locator('#qrShareCard')).to_be_hidden()
    expect(page.locator('#qrPreviewEmpty')).to_be_visible()
    assert_unavailable(page)

    # Once native start was requested, closing the view must not stop the share
    # or let its later response touch a disposed UI. Re-entry reads native state.
    page.evaluate('window.__qrFixture.deferStart=true')
    page.locator('#qrChooseFile').click()
    page.wait_for_function('window.__qrFixture.pendingStart.length === 1')
    before = page.evaluate('window.__qrFixture.stopCount')
    page.evaluate('() => {window.__qrDisposal=window.__DTKIT_TOOL_PAGE__.dispose();}')
    page.evaluate('() => {const request=window.__qrFixture.pendingStart.shift();request.resolve(request.result);window.__qrFixture.deferStart=false;}')
    page.evaluate('async () => {await window.__qrDisposal;}')
    assert page.evaluate('window.__qrFixture.stopCount') == before
    latest = page.evaluate('window.__qrFixture.share')
    assert latest is not None
    page.goto(base_url+'/quick.html?kind=tool&toolId=qr-generator', wait_until='networkidle')
    wait_ready(page)
    page.locator('[data-qr-tab="temporary"]').click()
    expect(page.locator('#qrShareCard')).to_be_visible()
    expect(page.locator('#qrShareUrl')).to_have_value(latest['url'])
    wait_ready(page)
    page.locator('#qrStopShare').click()
    expect(page.locator('#qrShareCard')).to_be_hidden()
    expect(page.locator('#qrChooseFile')).to_be_enabled()
    expect(page.locator('#qrStopShare')).to_be_enabled()
    assert page.evaluate('window.__qrFixture.share') is None
    assert page.evaluate('window.__qrFixture.stopCount') == before+1
    page.close()


def test_late_listener(context, base_url, errors):
    page = context.new_page(); record_errors(page, errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=qr-generator&fixtureDeferListen=1', wait_until='networkidle')
    expect(page.locator('#qrDataInput')).to_be_visible()
    page.wait_for_function('window.__qrFixture.pendingListen.length === 1')
    page.evaluate('() => {window.__qrDisposal=window.__DTKIT_TOOL_PAGE__.dispose();}')
    page.evaluate('() => window.__qrFixture.pendingListen.shift()()')
    page.evaluate('async () => {await window.__qrDisposal;}')
    assert page.evaluate('window.__multiListeners["lan-share-stopped"]?.size || 0') == 0
    assert page.evaluate('window.__qrFixture.unlistened') >= 1
    page.close()


def run(base_url):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width':1440,'height':940}, reduced_motion='reduce', accept_downloads=True)
        context.add_init_script(multi.MOCK+'\n'+INSTRUMENTATION)

        def apply_csp(route):
            response = route.fetch(); headers = dict(response.headers)
            if 'text/html' in headers.get('content-type', ''):
                headers['content-security-policy'] = multi.CSP
            route.fulfill(response=response, headers=headers)

        context.route(base_url+'/**', apply_csp)
        try:
            print('QR UI: standalone real rendering, native PNG/SVG, logo, races and drafts', flush=True)
            test_quick(context, base_url, errors)
            print('QR UI: embedded independent pages, workspace reload and responsive layout', flush=True)
            test_embedded(context, base_url, errors)
            print('QR UI: real browser PNG/SVG downloads', flush=True)
            test_browser_downloads(context, base_url, errors)
            print('QR UI: LAN sharing contracts and disposed-view guards', flush=True)
            test_lan_lifecycle(context, base_url, errors)
            test_late_listener(context, base_url, errors)
            assert not errors, errors
        except Exception:
            for index, page in enumerate(context.pages):
                page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-qr-failure-{index}.png'), full_page=True)
            raise
        finally:
            context.close(); browser.close()
    print(f'QR generator UI smoke passed; screenshots={multi.SCREENSHOTS}')


if __name__ == '__main__':
    with multi.production_url() as base_url:
        run(base_url)
