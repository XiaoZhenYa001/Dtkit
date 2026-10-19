"""Exercise timestamp conversion in production quick and embedded tool pages.

Uses browser IPC/clipboard mocks and the production CSP. Build once before running;
DTKIT_TEST_BASE_URL can point to an existing production preview server.
"""

import importlib.util
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location("multi_page", Path(__file__).with_name("multi-page-ui-smoke.py"))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)

CLIPBOARD_MOCK = r"""
(() => {
  const state = window.__timestampClipboard = {
    text: '', writes: [], reads: 0, defer: false, reject: false, pending: []
  };
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
    writeText: async value => { state.writes.push(String(value)); },
    readText: () => {
      state.reads += 1;
      if (state.reject) return Promise.reject(new Error('Clipboard read denied'));
      if (state.defer) return new Promise(resolve => state.pending.push(resolve));
      return Promise.resolve(state.text);
    }
  }});
})();
"""


def result(frame, panel, key):
    return frame.locator(f'#{panel} [data-result-key="{key}"]')


def select_segment(frame, attribute, value):
    button = frame.locator(f'[{attribute}="{value}"]')
    button.click()
    expect(button).to_have_attribute('aria-pressed', 'true')


def assert_segment_surfaces(frame):
    groups = frame.locator('.timestamp-container .tool-motion-segmented')
    expect(groups).to_have_count(3)
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
        assert colors['width'] > 0 and colors['height'] > 0, colors


def convert_timestamp(frame, value, *, unit='auto', iso=None):
    select_segment(frame, 'data-timestamp-unit', unit)
    frame.locator('#timestampInput').fill(value)
    frame.locator('#toDateBtn').click()
    if iso is not None:
        expect(result(frame, 'dateResult', 'iso')).to_have_text(iso)


def assert_no_horizontal_overflow(frame):
    metrics = frame.evaluate("""() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      tool: document.querySelector('.timestamp-container').scrollWidth,
      toolWidth: document.querySelector('.timestamp-container').clientWidth,
      controls: [...document.querySelectorAll('.timestamp-container input, .timestamp-container button')]
        .filter(node => node.getClientRects().length)
        .map(node => ({id: node.id || node.getAttribute('data-timestamp-reference') || node.textContent.trim(),
          left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right}))
    })""")
    assert metrics['document'] <= metrics['viewport'] + 1, metrics
    assert metrics['tool'] <= metrics['toolWidth'] + 1, metrics
    assert all(control['left'] >= -1 and control['right'] <= metrics['viewport'] + 1
               for control in metrics['controls']), metrics


def resize_tool(page, frame, width):
    # The embedded page shares its window with the main app sidebar. Match the
    # tool document width so the same 390/680 px breakpoints cover both entries.
    outer_width = page.evaluate('innerWidth')
    tool_width = frame.evaluate('innerWidth')
    page.set_viewport_size({'width': outer_width + width - tool_width, 'height': 940})
    frame.wait_for_function('width => innerWidth === width', arg=width)
    assert_no_horizontal_overflow(frame)


