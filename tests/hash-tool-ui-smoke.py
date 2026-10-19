"""Verify production Hash pages with real workers and strict native IPC fixtures.

Python hashlib supplies the independent digest oracle. Native file paths are
fixtures only; this script never opens real dialogs or reads native files.
Build once first, or set DTKIT_TEST_BASE_URL to a production preview server.
"""

import hashlib
import importlib.util
import json
import re
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location('multi_page', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)

ALGORITHMS = ('md5', 'sha1', 'sha256', 'sha512')
LABELS = {'md5': 'MD5', 'sha1': 'SHA-1', 'sha256': 'SHA-256', 'sha512': 'SHA-512'}
NATIVE_TEXTS = ('native 中文 😀', 'older native request', 'latest native request', 'native restored draft')
FILE_BYTES = bytes(range(256)) + '文件内容 😀\n'.encode('utf-8')
FILE_PATH = r'D:\Fixtures\hash-data.bin'
DRAFT = '\n'.join(f'第 {index:03d} 行 · Hash 😀 / + ?' for index in range(100))


def digests(value):
    data = value.encode('utf-8') if isinstance(value, str) else value
    return {algorithm: hashlib.new(algorithm, data).hexdigest() for algorithm in ALGORITHMS}


INSTRUMENTATION = r"""
(() => {
  const fixture = window.__hashFixture = {
    textResults: TEXT_RESULTS, fileResults: FILE_RESULTS, filePath: FILE_PATH,
    nativeCalls: [], pendingNative: [], deferNative: false, malformedNative: false,
    dialogValue: null, pendingDialogs: [], deferDialog: false,
    clipboardText: '', writes: [], pendingReads: [], deferRead: false,
    rejectRead: false, rejectWrite: false
  };
  const originalInvoke = window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke = async (command, args = {}) => {
    if (!['calculate_text_hash', 'calculate_file_hash'].includes(command)) return originalInvoke(command, args);
    fixture.nativeCalls.push({command, args: structuredClone(args)});
    const expected = command === 'calculate_text_hash'
      ? ['algorithms', 'text', 'uppercase'] : ['algorithms', 'filePath', 'taskId', 'uppercase'];
    const keys = Object.keys(args).filter(key => key !== 'instanceId').sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected.sort())) throw new Error('Unexpected native Hash arguments');
    if (args.uppercase !== false || !Array.isArray(args.algorithms) || !args.algorithms.length
      || args.algorithms.some(id => !['md5','sha1','sha256','sha512'].includes(id))) throw new Error('Invalid Hash options');
    let source;
    if (command === 'calculate_text_hash') {
      if (typeof args.text !== 'string' || !Object.hasOwn(fixture.textResults, args.text)) throw new Error('Unexpected native text fixture');
      source = fixture.textResults[args.text];
    } else {
      if (args.filePath !== fixture.filePath || typeof args.taskId !== 'string' || !args.taskId) throw new Error('Invalid native file fixture');
      source = fixture.fileResults;
    }
    const results = Object.fromEntries(args.algorithms.map(id => [id, source[id]]));
    if (fixture.malformedNative) results[args.algorithms[0]] = 'not a hash';
    if (fixture.deferNative) return new Promise((resolve, reject) => fixture.pendingNative.push({resolve, reject, results, command, args}));
    return results;
  };
  window.__TAURI__.dialog.open = () => fixture.deferDialog
    ? new Promise(resolve => fixture.pendingDialogs.push(resolve)) : Promise.resolve(fixture.dialogValue);
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
    writeText: async text => { if (fixture.rejectWrite) throw new Error('Clipboard denied'); fixture.writes.push(String(text)); },
    readText: () => fixture.rejectRead ? Promise.reject(new Error('Clipboard denied'))
      : fixture.deferRead ? new Promise(resolve => fixture.pendingReads.push(resolve)) : Promise.resolve(fixture.clipboardText)
  }});
  const stats = window.__hashWorkers = {created: 0, sent: [], received: 0, terminated: 0, held: [], behavior: 'normal'};
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) { super(...args); stats.created++; this.addEventListener('message', () => stats.received++); }
    postMessage(message, ...args) {
      stats.sent.push({id: message.id, text: message.text, byteLength: message.bytes?.byteLength, algorithms: message.algorithms});
      if (stats.behavior === 'hold') { stats.held.push(() => super.postMessage(message, ...args)); return; }
      if (stats.behavior === 'error') { queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', {message: 'Fixture worker error', cancelable: true}))); return; }
      if (stats.behavior === 'messageerror') { queueMicrotask(() => this.dispatchEvent(new MessageEvent('messageerror'))); return; }
      return super.postMessage(message, ...args);
    }
    terminate() { stats.terminated++; return super.terminate(); }
  };
})();
""".replace('TEXT_RESULTS', json.dumps({text: digests(text) for text in NATIVE_TEXTS}, ensure_ascii=False)) \
    .replace('FILE_RESULTS', json.dumps(digests(FILE_BYTES))) \
    .replace('FILE_PATH', json.dumps(FILE_PATH))


