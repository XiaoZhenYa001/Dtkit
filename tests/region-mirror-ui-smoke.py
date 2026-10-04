"""Tool-page behavior only; native DWM playback is verified separately on Windows."""
import functools
import http.server
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
MOCK = r"""
window.__mirrorCalls = [];
window.__mirrorItems = [];
window.__listeners = {};
window.__mirrorError = '';
window.__mirrorEmit = items => {
    window.__mirrorItems = items;
    for (const handler of window.__listeners['region-mirrors-changed'] || []) handler({payload:items});
};
window.__TAURI__ = {
    core: {invoke: async (command, args = {}) => {
        window.__mirrorCalls.push({command,args});
        if (command === 'list_region_mirrors') return window.__mirrorItems;
        if (command === 'start_region_mirror') {
            if (window.__mirrorError) throw window.__mirrorError;
            window.__mirrorEmit([{id:1,title:'正在选择区域…',status:'selecting',width:0,height:0,pinned:true}]);
            return;
        }
        if (command === 'control_region_mirror') {
            if (args.action === 'close') window.__mirrorEmit(window.__mirrorItems.filter(i => i.id !== args.id));
            if (args.action === 'pin') window.__mirrorEmit(window.__mirrorItems.map(i => i.id === args.id ? {...i,pinned:!i.pinned} : i));
            return;
        }
        if (['get_tool_module_settings','get_shortcut_bindings','take_missed_alarm_triggers'].includes(command)) return [];
        if (command === 'get_resource_policy') return {minimizeMode:'efficient'};
        return null;
    }},
    event: {listen: async (name, callback) => {
        (window.__listeners[name] ||= new Set()).add(callback);
        return () => window.__listeners[name].delete(callback);
    }},
    window: {getCurrentWindow: () => ({})}
};
"""

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

handler = functools.partial(QuietHandler, directory=str(ROOT / 'dist'))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={'width': 1180, 'height': 920})
            page.add_init_script(MOCK)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'http://127.0.0.1:{server.server_port}', wait_until='networkidle')
            page.locator('[data-tool-id="region-mirror"] .tool-card__title').click()
            expect(page.locator('.mirror-empty')).to_be_visible()
            expect(page.locator('#mirrorSelect')).to_be_enabled()
            page.screenshot(path='C:/tmp/dtkit-region-mirror-page.png', full_page=True)

            page.locator('#mirrorSelect').click()
            expect(page.locator('#mirrorSelect')).to_be_disabled()
            expect(page.locator('.mirror-status')).to_have_text('正在框选')
            # Cancellation must immediately allow another selection.
            page.evaluate('window.__mirrorEmit([])')
            expect(page.locator('#mirrorSelect')).to_be_enabled()
            page.evaluate("window.__mirrorError = '源窗口不可用'")
            page.locator('#mirrorSelect').click()
            expect(page.locator('#mirrorNotice')).to_have_text('源窗口不可用')
            expect(page.locator('#mirrorSelect')).to_be_enabled()
            page.evaluate("window.__mirrorError = ''")

            page.evaluate("window.__mirrorEmit([{id:2,title:'Video <img src=x onerror=alert(1)>',status:'live',width:1280,height:720,pinned:true}])")
            expect(page.locator('.mirror-row__body strong')).to_have_text('Video <img src=x onerror=alert(1)>')
            assert page.locator('.mirror-row img').count() == 0
            page.locator('[data-mirror-action="pin"]').click()
            expect(page.locator('[data-mirror-action="pin"]')).to_have_attribute('aria-pressed', 'false')
            page.locator('[data-mirror-action="show"]').click()
            assert page.evaluate("window.__mirrorCalls.some(c => c.command === 'control_region_mirror' && c.args.action === 'show' && c.args.id === 2)")

            # Tool navigation must remove listeners without stopping the native mirror.
            page.locator('[data-view="toolLibrary"]').click()
            assert page.evaluate("window.__listeners['region-mirrors-changed'].size") == 0
            assert page.evaluate('window.__mirrorItems.length') == 1
            page.locator('[data-tool-id="region-mirror"] .tool-card__title').click()
            expect(page.locator('.mirror-row')).to_have_count(1)
            assert page.evaluate("window.__listeners['region-mirrors-changed'].size") == 1
            page.locator('[data-mirror-action="close"]').click()
            expect(page.locator('.mirror-empty')).to_be_visible()

            page.evaluate("window.__mirrorEmit(Array.from({length:6}, (_,i) => ({id:i+10,title:'视频 '+i,status:'live',width:800,height:450,pinned:true})))")
            expect(page.locator('#mirrorSelect')).to_be_disabled()
            page.set_viewport_size({'width': 700, 'height': 850})
            assert page.locator('.mirror-shell').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            page.screenshot(path='C:/tmp/dtkit-region-mirror-narrow.png', full_page=True)
            assert errors == [], errors

            preview = browser.new_page(viewport={'width': 1000, 'height': 800})
            preview.goto(f'http://127.0.0.1:{server.server_port}', wait_until='networkidle')
            preview.locator('[data-tool-id="region-mirror"] .tool-card__title').click()
            expect(preview.locator('#mirrorSelect')).to_be_disabled()
            expect(preview.locator('#mirrorNotice')).to_contain_text('Windows 桌面版')
            print('PASS: selection/cancel/error, native controls, escaped titles, lifecycle, six-window limit, narrow layout, browser fallback')
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
