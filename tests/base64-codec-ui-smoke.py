"""Exercise production Base64 pages under the real CSP.

Python's Base64 codec supplies independent expected values. The browser uses
mocked native IPC/clipboard only; conversion runs through the shipped frontend.
Build once before running, or set DTKIT_TEST_BASE_URL to a production preview.
"""

import base64
import importlib.util
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location('multi_page', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)

CLIPBOARD_MOCK = r"""
(() => {
  const state = window.__base64Clipboard = {
    text: '', writes: [], pending: [], defer: false, rejectRead: false, rejectWrite: false
  };
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
    writeText: async text => {
      if (state.rejectWrite) throw new Error('Clipboard write denied');
      state.writes.push(String(text));
    },
    readText: () => {
      if (state.rejectRead) return Promise.reject(new Error('Clipboard read denied'));
      return state.defer ? new Promise(resolve => state.pending.push(resolve)) : Promise.resolve(state.text);
    }
  }});
})();
"""

UTF8_SOURCE = '你好，DtKit 🌤️\nsecond line'
DRAFT_SOURCE = '\n'.join(f'第 {index:03d} 行 · DtKit 😀 / + ?' for index in range(100))


def encoded(source, *, url=False, padded=True):
    codec = base64.urlsafe_b64encode if url else base64.b64encode
    value = codec(source.encode('utf-8')).decode('ascii')
    return value if padded else value.rstrip('=')


def set_auto(frame, enabled):
    frame.locator('#base64AutoConvert').set_checked(enabled)
    assert frame.locator('#base64AutoConvert').is_checked() is enabled


def select_mode(frame, mode):
    button = frame.locator('#base64EncodeBtn' if mode == 'encode' else '#base64DecodeBtn')
    button.click()
    expect(button).to_have_attribute('aria-pressed', 'true')


def select_variant(frame, variant):
    button = frame.locator(f'[data-base64-variant="{variant}"]')
    button.click()
    expect(button).to_have_attribute('aria-pressed', 'true')


def assert_result_actions(frame, enabled):
    for selector in ('#base64CopyBtn', '#base64UseResultBtn'):
        if enabled:
            expect(frame.locator(selector)).to_be_enabled()
        else:
            expect(frame.locator(selector)).to_be_disabled()


def convert(frame, source, *, mode='encode', variant='standard', padded=True):
    set_auto(frame, False)
    select_mode(frame, mode)
    select_variant(frame, variant)
    frame.locator('#base64OmitPadding').set_checked(not padded)
    frame.locator('#base64Input').fill(source)
    frame.locator('#base64RunBtn').click()
    assert_result_actions(frame, True)
    return frame.locator('#base64Output').input_value()


def assert_segment_surfaces(frame):
    groups = frame.locator('.base64-container .tool-motion-segmented')
    expect(groups).to_have_count(2)
    for group in groups.all():
        expect(group).to_have_class(re.compile(r'\btool-motion-ready\b'))
        colors = group.evaluate("""group => ({
          selected: getComputedStyle(group.querySelector('button[aria-pressed="true"]')).backgroundColor,
          indicator: getComputedStyle(group.querySelector('.tool-segment-indicator')).backgroundColor,
          width: group.querySelector('.tool-segment-indicator').getBoundingClientRect().width,
          height: group.querySelector('.tool-segment-indicator').getBoundingClientRect().height
        })""")
        transparent = {'transparent', 'rgba(0,0,0,0)'}
        assert colors['selected'].replace(' ', '') in transparent, colors
        assert colors['indicator'].replace(' ', '') not in transparent, colors
        if group.is_visible():
            assert colors['width'] > 0 and colors['height'] > 0, colors