def native_off(frame):
    frame.evaluate("() => { window.__hashSavedInvoke = window.__TAURI__.core.invoke; delete window.__TAURI__.core.invoke; }")


def select_mode(frame, mode):
    button = frame.locator(f'[data-hash-mode="{mode}"]')
    button.click()
    expect(button).to_have_attribute('aria-pressed', 'true')


def set_switch(frame, selector, enabled):
    button = frame.locator(selector)
    if (button.get_attribute('aria-checked') == 'true') != enabled:
        button.click()
    expect(button).to_have_attribute('aria-checked', str(enabled).lower())


def set_algorithms(frame, algorithms=ALGORITHMS):
    for algorithm in ALGORITHMS:
        set_switch(frame, f'.hash-switch[data-algo="{algorithm}"]', algorithm in algorithms)


def assert_results(frame, source, algorithms=ALGORITHMS, uppercase=False):
    expected = digests(source)
    expect(frame.locator('#hashCopyAllBtn')).to_be_enabled(timeout=10000)
    expect(frame.locator('#hashCalculateBtn')).to_be_enabled()
    expect(frame.locator('#hashStatus')).to_have_attribute('data-tone', 'success')
    expect(frame.locator('#hashResultsList .hash-result-pill')).to_have_count(len(algorithms))
    for algorithm in algorithms:
        value = expected[algorithm].upper() if uppercase else expected[algorithm]
        expect(frame.locator(f'#hashResultsList .hash-result-pill[data-algo="{algorithm}"] .hash-string')).to_have_text(value)
        expect(frame.locator(f'#hashResultsList .hash-copy-btn[data-algo="{algorithm}"]')).to_be_enabled()


def assert_stale(frame):
    expect(frame.locator('#hashCopyAllBtn')).to_be_disabled()
    for button in frame.locator('#hashResultsList .hash-copy-btn').all():
        expect(button).to_be_disabled()
    expect(frame.locator('#hashVerifyResult')).not_to_have_attribute('data-tone', 'success')


def calculate_text(frame, text, algorithms=ALGORITHMS, uppercase=False):
    select_mode(frame, 'text')
    set_algorithms(frame, algorithms)
    set_switch(frame, '[data-option="uppercase"]', uppercase)
    frame.locator('#hashTextInput').fill(text)
    frame.locator('#hashCalculateBtn').click()
    assert_results(frame, text, algorithms, uppercase)


