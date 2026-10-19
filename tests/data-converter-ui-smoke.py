"""Exercise production JSON/YAML/XML pages with real conversion workers.

Uses browser IPC and clipboard mocks, with the production CSP. Build once before
running; DTKIT_TEST_BASE_URL may point to an existing production preview server.
"""

import importlib.util
import json
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location('multi_page', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)

INSTRUMENTATION = r"""
(() => {
  const clipboard = window.__dataClipboard = {text: '', writes: [], pending: [], defer: false};
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
    writeText: async text => { clipboard.writes.push(String(text)); },
    readText: () => clipboard.defer
      ? new Promise(resolve => clipboard.pending.push(resolve)) : Promise.resolve(clipboard.text)
  }});
  const stats = window.__dataWorkers = {created: 0, sent: [], received: 0, terminated: 0};
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args); stats.created += 1;
      this.addEventListener('message', () => { stats.received += 1; });
    }
    postMessage(message, ...args) {
      stats.sent.push(structuredClone(message)); return super.postMessage(message, ...args);
    }
    terminate() { stats.terminated += 1; return super.terminate(); }
  };
})();
"""

XML_SOURCE = ('<root xml:lang="zh-CN" label="A &amp; B &quot;C&quot;">'
              '<a>00123</a><b>A &amp; B &lt; C</b><a>second</a>'
              '<p>before <em>bold</em> after &amp; end</p></root>')


def select_segment(frame, attribute, value):
    button = frame.locator(f'[{attribute}="{value}"]')
    button.click()
    expect(button).to_have_attribute('aria-pressed', 'true')


def assert_segment_surfaces(frame):
    groups = frame.locator('.data-converter-shell .tool-motion-segmented')
    expect(groups).to_have_count(4)
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


def set_auto(frame, enabled):
    frame.locator('#jsonAutoConvert').set_checked(enabled)
    assert frame.locator('#jsonAutoConvert').is_checked() is enabled


def convert(frame, source, *, source_format='auto', target='json', style='pretty', indent='2', root='root'):
    set_auto(frame, False)
    select_segment(frame, 'data-source-format', source_format)
    select_segment(frame, 'data-target-format', target)
    select_segment(frame, 'data-output-style', 'pretty')
    select_segment(frame, 'data-indent', indent)
    select_segment(frame, 'data-output-style', style)
    frame.locator('#jsonInput').fill(source)
    if target == 'xml' and source_format != 'xml' and frame.locator('#jsonRootName').is_visible():
        frame.locator('#jsonRootName').fill(root)
    frame.locator('#jsonConvertBtn').click()
    expect(frame.locator('#jsonConvertBtn')).to_be_enabled(timeout=10000)
    expect(frame.locator('#jsonErrorPanel')).to_be_hidden()
    expect(frame.locator('#jsonOutput')).not_to_have_value('')
    return frame.locator('#jsonOutput').input_value()


def assert_result_actions(frame, enabled):
    for selector in ('#jsonCopyOutputBtn', '#jsonDownloadBtn', '#jsonSwapBtn'):
        if enabled:
            expect(frame.locator(selector)).to_be_enabled()
        else:
            expect(frame.locator(selector)).to_be_disabled()


def xml_semantics(frame, source):
    return frame.evaluate("""source => {
      const document = new DOMParser().parseFromString(source, 'application/xml');
      const error = document.querySelector('parsererror');
      if (error) throw new Error('Invalid generated XML: ' + error.textContent);
      const visit = node => {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE)
          return {text: node.nodeValue};
        const mixed = [...node.childNodes].some(child =>
          [Node.TEXT_NODE, Node.CDATA_SECTION_NODE].includes(child.nodeType) && child.nodeValue.trim());
        return {name: node.nodeName,
          attributes: Object.fromEntries([...node.attributes].map(attribute => [attribute.name, attribute.value])
            .sort(([left], [right]) => left.localeCompare(right))),
          children: [...node.childNodes].filter(child => child.nodeType === Node.ELEMENT_NODE ||
            ([Node.TEXT_NODE, Node.CDATA_SECTION_NODE].includes(child.nodeType) && (mixed || child.nodeValue.trim())))
            .map(visit)};
      };
      return visit(document.documentElement);
    }""", source)