def exercise_conversion(frame):
    expect(frame.locator('.base64-container.dev-workbench')).to_be_visible()
    assert_segment_surfaces(frame)
    expect(frame.locator('#base64EncodeBtn')).to_have_attribute('aria-pressed', 'true')
    expect(frame.locator('#base64AutoConvert')).to_be_checked()

    # A plain alphabetic word must be encoded instead of guessed as Base64.
    frame.locator('#base64Input').fill('test')
    expect(frame.locator('#base64Output')).to_have_value(encoded('test'))
    frame.locator('#base64Input').fill(UTF8_SOURCE)
    expect(frame.locator('#base64Output')).to_have_value(encoded(UTF8_SOURCE))
    expect(frame.locator('#base64Stats')).to_contain_text(str(len(UTF8_SOURCE.encode('utf-8'))))
    frame.locator('#base64Input').fill(encoded(UTF8_SOURCE))
    frame.locator('#base64DecodeBtn').click()
    expect(frame.locator('#base64Output')).to_have_value(UTF8_SOURCE)

    # Manual mode and automatic mode must use the same UTF-8 codec.
    assert convert(frame, UTF8_SOURCE) == encoded(UTF8_SOURCE)
    assert convert(frame, encoded(UTF8_SOURCE), mode='decode') == UTF8_SOURCE
    # Preserve a UTF-8 BOM as content instead of silently stripping it.
    bom_source = '\ufeffDtKit 中文 😀'
    assert convert(frame, bom_source) == encoded(bom_source)
    assert convert(frame, encoded(bom_source), mode='decode') == bom_source
    assert convert(frame, 'ÿ?', variant='url', padded=False) == encoded('ÿ?', url=True, padded=False)
    expect(frame.locator('#base64Output')).to_have_value('w78_')
    assert convert(frame, ' \n w7 8_\t', mode='decode', variant='url', padded=False) == 'ÿ?'
    assert convert(frame, 'Zg', mode='decode') == 'f'
    assert convert(frame, ' Z m 9 v \n', mode='decode') == 'foo'

    # Returning a valid result to the input changes the explicit direction.
    value = convert(frame, UTF8_SOURCE)
    frame.locator('#base64UseResultBtn').click()
    expect(frame.locator('#base64Input')).to_have_value(value)
    expect(frame.locator('#base64DecodeBtn')).to_have_attribute('aria-pressed', 'true')
    frame.locator('#base64Input').press('Control+Enter')
    expect(frame.locator('#base64Output')).to_have_value(UTF8_SOURCE)
    assert_result_actions(frame, True)


def exercise_errors_and_stale(frame):
    set_auto(frame, False)
    select_variant(frame, 'standard')
    select_mode(frame, 'decode')
    # Include noncanonical tail bits and byte sequences that are not UTF-8.
    for malformed in ('A', 'Zg=', 'Zg===', 'Zh==', 'Zm9=', 'Zg==x', 'Zg*_', '/w=='):
        frame.locator('#base64Input').fill(malformed)
        frame.locator('#base64RunBtn').click()
        expect(frame.locator('#base64Status')).to_have_attribute('data-tone', 'error')
        expect(frame.locator('#base64Status')).not_to_be_empty()
        assert_result_actions(frame, False)

    assert convert(frame, 'baseline') == encoded('baseline')
    frame.locator('#base64Input').fill('new manual draft')
    assert_result_actions(frame, False)
    frame.wait_for_timeout(350)
    assert_result_actions(frame, False)
    frame.locator('#base64Input').press('Control+Enter')
    expect(frame.locator('#base64Output')).to_have_value(encoded('new manual draft'))
    frame.locator('#base64OmitPadding').check()
    assert_result_actions(frame, False)
    frame.locator('#base64RunBtn').click()
    expect(frame.locator('#base64Output')).to_have_value(encoded('new manual draft', padded=False))

    # Schedule and cancel auto conversion within one browser turn.
    frame.evaluate("""() => {
      const auto = document.getElementById('base64AutoConvert');
      auto.checked = true; auto.dispatchEvent(new Event('change', {bubbles:true}));
      const input = document.getElementById('base64Input');
      input.value = 'auto conversion must be cancelled';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      auto.checked = false; auto.dispatchEvent(new Event('change', {bubbles:true}));
    }""")
    frame.wait_for_timeout(500)
    assert_result_actions(frame, False)
    assert frame.locator('#base64Output').input_value() != encoded('auto conversion must be cancelled', padded=False)
    frame.locator('#base64ClearBtn').click()
    expect(frame.locator('#base64Input')).to_have_value('')
    expect(frame.locator('#base64Output')).to_have_value('')
    assert_result_actions(frame, False)
    # The empty string is a valid value in both directions. It can round-trip
    # even though there is no content to copy.
    for mode in ('encode', 'decode'):
        select_mode(frame, mode)
        frame.locator('#base64RunBtn').click()
        expect(frame.locator('#base64Output')).to_have_value('')
        expect(frame.locator('#base64Status')).to_have_attribute('data-tone', 'success')
        expect(frame.locator('#base64Input')).not_to_have_attribute('aria-invalid', 'true')
        expect(frame.locator('#base64CopyBtn')).to_be_disabled()
        expect(frame.locator('#base64UseResultBtn')).to_be_enabled()
        frame.locator('#base64UseResultBtn').click()
        opposite = '#base64DecodeBtn' if mode == 'encode' else '#base64EncodeBtn'
        expect(frame.locator(opposite)).to_have_attribute('aria-pressed', 'true')
        expect(frame.locator('#base64Input')).to_have_value('')
        expect(frame.locator('#base64Output')).to_have_value('')
        expect(frame.locator('#base64Status')).to_have_attribute('data-tone', 'success')
        expect(frame.locator('#base64CopyBtn')).to_be_disabled()
        expect(frame.locator('#base64UseResultBtn')).to_be_enabled()