def exercise_real_worker(frame):
    expect(frame.locator('.hash-tool-view.dev-workbench')).to_be_visible()
    native_off(frame)
    for text in ('', ' \t\n ', '中文与 emoji 😀\nkeep every byte'):
        calculate_text(frame, text)
    expect(frame.locator('#hashInputMeta')).to_contain_text(str(len('中文与 emoji 😀\nkeep every byte'.encode('utf-8'))))
    assert frame.evaluate('window.__hashWorkers.created') >= 3
    assert frame.evaluate('window.__hashWorkers.received') >= 3
    set_switch(frame, '[data-option="uppercase"]', True)
    assert_results(frame, '中文与 emoji 😀\nkeep every byte', uppercase=True)
    set_switch(frame, '[data-option="uppercase"]', False)
    assert_results(frame, '中文与 emoji 😀\nkeep every byte')
    frame.locator('#hashVerifyInput').fill(digests('中文与 emoji 😀\nkeep every byte')['sha256'].upper())
    expect(frame.locator('#hashVerifyResult')).to_have_attribute('data-tone', 'success')
    frame.locator('#hashVerifyInput').fill('g' * 32)
    expect(frame.locator('#hashVerifyResult')).to_have_attribute('data-tone', 'error')
    frame.locator('#hashVerifyInput').fill('0' * 31)
    expect(frame.locator('#hashVerifyResult')).to_have_attribute('data-tone', 'error')
    frame.locator('#hashVerifyInput').fill('0' * 64)
    expect(frame.locator('#hashVerifyResult')).to_have_attribute('data-tone', 'error')
    frame.locator('#hashTextInput').fill('a newer draft')
    assert_stale(frame)
    frame.locator('#hashTextInput').press('Control+Enter')
    assert_results(frame, 'a newer draft')
    set_switch(frame, '.hash-switch[data-algo="sha512"]', False)
    assert_stale(frame)
    frame.locator('#hashCalculateBtn').click()
    assert_results(frame, 'a newer draft', ALGORITHMS[:3])
    frame.locator('#hashVerifyInput').fill(digests('a newer draft')['sha512'])
    expect(frame.locator('#hashVerifyResult')).to_have_attribute('data-tone', 'neutral')
    expect(frame.locator('#hashVerifyResult')).to_contain_text('未包含')
    set_algorithms(frame, ())
    frame.locator('#hashCalculateBtn').click()
    expect(frame.locator('#hashStatus')).to_have_attribute('data-tone', 'error')
    assert_stale(frame)
    set_algorithms(frame)


def exercise_worker_failures(frame):
    select_mode(frame, 'text')
    for behavior in ('error', 'messageerror'):
        frame.evaluate('behavior => window.__hashWorkers.behavior = behavior', behavior)
        frame.locator('#hashTextInput').fill('worker failure ' + behavior)
        frame.locator('#hashCalculateBtn').click()
        expect(frame.locator('#hashStatus')).to_have_attribute('data-tone', 'error')
        expect(frame.locator('#hashCalculateBtn')).to_be_enabled()
        expect(frame.locator('#hashProgressContainer')).to_be_hidden()
        assert_stale(frame)
    frame.evaluate("window.__hashWorkers.behavior = 'hold'")
    frame.locator('#hashTextInput').fill('old held worker')
    frame.locator('#hashCalculateBtn').click()
    frame.wait_for_function('window.__hashWorkers.held.length === 1')
    terminated = frame.evaluate('window.__hashWorkers.terminated')
    frame.locator('#hashTextInput').fill('new draft cancels old worker')
    assert frame.evaluate('window.__hashWorkers.terminated') > terminated
    frame.evaluate("() => { window.__hashWorkers.held.shift()(); window.__hashWorkers.behavior = 'normal'; }")
    assert_stale(frame)
    frame.locator('#hashCalculateBtn').click()
    assert_results(frame, 'new draft cancels old worker')
    frame.evaluate("window.__hashWorkers.behavior = 'hold'")
    frame.locator('#hashCalculateBtn').click()
    expect(frame.locator('#hashCancelBtn')).to_be_visible()
    frame.locator('#hashCancelBtn').click()
    expect(frame.locator('#hashCalculateBtn')).to_be_enabled()
    expect(frame.locator('#hashProgressContainer')).to_be_hidden()
    assert_stale(frame)
    frame.evaluate("() => { window.__hashWorkers.held.length = 0; window.__hashWorkers.behavior = 'normal'; }")
    calculate_text(frame, 'recovered after worker errors')
    frame.evaluate("window.__hashWorkers.behavior = 'hold'")
    frame.locator('#hashCalculateBtn').click()
    frame.wait_for_function('window.__hashWorkers.held.length === 1')
    frame.evaluate("window.dispatchEvent(new CustomEvent('dtkit:power-state', {detail:{suspended:true}}))")
    expect(frame.locator('#hashCalculateBtn')).to_be_enabled()
    expect(frame.locator('#hashProgressContainer')).to_be_hidden()
    assert_stale(frame)
    frame.evaluate("""() => { window.__hashWorkers.held.length = 0; window.__hashWorkers.behavior = 'normal';
      window.dispatchEvent(new CustomEvent('dtkit:power-state', {detail:{suspended:false}})); }""")
    frame.locator('#hashCalculateBtn').click()
    assert_results(frame, 'recovered after worker errors')