def exercise_conversion(frame):
    assert_segment_surfaces(frame)
    expect(frame.locator('#currentTimestamp')).to_have_text(re.compile(r'^\d+$'))
    expect(frame.locator('#currentTimeLabel')).not_to_be_empty()
    expect(frame.locator('#timestampUnitHint')).not_to_be_empty()

    convert_timestamp(frame, '0', iso='1970-01-01T00:00:00.000Z')
    convert_timestamp(frame, '-1', unit='sec', iso='1969-12-31T23:59:59.000Z')
    convert_timestamp(frame, '-1', unit='ms', iso='1969-12-31T23:59:59.999Z')
    convert_timestamp(frame, '-1000000000000', iso='1938-04-24T22:13:20.000Z')
    convert_timestamp(frame, '1735689600', unit='sec', iso='2025-01-01T00:00:00.000Z')
    select_segment(frame, 'data-timestamp-unit', 'ms')
    frame.locator('#toDateBtn').click()
    expect(result(frame, 'dateResult', 'iso')).to_have_text('1970-01-21T02:08:09.600Z')

    # Reject trailing text and scientific notation rather than accepting a
    # parseInt prefix; reject values beyond Date's representable range.
    for value, unit in [('1735689600garbage', 'auto'), ('1e9', 'sec'),
                        ('8640000000000001', 'ms'), ('', 'auto')]:
        convert_timestamp(frame, value, unit=unit)
        expect(frame.locator('#timestampStatus')).to_contain_text(
            re.compile(r'输入|格式|整数|有效|范围|超出'))

    # A failed conversion must remain recoverable by keyboard.
    select_segment(frame, 'data-timestamp-unit', 'auto')
    frame.locator('#timestampInput').fill('0')
    frame.locator('#timestampInput').press('Enter')
    expect(result(frame, 'dateResult', 'iso')).to_have_text('1970-01-01T00:00:00.000Z')
    expect(result(frame, 'dateResult', 'local')).not_to_be_empty()
    expect(result(frame, 'dateResult', 'utc')).not_to_be_empty()

    # A wall-clock value is interpreted in the selected zone, including its
    # milliseconds; changing the zone keeps that editable wall-clock value.
    date_value = '1970-01-01T00:00:00.123'
    assert float(frame.locator('#dateInput').get_attribute('step')) == 0.001
    select_segment(frame, 'data-date-zone', 'utc')
    frame.locator('#dateInput').fill(date_value)
    frame.locator('#toTimestampBtn').click()
    expect(result(frame, 'timestampResult', 'seconds')).to_have_text('0.123')
    expect(result(frame, 'timestampResult', 'milliseconds')).to_have_text('123')
    expect(result(frame, 'timestampResult', 'iso')).to_have_text('1970-01-01T00:00:00.123Z')
    select_segment(frame, 'data-date-zone', 'local')
    expect(frame.locator('#dateInput')).to_have_value(date_value)
    frame.locator('#dateInput').press('Enter')
    expect(result(frame, 'timestampResult', 'milliseconds')).to_have_text('-28799877')
    expect(result(frame, 'timestampResult', 'seconds')).to_have_text('-28799.877')
    frame.locator('#dateInput').fill('')
    frame.locator('#toTimestampBtn').click()
    expect(frame.locator('#dateStatus')).to_contain_text(re.compile(r'选择|输入|日期'))
    frame.locator('#nowBtn').click()
    frame.locator('#toTimestampBtn').click()
    now_delta = frame.evaluate("""() => Math.abs(Date.now() - Number(
      document.querySelector('#timestampResult [data-result-key="milliseconds"]').textContent))""")
    assert now_delta < 2500, now_delta

    # Reference cards are actual buttons and can be activated by keyboard.
    year = frame.locator('[data-timestamp-reference="year-2026"]')
    expect(year).to_have_attribute('type', 'button')
    year.click()
    expect(result(frame, 'dateResult', 'iso')).to_have_text('2026-01-01T00:00:00.000Z')
    epoch = frame.locator('[data-timestamp-reference="epoch"]')
    epoch.focus()
    epoch.press('Enter')
    expect(frame.locator('#timestampInput')).to_have_value('0')
    expect(result(frame, 'dateResult', 'iso')).to_have_text('1970-01-01T00:00:00.000Z')

    # Move the clock only for the click: relative references must compute their
    # value on activation, rather than caching the timestamp at tool startup.
    frame.evaluate('window.__timestampOriginalNow = Date.now; Date.now = () => 2000000000000;')
    try:
        for reference, expected in [('now', '2000000000'), ('day-ago', '1999913600'),
                                    ('week-ago', '1999395200')]:
            frame.locator(f'[data-timestamp-reference="{reference}"]').click()
            expect(frame.locator('#timestampInput')).to_have_value(expected)
            expect(frame.locator('[data-timestamp-unit="sec"]')).to_have_attribute('aria-pressed', 'true')
    finally:
        frame.evaluate('Date.now = window.__timestampOriginalNow; delete window.__timestampOriginalNow;')

    frame.locator('#timestampNowBtn').click()
    timestamp_now_delta = frame.evaluate("""() => Math.abs(Date.now() - Date.parse(
      document.querySelector('#dateResult [data-result-key="iso"]').textContent))""")
    assert timestamp_now_delta < 2500, timestamp_now_delta