def exercise_clipboard(page, frame):
    value = convert(frame, UTF8_SOURCE)
    frame.locator('#base64CopyBtn').click()
    page.wait_for_function('value => window.__base64Clipboard.writes.at(-1) === value', arg=value)
    frame.locator('#base64CopyInputBtn').click()
    page.wait_for_function('value => window.__base64Clipboard.writes.at(-1) === value', arg=UTF8_SOURCE)
    page.evaluate("window.__base64Clipboard.text = 'pasted 中文 😀';")
    frame.locator('#base64PasteBtn').click()
    expect(frame.locator('#base64Input')).to_have_value('pasted 中文 😀')
    assert_result_actions(frame, False)

    page.evaluate('window.__base64Clipboard.defer = true;')
    frame.locator('#base64PasteBtn').click()
    page.wait_for_function('window.__base64Clipboard.pending.length === 1')
    frame.locator('#base64Input').fill('a newer user draft')
    page.evaluate("async () => { window.__base64Clipboard.pending.shift()('old clipboard'); await Promise.resolve(); }")
    expect(frame.locator('#base64Input')).to_have_value('a newer user draft')
    expect(frame.locator('#base64PasteBtn')).to_be_enabled()
    page.evaluate('window.__base64Clipboard.defer = false; window.__base64Clipboard.rejectRead = true;')
    frame.locator('#base64PasteBtn').click()
    expect(frame.locator('#base64Status')).to_have_attribute('data-tone', 'error')
    expect(frame.locator('#base64PasteBtn')).to_be_enabled()
    expect(frame.locator('#base64Input')).to_have_value('a newer user draft')
    page.evaluate('window.__base64Clipboard.rejectRead = false;')

    convert(frame, UTF8_SOURCE)
    page.evaluate('window.__base64Clipboard.rejectWrite = true;')
    frame.locator('#base64CopyBtn').click()
    expect(frame.locator('#base64Status')).to_have_attribute('data-tone', 'error')
    expect(frame.locator('#base64CopyBtn')).to_be_enabled()
    page.evaluate('window.__base64Clipboard.rejectWrite = false;')


def capture_draft(frame):
    expected = encoded(DRAFT_SOURCE, url=True, padded=False)
    assert convert(frame, DRAFT_SOURCE, variant='url', padded=False) == expected
    positions = frame.evaluate("""() => {
      const input = document.getElementById('base64Input');
      const output = document.getElementById('base64Output');
      input.setSelectionRange(3, 11); input.scrollTop = 100;
      output.setSelectionRange(2, 12); output.scrollTop = 80;
      return {input: input.scrollTop, output: output.scrollTop};
    }""")
    snapshot = frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    assert snapshot['state'] is not None, 'Base64 tool needs a dedicated draft serializer'
    assert snapshot['canRelease'] is True
    return snapshot, positions


def expect_draft(frame, positions):
    expect(frame.locator('#base64Input')).to_have_value(DRAFT_SOURCE)
    expect(frame.locator('#base64Output')).to_have_value(encoded(DRAFT_SOURCE, url=True, padded=False))
    expect(frame.locator('#base64EncodeBtn')).to_have_attribute('aria-pressed', 'true')
    expect(frame.locator('[data-base64-variant="url"]')).to_have_attribute('aria-pressed', 'true')
    expect(frame.locator('#base64OmitPadding')).to_be_checked()
    expect(frame.locator('#base64AutoConvert')).not_to_be_checked()
    assert_result_actions(frame, True)
    for selector, selection, key in [('#base64Input', [3, 11], 'input'), ('#base64Output', [2, 12], 'output')]:
        state = frame.locator(selector).evaluate('node => ({selection:[node.selectionStart,node.selectionEnd], scroll:node.scrollTop})')
        assert state['selection'] == selection, state
        assert abs(state['scroll'] - positions[key]) <= 2, (key, state, positions)


def exercise_restore(page, frame):
    snapshot, positions = capture_draft(frame)
    convert(frame, 'changed after snapshot')
    page.evaluate('window.__base64Clipboard.defer = true;')
    frame.locator('#base64PasteBtn').click()
    page.wait_for_function('window.__base64Clipboard.pending.length === 1')
    frame.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    page.evaluate("async () => { window.__base64Clipboard.pending.shift()('paste from an older draft'); await Promise.resolve(); }")
    expect_draft(frame, positions)
    expect(frame.locator('#base64PasteBtn')).to_be_enabled()
    page.evaluate('window.__base64Clipboard.defer = false;')

    # Background workspace recovery still restores the completed result. It
    # must not depend on a visible page being allowed to animate or schedule.
    convert(frame, 'a different foreground draft')
    frame.evaluate("""snapshot => {
      window.dispatchEvent(new CustomEvent('dtkit:power-state', {detail:{suspended:true}}));
      window.__DTKIT_TOOL_PAGE__.restore(snapshot);
    }""", snapshot)
    expect_draft(frame, positions)
    expect(frame.locator('#base64Status')).to_have_attribute('data-tone', 'success')
    frame.evaluate("window.dispatchEvent(new CustomEvent('dtkit:power-state', {detail:{suspended:false}}));")
    frame.wait_for_timeout(250)
    expect_draft(frame, positions)
    expect(frame.locator('#base64Status')).to_have_attribute('data-tone', 'success')
    return positions