def exercise_browser_files(frame):
    select_mode(frame, 'file')
    frame.locator('#hashFileInput').set_input_files({'name': 'binary-fixture.bin', 'mimeType': 'application/octet-stream', 'buffer': FILE_BYTES})
    expect(frame.locator('#hashFileName')).to_have_text('binary-fixture.bin')
    expect(frame.locator('.hash-clear-file')).to_be_enabled()
    frame.locator('#hashCalculateBtn').click()
    assert_results(frame, FILE_BYTES)
    snapshot = frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    assert snapshot['state']['file']['path'] is None
    frame.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    expect(frame.locator('#hashStatus')).to_contain_text('重新选择')
    assert_stale(frame)
    expect(frame.locator('#hashResultsList .hash-result-pill')).to_have_count(0)
    frame.locator('.hash-clear-file').click()
    expect(frame.locator('#hashFileName')).to_have_text('将文件拖放到这里')
    frame.locator('#hashCalculateBtn').click()
    expect(frame.locator('#hashStatus')).to_have_attribute('data-tone', 'error')
    frame.locator('#hashFileInput').set_input_files({'name': 'empty.bin', 'mimeType': 'application/octet-stream', 'buffer': b''})
    frame.locator('#hashCalculateBtn').click()
    assert_results(frame, b'')
    # Replacing a file while its asynchronous read is unresolved must not let
    # the old read replace the later file's completed result.
    frame.evaluate("""() => {
      window.__hashOriginalFileRead = File.prototype.arrayBuffer; window.__hashPendingFileReads = [];
      File.prototype.arrayBuffer = function() { const file = this;
        return new Promise(resolve => window.__hashPendingFileReads.push(async () => resolve(await window.__hashOriginalFileRead.call(file)))); };
    }""")
    try:
        frame.locator('#hashFileInput').set_input_files({'name': 'older.bin', 'mimeType': 'application/octet-stream', 'buffer': FILE_BYTES})
        frame.locator('#hashCalculateBtn').click()
        frame.wait_for_function('window.__hashPendingFileReads.length === 1')
        frame.locator('#hashFileInput').set_input_files({'name': 'latest.bin', 'mimeType': 'application/octet-stream', 'buffer': b'newer file contents'})
        frame.evaluate('() => { File.prototype.arrayBuffer = window.__hashOriginalFileRead; }')
        frame.locator('#hashCalculateBtn').click()
        assert_results(frame, b'newer file contents')
        frame.evaluate('async () => { await window.__hashPendingFileReads.shift()(); await Promise.resolve(); }')
        assert_results(frame, b'newer file contents')
    finally:
        frame.evaluate('() => { File.prototype.arrayBuffer = window.__hashOriginalFileRead; delete window.__hashOriginalFileRead; }')
    select_mode(frame, 'text')
    expect(frame.locator('#hashTextInput')).to_have_value('recovered after worker errors')
    assert_stale(frame)


