"""Verify wheel scrolling in the production layout, including tab restore.

Uses browser IPC mocks and the real production CSP; no native settings are changed.
"""

import importlib.util
import re
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location("multi_page", Path(__file__).with_name("multi-page-ui-smoke.py"))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)


def wait_until(page, predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        page.wait_for_timeout(50)
    raise AssertionError('Tool did not reach the expected scroll position')


def wheel(page, surface, delta):
    box = surface.bounding_box()
    # Use the outer page margin to avoid textarea/list/canvas wheel ownership.
    page.mouse.move(box['x'] + box['width'] - 25, box['y'] + box['height'] * 0.7)
    page.mouse.wheel(0, delta)


def at_bottom(frame):
    return frame.evaluate('document.scrollingElement.scrollTop + innerHeight >= document.scrollingElement.scrollHeight - 2')


def open_main_tool(page, tool_id):
    if page.locator('#toolLibraryView').is_hidden():
        page.locator('[data-view="toolLibrary"]').click()
    page.locator(f'[data-tool-id="{tool_id}"] .tool-card__title').click()
    frame = multi.active_tool_frame(page, '#dynamicToolContainer > *')
    expect(frame.locator('#toolPageStatus')).to_be_hidden()
    page.wait_for_timeout(350)  # Finish the entrance animation before wheel hit testing.
    return frame


def test_main_scrolling(page, base_url):
    page.goto(base_url, wait_until='networkidle')
    for tool_id in ['unit-converter', 'qr-generator', 'alarm-clock', 'timetable']:
        frame = open_main_tool(page, tool_id)
        surface = page.locator('iframe.tool-page-frame:not([hidden])')
        assert frame.evaluate('document.scrollingElement.scrollHeight > innerHeight + 20'), tool_id
        wheel(page, surface, 6000)
        wait_until(page, lambda: at_bottom(frame))
        assert frame.evaluate('document.scrollingElement.scrollTop') > 20, tool_id
        wheel(page, surface, -6000)
        wait_until(page, lambda: frame.evaluate('document.scrollingElement.scrollTop') == 0)
        print(f'Embedded {tool_id}: wheel reaches bottom and returns to top', flush=True)

    # Split-panel tools own their scrolling within the editor/configuration panels.
    hash_frame = open_main_tool(page, 'hash-tool')
    for selector in ['.hash-main-panel', '.hash-config-panel']:
        test_panel_scrolling(page, hash_frame.locator(selector))
    html_frame = open_main_tool(page, 'html-preview')
    test_editor_scrolling(page, html_frame)

    # Same-tool tabs keep separate scroll positions and survive journal restore.
    frame_a = open_main_tool(page, 'unit-converter')
    tab_a = multi.active_tab_id(page)
    wheel(page, page.locator('iframe.tool-page-frame:not([hidden])'), 220)
    wait_until(page, lambda: frame_a.evaluate('document.scrollingElement.scrollTop') > 20)
    page.wait_for_timeout(350)  # Wait until Chromium finishes wheel scrolling.
    scroll_a = frame_a.evaluate('document.scrollingElement.scrollTop')
    multi.click_page_action(page, 'new')
    frame_b = multi.active_tool_frame(page, '.unit-tool')
    expect(frame_b.locator('#toolPageStatus')).to_be_hidden()
    tab_b = multi.active_tab_id(page)
    page.wait_for_timeout(350)
    # The unit tool focuses its input on startup; explicitly scroll this tab to top.
    wheel(page, page.locator('iframe.tool-page-frame:not([hidden])'), -6000)
    wait_until(page, lambda: frame_b.evaluate('document.scrollingElement.scrollTop') == 0)
    multi.switch_tab(page, tab_a)
    assert frame_a.evaluate('document.scrollingElement.scrollTop') == scroll_a, (scroll_a, frame_a.evaluate('[document.scrollingElement.scrollTop,innerHeight,document.scrollingElement.scrollHeight]'))
    multi.switch_tab(page, tab_b)
    assert frame_b.evaluate('document.scrollingElement.scrollTop') == 0
    multi.switch_tab(page, tab_a)
    page.evaluate('window.__DTKIT_TOOL_WORKSPACE__.persist()')
    page.reload(wait_until='networkidle')
    restored = multi.active_tool_frame(page, '.unit-tool')
    expect(restored.locator('#toolPageStatus')).to_be_hidden()
    restored_scroll = restored.evaluate('document.scrollingElement.scrollTop')
    assert abs(restored_scroll - scroll_a) <= 1, (scroll_a, restored_scroll, restored.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().scrollTop'))


def test_quick_scrolling(page, base_url):
    for tool_id in ['unit-converter', 'qr-generator', 'alarm-clock', 'timetable']:
        page.goto(base_url + f'/quick.html?kind=tool&toolId={tool_id}', wait_until='networkidle')
        surface = page.locator('#quickContent')
        expect(surface).to_have_class(re.compile(r'quick-content--tool'))
        wheel(page, surface, 6000)
        wait_until(page, lambda: surface.evaluate('(node) => node.scrollTop > 20 && node.scrollTop + node.clientHeight >= node.scrollHeight - 2'))
        wheel(page, surface, -6000)
        wait_until(page, lambda: surface.evaluate('(node) => node.scrollTop') == 0)
        assert page.locator('.quick-footer').bounding_box()['y'] < 600
        print(f'Standalone {tool_id}: wheel reaches bottom and returns to top', flush=True)

    page.goto(base_url + '/quick.html?kind=tool&toolId=hash-tool', wait_until='networkidle')
    expect(page.locator('.hash-main-panel')).to_be_visible()
    page.wait_for_timeout(1000)  # Wait for both panel entrance animations.
    for selector in ['.hash-main-panel', '.hash-config-panel']:
        test_panel_scrolling(page, page.locator(selector))
    page.goto(base_url + '/quick.html?kind=tool&toolId=html-preview', wait_until='networkidle')
    expect(page.locator('#htmlEditor')).to_be_visible()
    test_editor_scrolling(page, page)


def test_panel_scrolling(page, panel):
    assert panel.evaluate('(node) => node.scrollHeight > node.clientHeight + 20')
    wheel(page, panel, 6000)
    wait_until(page, lambda: panel.evaluate('(node) => node.scrollTop > 20 && node.scrollTop + node.clientHeight >= node.scrollHeight - 2'))
    wheel(page, panel, -6000)
    wait_until(page, lambda: panel.evaluate('(node) => node.scrollTop') == 0)


def test_editor_scrolling(page, frame):
    editor = frame.locator('#htmlEditor')
    editor.fill('\n'.join(f'<p>scroll line {index}</p>' for index in range(160)))
    editor.press('Control+Home')
    wheel(page, editor, 1200)
    wait_until(page, lambda: editor.evaluate('(node) => node.scrollTop') > 20)
    wheel(page, editor, -6000)
    wait_until(page, lambda: editor.evaluate('(node) => node.scrollTop') == 0)


def run(base_url):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width":1200,"height":600})
        context.add_init_script(multi.MOCK)
        errors = []
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))

        def apply_csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if 'text/html' in headers.get('content-type', ''):
                headers['content-security-policy'] = multi.CSP
            route.fulfill(response=response, headers=headers)

        context.route(base_url + '/**', apply_csp)
        try:
            test_main_scrolling(page, base_url)
            test_quick_scrolling(page, base_url)
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(multi.SCREENSHOTS / 'dtkit-tool-scroll-failure.png'), full_page=True)
            raise
        finally:
            context.close()
            browser.close()


if __name__ == '__main__':
    with multi.production_url() as base_url:
        run(base_url)
    print('Tool scrolling UI smoke passed')