def assert_no_overflow(frame):
    metrics = frame.evaluate("""() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      tool: document.querySelector('.base64-container').scrollWidth,
      width: document.querySelector('.base64-container').clientWidth,
      editors: [...document.querySelectorAll('.base64-container textarea')].map(node => ({
        left:node.getBoundingClientRect().left, right:node.getBoundingClientRect().right}))
    })""")
    assert metrics['document'] <= metrics['viewport'] + 1, metrics
    assert metrics['tool'] <= metrics['width'] + 1, metrics
    assert all(editor['left'] >= -1 and editor['right'] <= metrics['viewport'] + 1 for editor in metrics['editors']), metrics


def exercise_layout(page, frame, entry):
    for width in (680, 390):
        page.set_viewport_size({'width': page.evaluate('innerWidth') + width - frame.evaluate('innerWidth'), 'height': 940})
        frame.wait_for_function('width => innerWidth === width', arg=width)
        assert_no_overflow(frame)
        assert_segment_surfaces(frame)
        page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-base64-{entry}-{width}.png'), full_page=True)
    page.emulate_media(color_scheme='dark', reduced_motion='reduce')
    expect(frame.locator('.base64-container')).to_have_css('color-scheme', 'dark')
    expect(frame.locator('#base64RunBtn')).to_have_css('transition-duration', '0s')
    assert_no_overflow(frame)
    assert_segment_surfaces(frame)
    page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-base64-{entry}-dark.png'), full_page=True)


def test_quick(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url + '/quick.html?kind=tool&toolId=base64-codec', wait_until='networkidle')
    expect(page.locator('#base64Input')).to_be_visible()
    assert page.locator('.sidebar,#tabBar,iframe.tool-page-frame').count() == 0
    exercise_conversion(page)
    exercise_errors_and_stale(page)
    exercise_clipboard(page, page)
    exercise_restore(page, page)
    exercise_layout(page, page, 'quick')
    page.close()


def test_embedded(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url, wait_until='networkidle')
    page.locator('[data-tool-id="base64-codec"] .tool-card__title').click()
    frame = multi.active_tool_frame(page, '.base64-container.dev-workbench')
    exercise_conversion(frame)
    exercise_errors_and_stale(frame)
    exercise_clipboard(page, frame)
    positions = exercise_restore(page, frame)
    tab_a = multi.active_tab_id(page)
    multi.click_page_action(page, 'new')
    second = multi.active_tool_frame(page, '.base64-container.dev-workbench')
    tab_b = multi.active_tab_id(page)
    expect(second.locator('#base64Input')).to_have_value('')
    set_auto(second, False)
    second.locator('#base64Input').fill('second independent draft')
    multi.switch_tab(page, tab_a)
    expect_draft(frame, positions)
    assert page.evaluate('window.__DTKIT_TOOL_WORKSPACE__.persist({prepareSleep:true})') is True
    page.reload(wait_until='networkidle')
    restored = multi.active_tool_frame(page, '.base64-container.dev-workbench')
    expect_draft(restored, positions)
    multi.switch_tab(page, tab_b)
    expect(multi.active_tool_frame(page, '.base64-container').locator('#base64Input')).to_have_value('second independent draft')
    multi.switch_tab(page, tab_a)
    restored = multi.active_tool_frame(page, '.base64-container')
    exercise_layout(page, restored, 'embedded')
    page.close()


def run(base_url):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 940}, reduced_motion='reduce')
        context.add_init_script(multi.MOCK + '\n' + CLIPBOARD_MOCK)

        def apply_csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if 'text/html' in headers.get('content-type', ''):
                headers['content-security-policy'] = multi.CSP
            route.fulfill(response=response, headers=headers)

        context.route(base_url + '/**', apply_csp)
        try:
            print('Base64 UI: standalone UTF-8, strict validation, clipboard races and restore', flush=True)
            test_quick(context, base_url, errors)
            print('Base64 UI: embedded isolation, workspace reload and responsive layout', flush=True)
            test_embedded(context, base_url, errors)
            assert not errors, errors
        except Exception:
            for index, page in enumerate(context.pages):
                page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-base64-failure-{index}.png'), full_page=True)
            raise
        finally:
            context.close()
            browser.close()
    print(f'Base64 codec UI smoke passed; screenshots={multi.SCREENSHOTS}')


if __name__ == '__main__':
    with multi.production_url() as base_url:
        run(base_url)