def exercise_clipboard(page, frame):
    calculate_text(frame, 'clipboard 中文 😀')
    frame.locator('#hashCopyAllBtn').click()
    expected = '\n'.join(f'{LABELS[id]}: {digests("clipboard 中文 😀")[id]}' for id in ALGORITHMS)
    page.wait_for_function('value => window.__hashFixture.writes.at(-1) === value', arg=expected)
    frame.locator('.hash-copy-btn[data-algo="md5"]').click()
    page.wait_for_function('value => window.__hashFixture.writes.at(-1) === value', arg=digests('clipboard 中文 😀')['md5'])
    page.evaluate("window.__hashFixture.rejectWrite = true")
    frame.locator('#hashCopyAllBtn').click()
    expect(frame.locator('#hashStatus')).to_have_attribute('data-tone', 'error')
    expect(frame.locator('#hashCopyAllBtn')).to_be_enabled()
    page.evaluate("window.__hashFixture.rejectWrite = false; window.__hashFixture.clipboardText = 'pasted 中文 😀'")
    frame.locator('#hashPasteBtn').click()
    expect(frame.locator('#hashTextInput')).to_have_value('pasted 中文 😀')
    assert_stale(frame)
    page.evaluate('window.__hashFixture.deferRead = true')
    frame.locator('#hashPasteBtn').click()
    page.wait_for_function('window.__hashFixture.pendingReads.length === 1')
    frame.locator('#hashTextInput').fill('a newer clipboard draft')
    page.evaluate("() => window.__hashFixture.pendingReads.shift()('stale clipboard')")
    expect(frame.locator('#hashTextInput')).to_have_value('a newer clipboard draft')
    expect(frame.locator('#hashPasteBtn')).to_be_enabled()
    page.evaluate('window.__hashFixture.deferRead = false; window.__hashFixture.rejectRead = true')
    frame.locator('#hashPasteBtn').click()
    expect(frame.locator('#hashStatus')).to_have_attribute('data-tone', 'error')
    expect(frame.locator('#hashPasteBtn')).to_be_enabled()
    page.evaluate('window.__hashFixture.rejectRead = false')


def capture_draft(frame):
    calculate_text(frame, DRAFT, uppercase=True)
    frame.locator('#hashVerifyInput').fill(digests(DRAFT)['sha256'])
    positions = frame.evaluate("""() => {
      const input = document.getElementById('hashTextInput'); input.focus(); input.setSelectionRange(3, 11); input.scrollTop = 100;
      const verify = document.getElementById('hashVerifyInput'); verify.setSelectionRange(2, 12);
      const panels = [...document.querySelectorAll('.hash-main-panel,.hash-config-panel')]; panels.forEach((panel, i) => panel.scrollTop = 80 + i * 20);
      return {editor: input.scrollTop, panels: panels.map(panel => panel.scrollTop)};
    }""")
    snapshot = frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    assert snapshot['state'] is not None
    assert snapshot['canRelease'] is False, 'Hash intentionally keeps rich sessions mounted'
    return snapshot, positions


def expect_draft(frame, positions):
    expect(frame.locator('#hashTextInput')).to_have_value(DRAFT)
    expect(frame.locator('[data-hash-mode="text"]')).to_have_attribute('aria-pressed', 'true')
    for algorithm in ALGORITHMS:
        expect(frame.locator(f'.hash-switch[data-algo="{algorithm}"]')).to_have_attribute('aria-checked', 'true')
    expect(frame.locator('[data-option="uppercase"]')).to_have_attribute('aria-checked', 'true')
    assert_results(frame, DRAFT, uppercase=True)
    expect(frame.locator('#hashVerifyResult')).to_have_attribute('data-tone', 'success')
    state = frame.evaluate("""() => ({selection:[hashTextInput.selectionStart,hashTextInput.selectionEnd],
      verify:[hashVerifyInput.selectionStart,hashVerifyInput.selectionEnd], editor:hashTextInput.scrollTop,
      panels:[...document.querySelectorAll('.hash-main-panel,.hash-config-panel')].map(panel => panel.scrollTop)})""")
    assert state['selection'] == [3, 11] and state['verify'] == [2, 12], state
    assert abs(state['editor'] - positions['editor']) <= 2, (state, positions)
    assert all(abs(actual - saved) <= 2 for actual, saved in zip(state['panels'], positions['panels'])), (state, positions)