def exercise_clipboard(page, frame):
    convert_timestamp(frame, '0', iso='1970-01-01T00:00:00.000Z')
    copy = frame.locator('#dateResult [data-copy="1970-01-01T00:00:00.000Z"]')
    copy.click()
    page.wait_for_function("window.__timestampClipboard.writes.at(-1) === '1970-01-01T00:00:00.000Z'")
    select_segment(frame, 'data-current-unit', 'sec')
    expect(frame.locator('#currentTimestamp')).to_have_text(re.compile(r'^\d{9,11}$'))
    frame.locator('#copyCurrentBtn').click()
    page.wait_for_function("/^\\d{9,11}$/.test(window.__timestampClipboard.writes.at(-1) || '')")
    select_segment(frame, 'data-current-unit', 'ms')
    expect(frame.locator('#currentTimestamp')).to_have_text(re.compile(r'^\d{12,14}$'))
    frame.locator('#copyCurrentBtn').click()
    page.wait_for_function("/^\\d{12,14}$/.test(window.__timestampClipboard.writes.at(-1) || '')")

    page.evaluate("window.__timestampClipboard.text = '-1';")
    select_segment(frame, 'data-timestamp-unit', 'ms')
    frame.locator('#timestampPasteBtn').click()
    expect(frame.locator('#timestampInput')).to_have_value('-1')
    frame.locator('#toDateBtn').click()
    expect(result(frame, 'dateResult', 'iso')).to_have_text('1969-12-31T23:59:59.999Z')

    # A slow clipboard request must not replace a newer user edit.
    page.evaluate('window.__timestampClipboard.defer = true;')
    frame.locator('#timestampPasteBtn').click()
    page.wait_for_function('window.__timestampClipboard.pending.length === 1')
    frame.locator('#timestampInput').fill('newer draft')
    page.evaluate("window.__timestampClipboard.pending.shift()('1735689600');")
    expect(frame.locator('#timestampPasteBtn')).to_be_enabled()
    expect(frame.locator('#timestampInput')).to_have_value('newer draft')
    page.evaluate('window.__timestampClipboard.defer = false;')

    page.evaluate('window.__timestampClipboard.reject = true;')
    frame.locator('#timestampPasteBtn').click()
    expect(frame.locator('#timestampStatus')).to_contain_text('无法读取剪贴板')
    expect(frame.locator('#timestampPasteBtn')).to_be_enabled()
    expect(frame.locator('#timestampInput')).to_have_value('newer draft')
    page.evaluate('window.__timestampClipboard.reject = false;')


def exercise_draft_restore(page, frame):
    select_segment(frame, 'data-timestamp-unit', 'ms')
    select_segment(frame, 'data-current-unit', 'sec')
    select_segment(frame, 'data-date-zone', 'utc')
    frame.locator('#timestampInput').fill('-1')
    frame.locator('#dateInput').fill('2026-01-02T03:04:05.123')
    snapshot = frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    assert snapshot['state'] is not None, 'Timestamp tool needs a dedicated draft serializer'
    assert snapshot['canRelease'] is True
    frame.locator('#timestampInput').fill('changed after snapshot')
    frame.locator('#dateInput').fill('2000-01-01T00:00')
    select_segment(frame, 'data-timestamp-unit', 'sec')
    select_segment(frame, 'data-current-unit', 'ms')
    select_segment(frame, 'data-date-zone', 'local')
    frame.locator('#toDateBtn').click()
    frame.locator('#dateInput').fill('')
    frame.locator('#toTimestampBtn').click()
    for input_id, status_id in [('timestampInput', 'timestampStatus'), ('dateInput', 'dateStatus')]:
        expect(frame.locator('#' + input_id)).to_have_attribute('aria-invalid', 'true')
        expect(frame.locator('#' + status_id)).to_have_attribute('data-tone', 'error')

    # Restoring a different draft invalidates any pending clipboard operation.
    page.evaluate('window.__timestampClipboard.defer = true;')
    frame.locator('#timestampPasteBtn').click()
    page.wait_for_function('window.__timestampClipboard.pending.length === 1')
    frame.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    page.evaluate("window.__timestampClipboard.pending.shift()('stale clipboard');")
    expect(frame.locator('#timestampPasteBtn')).to_be_enabled()
    expect_draft(frame)
    for input_id, status_id in [('timestampInput', 'timestampStatus'), ('dateInput', 'dateStatus')]:
        expect(frame.locator('#' + input_id)).not_to_have_attribute('aria-invalid', 'true')
        expect(frame.locator('#' + status_id)).to_have_attribute('data-tone', '')
    page.evaluate('window.__timestampClipboard.defer = false;')


def expect_draft(frame):
    expect(frame.locator('#timestampInput')).to_have_value('-1')
    expect(frame.locator('#dateInput')).to_have_value('2026-01-02T03:04:05.123')
    for attribute, value in [('data-timestamp-unit', 'ms'), ('data-current-unit', 'sec'),
                             ('data-date-zone', 'utc')]:
        expect(frame.locator(f'[{attribute}="{value}"]')).to_have_attribute('aria-pressed', 'true')