def exercise_formats(frame):
    expect(frame.locator('.data-converter-shell.dev-workbench')).to_be_visible()
    assert_segment_surfaces(frame)
    source = '{"app":"DtKit","items":[1,2],"ready":true}'
    frame.locator('#jsonInput').fill(source)
    expect(frame.locator('#jsonStatus')).to_contain_text('JSON → YAML', timeout=10000)
    expect(frame.locator('#jsonDetectedBadge')).to_contain_text('JSON 已识别')
    expect(frame.locator('#jsonOutput')).to_have_value(re.compile(r'app: DtKit'))
    select_segment(frame, 'data-target-format', 'xml')
    expect(frame.locator('#jsonOutput')).to_have_value(re.compile(r'<ready>true</ready>'), timeout=10000)
    xml_semantics(frame, frame.locator('#jsonOutput').input_value())
    frame.locator('#jsonSwapBtn').click()
    expect(frame.locator('[data-source-format="xml"]')).to_have_attribute('aria-pressed', 'true')
    expect(frame.locator('#jsonOutput')).to_have_value(re.compile(r'"app": "DtKit"'), timeout=10000)
    assert_result_actions(frame, True)

    for source_format, target_format in [('json', 'YAML'), ('yaml', 'JSON'), ('xml', 'JSON')]:
        frame.locator(f'[data-example-format="{source_format}"]').click()
        expect(frame.locator(f'[data-source-format="{source_format}"]')).to_have_attribute('aria-pressed', 'true')
        expect(frame.locator('#jsonStatus')).to_contain_text(f'{source_format.upper()} → {target_format}', timeout=10000)
        expect(frame.locator('#jsonOutput')).to_have_value(re.compile('DtKit'))

    yaml = 'app: DtKit\nitems:\n  - one\n  - two\n'
    pretty = convert(frame, yaml, source_format='yaml', indent='4')
    assert json.loads(pretty) == {'app': 'DtKit', 'items': ['one', 'two']}
    assert '\n    "app": "DtKit"' in pretty, pretty
    compact = convert(frame, yaml, source_format='yaml', style='compact')
    assert compact == '{"app":"DtKit","items":["one","two"]}', compact
    expect(frame.locator('#jsonIndentOption')).to_be_hidden()
    auto_yaml = convert(frame, yaml)
    assert json.loads(auto_yaml)['app'] == 'DtKit'
    expect(frame.locator('#jsonDetectedBadge')).to_contain_text('YAML 已识别')
    same_json = convert(frame, '{"nested":{"value":1}}', source_format='json', indent='4')
    assert '\n        "value": 1' in same_json, same_json

    # Escape XML text/attributes and retain numeric-looking XML text as strings.
    escaped = convert(frame, json.dumps({'message': 'A & B < C', '@_label': 'A & B "C"'}),
                      source_format='json', target='xml', root='payload')
    parsed = xml_semantics(frame, escaped)
    assert parsed['name'] == 'payload' and parsed['attributes']['label'] == 'A & B "C"', parsed
    assert parsed['children'][0] == {'name': 'message', 'attributes': {}, 'children': [{'text': 'A & B < C'}]}, parsed
    converted = json.loads(convert(frame, XML_SOURCE, source_format='xml'))
    assert converted['root']['a'] == ['00123', 'second'], converted
    assert converted['root']['b'] == 'A & B < C', converted
    assert converted['root']['@_xml:lang'] == 'zh-CN', converted

    expected = xml_semantics(frame, XML_SOURCE)
    for style in ('pretty', 'compact'):
        formatted = convert(frame, XML_SOURCE, source_format='xml', target='xml', style=style)
        assert xml_semantics(frame, formatted) == expected, formatted
        expect(frame.locator('#jsonRootOption')).to_be_hidden()

    # Manual mode must reveal a JSON-to-XML root immediately after replacing
    # previously detected XML, before another conversion updates the badge.
    convert(frame, XML_SOURCE, source_format='auto', target='xml')
    expect(frame.locator('#jsonRootOption')).to_be_hidden()
    frame.locator('#jsonInput').fill('{"fresh":true}')
    expect(frame.locator('#jsonRootOption')).to_be_visible()
    frame.locator('#jsonRootName').fill('freshRoot')
    frame.locator('#jsonConvertBtn').click()
    expect(frame.locator('#jsonOutput')).to_have_value(re.compile(r'<freshRoot>'), timeout=10000)
    assert frame.evaluate('window.__dataWorkers.created > 0 && window.__dataWorkers.received > 0'), 'Conversion bypassed the real Worker'