def exercise_restore(page, frame):
    snapshot, positions = capture_draft(frame)
    calculate_text(frame, 'changed after saved draft')
    page.evaluate('window.__hashFixture.deferRead = true')
    frame.locator('#hashPasteBtn').click()
    page.wait_for_function('window.__hashFixture.pendingReads.length === 1')
    frame.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    page.evaluate("() => window.__hashFixture.pendingReads.shift()('stale paste before restore')")
    expect_draft(frame, positions)
    page.evaluate('window.__hashFixture.deferRead = false')
    frame.evaluate("""snapshot => {
      window.dispatchEvent(new CustomEvent('dtkit:power-state', {detail:{suspended:true}}));
      window.__DTKIT_TOOL_PAGE__.restore(snapshot);
    }""", snapshot)
    expect_draft(frame, positions)
    frame.evaluate("window.dispatchEvent(new CustomEvent('dtkit:power-state', {detail:{suspended:false}}))")
    expect_draft(frame, positions)
    return positions


def assert_segment_surface(frame):
    group = frame.locator('#hashModeGroup.tool-motion-segmented')
    expect(group).to_have_class(re.compile(r'\btool-motion-ready\b'))
    colors = group.evaluate("""node => ({selected:getComputedStyle(node.querySelector('[aria-pressed=true]')).backgroundColor,
      indicator:getComputedStyle(node.querySelector('.tool-segment-indicator')).backgroundColor,
      width:node.querySelector('.tool-segment-indicator').getBoundingClientRect().width})""")
    assert colors['selected'].replace(' ', '') in ('transparent', 'rgba(0,0,0,0)'), colors
    assert colors['indicator'].replace(' ', '') not in ('transparent', 'rgba(0,0,0,0)'), colors
    assert colors['width'] > 0, colors


def exercise_layout(page, frame, entry):
    for width in (680, 390):
        page.set_viewport_size({'width': page.evaluate('innerWidth') + width - frame.evaluate('innerWidth'), 'height': 940})
        frame.wait_for_function('width => innerWidth === width', arg=width)
        metrics = frame.evaluate("""() => ({viewport:innerWidth,document:document.documentElement.scrollWidth,
          width:document.querySelector('.hash-tool-view').clientWidth,tool:document.querySelector('.hash-tool-view').scrollWidth})""")
        assert metrics['document'] <= metrics['viewport'] + 1 and metrics['tool'] <= metrics['width'] + 1, metrics
        assert_segment_surface(frame)
        page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-hash-{entry}-{width}.png'), full_page=True)
    page.emulate_media(color_scheme='dark', reduced_motion='reduce')
    expect(frame.locator('.hash-tool-view')).to_have_css('color-scheme', 'dark')
    expect(frame.locator('#hashCalculateBtn')).to_have_css('transition-duration', '0s')
    assert_segment_surface(frame)
    page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-hash-{entry}-dark.png'), full_page=True)


def exercise_panel_scroll(page, frame):
    page.set_viewport_size({'width': 1200, 'height': 600})
    for selector in ('.hash-main-panel', '.hash-config-panel'):
        panel = frame.locator(selector)
        expect(panel).to_have_css('overflow-y', 'auto')
        assert panel.evaluate('node => node.scrollHeight > node.clientHeight + 20'), selector
        box = panel.bounding_box()
        page.mouse.move(box['x'] + box['width'] - 25, box['y'] + box['height'] * .7)
        for delta in (6000, -6000):
            page.mouse.wheel(0, delta)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if panel.evaluate('node => node.scrollTop > 20 && node.scrollTop + node.clientHeight >= node.scrollHeight - 2' if delta > 0 else 'node => node.scrollTop === 0'):
                    break
                page.wait_for_timeout(40)
            else:
                raise AssertionError(f'{selector} did not respond to wheel {delta}')


def test_quick(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url + '/quick.html?kind=tool&toolId=hash-tool', wait_until='networkidle')
    expect(page.locator('#hashTextInput')).to_be_visible()
    assert page.locator('.sidebar,#tabBar,iframe.tool-page-frame').count() == 0
    exercise_real_worker(page)
    exercise_worker_failures(page)
    exercise_browser_files(page)
    exercise_clipboard(page, page)
    exercise_restore(page, page)
    exercise_layout(page, page, 'quick')
    exercise_panel_scroll(page, page)
    page.close()