def exercise_suspend(frame):
    select_segment(frame, 'data-current-unit', 'ms')
    frame.evaluate('window.__DTKIT_TOOL_PAGE__.setSuspended(true)')
    frozen = frame.locator('#currentTimestamp').inner_text()
    frame.wait_for_timeout(1200)
    expect(frame.locator('#currentTimestamp')).to_have_text(frozen)
    frame.evaluate('window.__DTKIT_TOOL_PAGE__.setSuspended(false)')
    frame.wait_for_function('previous => document.getElementById("currentTimestamp").textContent !== previous', arg=frozen)
    select_segment(frame, 'data-current-unit', 'sec')


def test_quick(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url + '/quick.html?kind=tool&toolId=timestamp-converter', wait_until='networkidle')
    expect(page.locator('.timestamp-container')).to_be_visible()
    assert page.locator('.sidebar,#tabBar,iframe.tool-page-frame').count() == 0
    exercise_conversion(page)
    exercise_clipboard(page, page)
    exercise_draft_restore(page, page)
    exercise_suspend(page)
    for width in (680, 390):
        resize_tool(page, page, width)
        page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-timestamp-quick-{width}.png'), full_page=True)
    page.emulate_media(color_scheme='dark', reduced_motion='reduce')
    expect(page.locator('.timestamp-container')).to_have_css('color-scheme', 'dark')
    expect(page.locator('#toDateBtn')).to_have_css('transition-duration', '0s')
    assert_segment_surfaces(page)
    assert_no_horizontal_overflow(page)
    page.screenshot(path=str(multi.SCREENSHOTS / 'dtkit-timestamp-quick-dark.png'), full_page=True)
    page.close()


def test_embedded(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url, wait_until='networkidle')
    page.locator('[data-tool-id="timestamp-converter"] .tool-card__title').click()
    frame = multi.active_tool_frame(page, '.timestamp-container')
    exercise_conversion(frame)
    exercise_clipboard(page, frame)
    exercise_draft_restore(page, frame)
    tab_a = multi.active_tab_id(page)
    multi.click_page_action(page, 'new')
    second = multi.active_tool_frame(page, '.timestamp-container')
    tab_b = multi.active_tab_id(page)
    expect(second.locator('#timestampInput')).to_have_value('')
    second.locator('#timestampInput').fill('second independent draft')
    multi.switch_tab(page, tab_a)
    expect_draft(frame)
    assert page.evaluate('window.__DTKIT_TOOL_WORKSPACE__.persist({prepareSleep:true})') is True
    page.reload(wait_until='networkidle')
    restored = multi.active_tool_frame(page, '.timestamp-container')
    expect_draft(restored)
    multi.switch_tab(page, tab_b)
    expect(multi.active_tool_frame(page, '.timestamp-container').locator('#timestampInput')).to_have_value('second independent draft')
    multi.switch_tab(page, tab_a)
    restored = multi.active_tool_frame(page, '.timestamp-container')
    exercise_suspend(restored)
    for width in (680, 390):
        resize_tool(page, restored, width)
        page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-timestamp-embedded-{width}.png'), full_page=True)
    page.emulate_media(color_scheme='dark', reduced_motion='reduce')
    expect(restored.locator('.timestamp-container')).to_have_css('color-scheme', 'dark')
    assert_segment_surfaces(restored)
    assert_no_horizontal_overflow(restored)
    page.screenshot(path=str(multi.SCREENSHOTS / 'dtkit-timestamp-embedded-dark.png'), full_page=True)
    page.close()


def run(base_url):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1360, 'height': 940},
                                      timezone_id='Asia/Shanghai', reduced_motion='reduce')
        context.add_init_script(multi.MOCK + '\n' + CLIPBOARD_MOCK)

        def apply_csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if 'text/html' in headers.get('content-type', ''):
                headers['content-security-policy'] = multi.CSP
            route.fulfill(response=response, headers=headers)

        context.route(base_url + '/**', apply_csp)
        try:
            print('Timestamp UI: standalone conversion, validation, clipboard and restore', flush=True)
            test_quick(context, base_url, errors)
            print('Timestamp UI: embedded drafts, workspace recovery and responsive layout', flush=True)
            test_embedded(context, base_url, errors)
            assert not errors, errors
        except Exception:
            for index, page in enumerate(context.pages):
                page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-timestamp-failure-{index}.png'), full_page=True)
            raise
        finally:
            context.close()
            browser.close()
    print(f'Timestamp converter UI smoke passed; screenshots={multi.SCREENSHOTS}')


if __name__ == '__main__':
    with multi.production_url() as base_url:
        run(base_url)
