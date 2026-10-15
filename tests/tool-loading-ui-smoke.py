"""Control genuine startup delays and failures under the production CSP."""
import importlib.util
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
OUT = Path(__file__).parent / 'artifacts' / 'tool-loading'
OUT.mkdir(parents=True, exist_ok=True)
GATE = r"""
if (window === window.top) {
 const invoke = window.__TAURI__.core.invoke;
 window.__startupMode = 'normal'; window.__startupPending = [];
 window.__TAURI__.core.invoke = (command,args={}) => {
  if (command === 'get_tool_module_settings' && args.instanceId) {
   if (window.__startupMode === 'hold') return new Promise(resolve=>window.__startupPending.push(resolve));
   if (window.__startupMode === 'fail') return Promise.reject(new Error('测试加载失败'));
  }
  return invoke(command,args);
 };
}
"""


def context_for(browser, base, reduced=False):
    context = browser.new_context(viewport={'width': 1280, 'height': 800}, reduced_motion='reduce' if reduced else 'no-preference')
    context.add_init_script(multi.MOCK)
    def csp(route):
        response = route.fetch()
        headers = dict(response.headers)
        if 'text/html' in headers.get('content-type', ''):
            headers['content-security-policy'] = multi.CSP
        route.fulfill(response=response, headers=headers)
    context.route(base + '/**', csp)
    return context


def run(base):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = context_for(browser, base)
        context.add_init_script(GATE)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        try:
            page.goto(base, wait_until='networkidle')
            page.evaluate("__startupMode='hold'")
            page.locator('[data-tool-id="timetable"] .tool-card__title').click()
            loader = page.locator('.tool-loading:not([hidden])')
            expect(loader).to_have_attribute('data-motif', 'calendar')
            expect(loader.locator('h2')).to_have_text('课表')
            expect(loader.locator('.tool-loading__pattern > span')).to_have_count(21)
            page.wait_for_function('()=>__startupPending.length===1')
            page.screenshot(path=str(OUT / 'calendar.png'))
            assert page.locator('iframe.tool-page-frame:not([hidden])').evaluate('n=>n.inert')
            page.locator('[data-view="toolLibrary"]').click()
            expect(page.locator('.tool-loading:not([hidden])')).to_have_count(0)
            page.evaluate("__startupMode='normal';__startupPending.splice(0).forEach(resolve=>resolve([]))")
            page.locator('#backBtn').click()
            expect(page.locator('.tool-loading:not([hidden])')).to_have_count(0)
            frame = multi.active_tool_frame(page, '.tt-shell')
            assert not page.locator('iframe.tool-page-frame:not([hidden])').evaluate('n=>n.inert')
            page.locator('[data-view="toolLibrary"]').click()
            page.evaluate("__startupMode='fail'")
            page.locator('[data-tool-id="json-formatter"] .tool-card__title').click()
            loader = page.locator('.tool-loading:not([hidden])')
            expect(loader).to_have_attribute('data-failed', 'true')
            expect(loader.locator('[role="status"]')).to_contain_text('测试加载失败')
            assert loader.locator('.tool-loading__pattern span').first.evaluate('n=>getComputedStyle(n).animationName') == 'none'
            page.evaluate("__startupMode='normal'")
            loader.get_by_role('button', name='重新打开').click()
            expect(page.locator('.tool-loading:not([hidden])')).to_have_count(0)
            expect(page.locator('#dynamicToolContainer.tool-page-host')).to_have_attribute('aria-busy', 'false')
            assert not errors, errors
        finally:
            context.close()

        # A held module request exercises the standalone entry without fake timers.
        context = context_for(browser, base, reduced=True)
        pending = []
        context.route('**/assets/json-formatter-*.js', lambda route: pending.append(route))
        page = context.new_page()
        try:
            page.goto(base + '/quick.html?kind=tool&toolId=json-formatter', wait_until='domcontentloaded')
            loader = page.locator('.tool-loading')
            expect(loader).to_be_visible()
            expect(loader).to_have_attribute('data-motif', 'code')
            assert loader.locator('.tool-loading__pattern span').first.evaluate('n=>getComputedStyle(n).animationName') == 'none'
            page.screenshot(path=str(OUT / 'code.png'))
            assert pending
            for route in pending:
                route.continue_()
            expect(loader).to_have_count(0)
            assert not page.locator('#dynamicToolContainer').evaluate('n=>n.inert')
        finally:
            context.close()
            browser.close()


if __name__ == '__main__':
    with multi.production_url() as base:
        run(base)
    print('PASS: tool-specific startup, hidden tabs, readiness, retry, standalone and reduced motion')