def exercise_errors(frame):
    set_auto(frame, False)
    select_segment(frame, 'data-source-format', 'yaml')
    select_segment(frame, 'data-target-format', 'json')
    frame.locator('#jsonInput').fill('project: DtKit\nitems: [one, two')
    frame.locator('#jsonInput').press('Control+Enter')
    expect(frame.locator('#jsonErrorPanel')).to_be_visible(timeout=10000)
    expect(frame.locator('#jsonErrorTitle')).to_contain_text('第')
    expect(frame.locator('#jsonErrorMessage')).to_contain_text('YAML')
    frame.locator('#jsonLocateError').click()
    selection = frame.locator('#jsonInput').evaluate('node => [node.selectionStart, node.selectionEnd, document.activeElement.id]')
    assert selection[0] > 0 and selection[1] >= selection[0] and selection[2] == 'jsonInput', selection
    assert_result_actions(frame, False)
    convert(frame, '{"recovered":true}', source_format='json')
    expect(frame.locator('#jsonErrorPanel')).to_be_hidden()
    assert_result_actions(frame, True)


def exercise_stale_and_auto_cancel(frame):
    convert(frame, '{"before":1}', source_format='json')
    baseline = frame.evaluate('window.__dataWorkers.sent.length')
    # Both changes share one browser turn, preventing a slow protocol round trip
    # from letting the debounce expire before automatic conversion is disabled.
    frame.evaluate("""() => {
      const auto = document.getElementById('jsonAutoConvert');
      auto.checked = true; auto.dispatchEvent(new Event('change', {bubbles:true}));
      const input = document.getElementById('jsonInput');
      input.value = '{"after":2}'; input.dispatchEvent(new Event('input', {bubbles:true}));
      auto.checked = false; auto.dispatchEvent(new Event('change', {bubbles:true}));
    }""")
    assert_result_actions(frame, False)
    frame.wait_for_timeout(600)
    assert frame.evaluate('window.__dataWorkers.sent.length') == baseline, 'Disabling auto conversion left its debounce queued'
    frame.locator('#jsonConvertBtn').click()
    expect(frame.locator('#jsonOutput')).to_have_value(re.compile(r'"after": 2'), timeout=10000)
    assert_result_actions(frame, True)
    frame.locator('#jsonInput').fill('{"notConverted":3}')
    assert_result_actions(frame, False)
    frame.wait_for_timeout(450)
    assert frame.evaluate('window.__dataWorkers.sent.length') == baseline + 1, 'Manual mode unexpectedly converted an edit'