def test_embedded(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url, wait_until='networkidle')
    page.locator('[data-tool-id="hash-tool"] .tool-card__title').click()
    frame = multi.active_tool_frame(page, '#hashTextInput')
    exercise_real_worker(frame)
    exercise_worker_failures(frame)
    exercise_browser_files(frame)
    exercise_clipboard(page, frame)
    positions = exercise_restore(page, frame)
    tab_a = multi.active_tab_id(page)
    multi.click_page_action(page, 'new')
    second = multi.active_tool_frame(page, '#hashTextInput')
    tab_b = multi.active_tab_id(page)
    expect(second.locator('#hashTextInput')).to_have_value('')
    second.locator('#hashTextInput').fill('second independent Hash draft')
    multi.switch_tab(page, tab_a)
    expect_draft(frame, positions)
    # Hash keeps rich sessions mounted; persistence still writes the journal,
    # while False signals that these pages cannot be released for sleep.
    assert page.evaluate('window.__DTKIT_TOOL_WORKSPACE__.persist({prepareSleep:true})') is False
    page.reload(wait_until='networkidle')
    restored = multi.active_tool_frame(page, '#hashTextInput')
    expect_draft(restored, positions)
    multi.switch_tab(page, tab_b)
    expect(multi.active_tool_frame(page, '#hashTextInput').locator('#hashTextInput')).to_have_value('second independent Hash draft')
    multi.switch_tab(page, tab_a)
    restored = multi.active_tool_frame(page, '#hashTextInput')
    exercise_layout(page, restored, 'embedded')
    exercise_panel_scroll(page, restored)
    page.close()


def emit_progress(page, task_id, progress):
    page.evaluate("""({taskId,progress}) => {
      for (const callback of window.__multiListeners['hash-progress'] || [])
        callback({payload:{taskId,progress,bytesProcessed:progress*10,totalBytes:1000}});
    }""", {'taskId': task_id, 'progress': progress})