def exercise_clipboard_and_file(page, frame):
    output = convert(frame, '{"copied":"local"}', source_format='json')
    frame.locator('#jsonCopyOutputBtn').click()
    page.wait_for_function('output => window.__dataClipboard.writes.at(-1) === output', arg=output)
    with page.expect_download() as download:
        frame.locator('#jsonDownloadBtn').click()
    assert download.value.suggested_filename.endswith('.json')

    page.evaluate("window.__dataClipboard.text = '{\"pasted\":true}';")
    frame.locator('#jsonPasteBtn').click()
    expect(frame.locator('#jsonInput')).to_have_value('{"pasted":true}')
    frame.locator('#jsonConvertBtn').click()
    expect(frame.locator('#jsonOutput')).to_have_value(re.compile(r'"pasted": true'), timeout=10000)

    page.evaluate('window.__dataClipboard.defer = true;')
    frame.locator('#jsonPasteBtn').click()
    page.wait_for_function('window.__dataClipboard.pending.length === 1')
    frame.locator('#jsonInput').fill('{"newer":"user draft"}')
    page.evaluate("async () => { window.__dataClipboard.pending.shift()('{\"stale\":true}'); await Promise.resolve(); }")
    expect(frame.locator('#jsonInput')).to_have_value('{"newer":"user draft"}')
    page.evaluate('window.__dataClipboard.defer = false;')

    # Delay actual File.text(), preserving the native file input/change path.
    frame.evaluate("""() => {
      window.__dataFileReads = [];
      window.__dataOriginalFileText = File.prototype.text;
      File.prototype.text = function() { return new Promise(resolve => window.__dataFileReads.push(resolve)); };
    }""")
    try:
        frame.locator('#jsonFileInput').set_input_files({'name': 'late.xml', 'mimeType': 'application/xml', 'buffer': b'<root>late</root>'})
        frame.wait_for_function('window.__dataFileReads.length === 1')
        frame.locator('#jsonInput').fill('{"newer":"after file started"}')
        frame.evaluate("async () => { window.__dataFileReads.shift()('<root>stale file</root>'); await Promise.resolve(); }")
        expect(frame.locator('#jsonInput')).to_have_value('{"newer":"after file started"}')
        expect(frame.locator('[data-source-format="json"]')).to_have_attribute('aria-pressed', 'true')
    finally:
        frame.evaluate('File.prototype.text = window.__dataOriginalFileText; delete window.__dataOriginalFileText;')


def capture_draft(frame):
    output = convert(frame, 'draft: saved\nitems: [one, two]\n', source_format='yaml',
                     target='xml', style='compact', indent='4', root='savedRoot')
    frame.locator('#jsonInput').evaluate('node => { node.focus(); node.setSelectionRange(3, 11); }')
    frame.locator('#jsonOutput').evaluate('node => node.setSelectionRange(2, 12)')
    snapshot = frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    assert snapshot['state'] is not None, 'Converter needs a dedicated draft serializer'
    assert snapshot['canRelease'] is True
    return snapshot, output


def expect_draft(frame, output):
    expect(frame.locator('#jsonInput')).to_have_value('draft: saved\nitems: [one, two]\n')
    expect(frame.locator('#jsonOutput')).to_have_value(output)
    expect(frame.locator('#jsonRootName')).to_have_value('savedRoot')
    expect(frame.locator('#jsonAutoConvert')).not_to_be_checked()
    for attribute, value in [('data-source-format', 'yaml'), ('data-target-format', 'xml'),
                             ('data-output-style', 'compact'), ('data-indent', '4')]:
        expect(frame.locator(f'[{attribute}="{value}"]')).to_have_attribute('aria-pressed', 'true')
    assert frame.locator('#jsonInput').evaluate('node => [node.selectionStart, node.selectionEnd]') == [3, 11]
    assert frame.locator('#jsonOutput').evaluate('node => [node.selectionStart, node.selectionEnd]') == [2, 12]
    assert_result_actions(frame, True)


def exercise_restore(page, frame):
    snapshot, output = capture_draft(frame)
    convert(frame, '{"other":true}', source_format='json', target='yaml')
    page.evaluate('window.__dataClipboard.defer = true;')
    frame.locator('#jsonPasteBtn').click()
    page.wait_for_function('window.__dataClipboard.pending.length === 1')
    frame.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    page.evaluate("async () => { window.__dataClipboard.pending.shift()('stale paste before restore'); await Promise.resolve(); }")
    expect_draft(frame, output)
    page.evaluate('window.__dataClipboard.defer = false;')
    return output