def test_native_contract(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url + '/quick.html?kind=tool&toolId=hash-tool', wait_until='networkidle')
    expect(page.locator('#hashTextInput')).to_be_visible()
    calculate_text(page, NATIVE_TEXTS[0], uppercase=True)
    page.evaluate('window.__hashFixture.malformedNative = true')
    page.locator('#hashCalculateBtn').click()
    expect(page.locator('#hashStatus')).to_have_attribute('data-tone', 'error')
    assert_stale(page)
    page.evaluate('window.__hashFixture.malformedNative = false; window.__hashFixture.deferNative = true')
    page.locator('#hashTextInput').fill(NATIVE_TEXTS[1])
    page.locator('#hashCalculateBtn').click()
    page.wait_for_function('window.__hashFixture.pendingNative.length === 1')
    page.locator('#hashTextInput').fill(NATIVE_TEXTS[2])
    page.locator('#hashCalculateBtn').click()
    page.wait_for_function('window.__hashFixture.pendingNative.length === 2')
    page.evaluate('() => { const request = window.__hashFixture.pendingNative.pop(); request.resolve(request.results); }')
    assert_results(page, NATIVE_TEXTS[2], uppercase=True)
    page.evaluate('() => { const request = window.__hashFixture.pendingNative.shift(); request.resolve(request.results); window.__hashFixture.deferNative = false; }')
    assert_results(page, NATIVE_TEXTS[2], uppercase=True)
    saved_text = page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    page.evaluate('window.__hashFixture.deferNative = true')
    page.locator('#hashTextInput').fill(NATIVE_TEXTS[1])
    page.locator('#hashCalculateBtn').click()
    page.wait_for_function('window.__hashFixture.pendingNative.length === 1')
    page.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', saved_text)
    page.evaluate('() => { const request = window.__hashFixture.pendingNative.shift(); request.resolve(request.results); window.__hashFixture.deferNative = false; }')
    expect(page.locator('#hashTextInput')).to_have_value(NATIVE_TEXTS[2])
    assert_results(page, NATIVE_TEXTS[2], uppercase=True)

    # A late chooser must not replace the user-selected mode or newer draft.
    select_mode(page, 'file')
    page.evaluate('window.__hashFixture.deferDialog = true')
    page.locator('#hashChooseFileBtn').click()
    page.wait_for_function('window.__hashFixture.pendingDialogs.length === 1')
    select_mode(page, 'text')
    page.locator('#hashTextInput').fill(NATIVE_TEXTS[3])
    page.evaluate('() => { window.__hashFixture.pendingDialogs.shift()(window.__hashFixture.filePath); window.__hashFixture.deferDialog = false; }')
    expect(page.locator('[data-hash-mode="text"]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#hashTextInput')).to_have_value(NATIVE_TEXTS[3])
    expect(page.locator('#hashChooseFileBtn')).to_be_enabled()

    select_mode(page, 'file')
    page.evaluate('window.__hashFixture.dialogValue = window.__hashFixture.filePath; window.__hashFixture.deferNative = true')
    page.locator('#hashChooseFileBtn').click()
    expect(page.locator('#hashFileName')).to_have_text('hash-data.bin')
    page.locator('#hashCalculateBtn').click()
    page.wait_for_function('window.__hashFixture.pendingNative.length === 1')
    task_id = page.evaluate('window.__hashFixture.pendingNative[0].args.taskId')
    emit_progress(page, 'foreign-window-task', 77)
    assert page.locator('#hashProgressBar').evaluate("node => node.style.width") != '77%'
    emit_progress(page, task_id, 37)
    expect(page.locator('.hash-progress-track')).to_have_attribute('aria-valuenow', '37')
    expect(page.locator('#hashFileMeta')).to_contain_text('1000 B')
    page.evaluate('() => { const request = window.__hashFixture.pendingNative.shift(); request.resolve(request.results); window.__hashFixture.deferNative = false; }')
    assert_results(page, FILE_BYTES, uppercase=True)
    emit_progress(page, task_id, 3)
    expect(page.locator('#hashProgressContainer')).to_be_hidden()
    assert page.locator('#hashProgressBar').evaluate("node => node.style.width") != '3%'
    snapshot = page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    assert snapshot['state']['file']['path'] == FILE_PATH
    page.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    assert_stale(page)
    page.locator('#hashCalculateBtn').click()
    assert_results(page, FILE_BYTES, uppercase=True)
    page.locator('.hash-clear-file').click()
    expect(page.locator('#hashFileName')).to_have_text('将文件拖放到这里')
    assert_stale(page)
    calls = page.evaluate('window.__hashFixture.nativeCalls')
    assert calls and all(call['args']['uppercase'] is False for call in calls)
    assert all(set(call['args']) <= ({'text', 'algorithms', 'uppercase', 'instanceId'} if call['command'] == 'calculate_text_hash' else {'filePath', 'algorithms', 'uppercase', 'taskId', 'instanceId'}) for call in calls)
    assert page.evaluate('window.__hashWorkers.created') == 0
    page.close()


def run(base_url):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 940}, reduced_motion='reduce')
        context.add_init_script(multi.MOCK + '\n' + INSTRUMENTATION)

        def apply_csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if 'text/html' in headers.get('content-type', ''):
                headers['content-security-policy'] = multi.CSP
            route.fulfill(response=response, headers=headers)

        context.route(base_url + '/**', apply_csp)
        try:
            print('Hash UI: standalone real Worker, UTF-8, files, failures, clipboard races and restore', flush=True)
            test_quick(context, base_url, errors)
            print('Hash UI: embedded isolation, workspace reload, responsive and split-panel scrolling', flush=True)
            test_embedded(context, base_url, errors)
            print('Hash UI: strict native contracts, stale IPC and per-task progress', flush=True)
            test_native_contract(context, base_url, errors)
            assert not errors, errors
        except Exception:
            for index, page in enumerate(context.pages):
                page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-hash-failure-{index}.png'), full_page=True)
            raise
        finally:
            context.close()
            browser.close()
    print(f'Hash tool UI smoke passed; screenshots={multi.SCREENSHOTS}')


if __name__ == '__main__':
    with multi.production_url() as base_url:
        run(base_url)