def assert_no_overflow(frame):
    metrics = frame.evaluate("""() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      tool: document.querySelector('.data-converter-shell').scrollWidth,
      width: document.querySelector('.data-converter-shell').clientWidth,
      panels: [...document.querySelectorAll('.data-editor-panel')].map(node => [node.scrollWidth, node.clientWidth])
    })""")
    assert metrics['document'] <= metrics['viewport'] + 1, metrics
    assert metrics['tool'] <= metrics['width'] + 1, metrics
    assert all(scroll <= width + 1 for scroll, width in metrics['panels']), metrics


def exercise_layout(page, frame, entry):
    for width in (680, 390):
        page.set_viewport_size({'width': page.evaluate('innerWidth') + width - frame.evaluate('innerWidth'), 'height': 940})
        frame.wait_for_function('width => innerWidth === width', arg=width)
        assert_no_overflow(frame)
        assert_segment_surfaces(frame)
        page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-data-{entry}-{width}.png'), full_page=True)
    page.emulate_media(color_scheme='dark', reduced_motion='reduce')
    expect(frame.locator('.data-converter-shell')).to_have_css('color-scheme', 'dark')
    assert_no_overflow(frame)
    assert_segment_surfaces(frame)
    page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-data-{entry}-dark.png'), full_page=True)


def test_quick(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url + '/quick.html?kind=tool&toolId=json-formatter', wait_until='networkidle')
    expect(page.locator('#jsonInput')).to_be_visible()
    assert page.locator('.sidebar,#tabBar,iframe.tool-page-frame').count() == 0
    exercise_formats(page)
    exercise_errors(page)
    exercise_stale_and_auto_cancel(page)
    exercise_clipboard_and_file(page, page)
    exercise_restore(page, page)
    exercise_layout(page, page, 'quick')
    page.close()


def test_embedded(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url, wait_until='networkidle')
    page.locator('[data-tool-id="json-formatter"] .tool-card__title').click()
    frame = multi.active_tool_frame(page, '.data-converter-shell.dev-workbench')
    exercise_formats(frame)
    exercise_errors(frame)
    exercise_stale_and_auto_cancel(frame)
    exercise_clipboard_and_file(page, frame)
    output = exercise_restore(page, frame)
    tab_a = multi.active_tab_id(page)
    multi.click_page_action(page, 'new')
    second = multi.active_tool_frame(page, '.data-converter-shell.dev-workbench')
    tab_b = multi.active_tab_id(page)
    expect(second.locator('#jsonInput')).to_have_value('')
    set_auto(second, False)
    second.locator('#jsonInput').fill('second independent draft')
    multi.switch_tab(page, tab_a)
    expect_draft(frame, output)
    assert page.evaluate('window.__DTKIT_TOOL_WORKSPACE__.persist({prepareSleep:true})') is True
    page.reload(wait_until='networkidle')
    restored = multi.active_tool_frame(page, '.data-converter-shell.dev-workbench')
    expect_draft(restored, output)
    multi.switch_tab(page, tab_b)
    expect(multi.active_tool_frame(page, '.data-converter-shell').locator('#jsonInput')).to_have_value('second independent draft')
    multi.switch_tab(page, tab_a)
    restored = multi.active_tool_frame(page, '.data-converter-shell')
    exercise_layout(page, restored, 'embedded')
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
            print('Data converter UI: standalone formats, real Worker, races and draft restoration', flush=True)
            test_quick(context, base_url, errors)
            print('Data converter UI: embedded isolation, workspace reload and responsive layout', flush=True)
            test_embedded(context, base_url, errors)
            assert not errors, errors
        except Exception:
            for index, page in enumerate(context.pages):
                page.screenshot(path=str(multi.SCREENSHOTS / f'dtkit-data-failure-{index}.png'), full_page=True)
            raise
        finally:
            context.close()
            browser.close()
    print(f'Data converter UI smoke passed; screenshots={multi.SCREENSHOTS}')


if __name__ == '__main__':
    with multi.production_url() as base_url:
        run(base_url)
