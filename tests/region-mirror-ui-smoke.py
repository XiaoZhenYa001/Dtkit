"""Tool-page behavior only; native DWM playback is verified separately on Windows."""
import functools
import http.server
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / '.tmp' / 'region-mirror'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
MOCK = r"""
window.__mirrorCalls = [];
window.__mirrorItems = [];
window.__listeners = {};
window.__mirrorError = '';
window.__mirrorControlError = '';
window.__mirrorDeferClose = false;
window.__mirrorDeferred = [];
window.__mirrorDeferLists = false;
window.__mirrorEmit = items => {
    window.__mirrorItems = items;
    for (const handler of window.__listeners['region-mirrors-changed'] || []) handler({payload:items});
};
window.__TAURI__ = {
    core: {invoke: async (command, args = {}) => {
        window.__mirrorCalls.push({command,args});
        if (command === 'list_region_mirrors') {
            if (window.__mirrorDeferLists) return new Promise(resolve => window.__mirrorDeferred.push(resolve));
            return window.__mirrorItems;
        }
        if (command === 'start_region_mirror') {
            if (window.__mirrorError) throw window.__mirrorError;
            window.__mirrorEmit([...window.__mirrorItems,{id:1,title:'正在选择区域…',status:'selecting',width:0,height:0,pinned:true}]);
            return;
        }
        if (command === 'control_region_mirror') {
            if (window.__mirrorControlError) throw window.__mirrorControlError;
            if (args.action === 'close') {
                const close = () => window.__mirrorEmit(window.__mirrorItems.filter(i => i.id !== args.id));
                if (window.__mirrorDeferClose) setTimeout(close, 80);
                else close();
            }
            if (args.action === 'pin') window.__mirrorEmit(window.__mirrorItems.map(i => i.id === args.id ? {...i,pinned:!i.pinned} : i));
            if (['compact','clickThrough'].includes(args.action)) window.__mirrorEmit(window.__mirrorItems.map(i => i.id === args.id ? {...i,[args.action]:!i[args.action]} : i));
            if (args.action === 'opacity') window.__mirrorEmit(window.__mirrorItems.map(i => i.id === args.id ? {...i,opacity:args.value} : i));
            if (args.action === 'show') window.__mirrorEmit(window.__mirrorItems.map(i => i.id === args.id ? {...i,clickThrough:false} : i));
            if (args.action === 'reset') window.__mirrorEmit(window.__mirrorItems.map(i => i.id === args.id ? {...i,compact:false,clickThrough:false,opacity:100} : i));
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

def tool_view(page):
    """Tools in the main app live in an isolated page; quick/editor entries are direct."""
    if page.locator("#toolLibraryView").count():
        return page.frame_locator("iframe.tool-page-frame:not([hidden])")
    return page


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
            expect(tool_view(page).locator('.mirror-empty')).to_be_visible()
            expect(tool_view(page).locator('#mirrorSelect')).to_be_enabled()
            page.screenshot(path=str(ARTIFACTS / 'page.png'), full_page=True)

            tool_view(page).locator('#mirrorSelect').click()
            expect(tool_view(page).locator('#mirrorSelect')).to_be_disabled()
            expect(tool_view(page).locator('.mirror-status')).to_have_text('正在框选')
            # Cancellation must immediately allow another selection.
            page.evaluate('window.__mirrorEmit([])')
            expect(tool_view(page).locator('#mirrorSelect')).to_be_enabled()
            page.evaluate("window.__mirrorError = '源窗口不可用'")
            tool_view(page).locator('#mirrorSelect').click()
            expect(tool_view(page).locator('#mirrorNotice')).to_have_text('源窗口不可用')
            expect(tool_view(page).locator('#mirrorSelect')).to_be_enabled()
            page.evaluate("window.__mirrorError = ''")

            page.evaluate("window.__mirrorEmit([{id:2,title:'Video <img src=x onerror=alert(1)>',status:'live',width:1280,height:720,pinned:true}])")
            expect(tool_view(page).locator('.mirror-row__body strong')).to_have_text('Video <img src=x onerror=alert(1)>')
            assert tool_view(page).locator('.mirror-row img').count() == 0
            tool_view(page).locator('[data-mirror-action="pin"]').click()
            expect(tool_view(page).locator('[data-mirror-action="pin"]')).to_have_attribute('aria-pressed', 'false')
            tool_view(page).locator('[data-mirror-action="show"]').click()
            assert page.evaluate("window.__mirrorCalls.some(c => c.command === 'control_region_mirror' && c.args.action === 'show' && c.args.id === 2)")

            tool_view(page).locator('.mirror-options summary').click()
            tool_view(page).locator('[data-mirror-action="compact"]').focus()
            tool_view(page).locator('[data-mirror-action="compact"]').press('Enter')
            expect(tool_view(page).locator('[data-mirror-action="compact"]')).to_have_attribute('aria-pressed','true')
            expect(tool_view(page).locator('[data-mirror-action="compact"]')).to_be_focused()
            expect(tool_view(page).locator('.mirror-options')).to_have_attribute('open','')
            tool_view(page).locator('[data-mirror-action="opacity"]').focus()
            tool_view(page).locator('[data-mirror-action="opacity"]').select_option('70')
            expect(tool_view(page).locator('[data-mirror-action="opacity"]')).to_have_value('70')
            expect(tool_view(page).locator('[data-mirror-action="opacity"]')).to_be_focused()
            tool_view(page).locator('[data-mirror-action="scale"]').select_option('50')
            assert page.evaluate("window.__mirrorCalls.some(c=>c.command==='control_region_mirror' && c.args.action==='scale' && c.args.value===50)")
            tool_view(page).locator('[data-mirror-action="clickThrough"]').click()
            expect(tool_view(page).locator('[data-mirror-action="clickThrough"]')).to_have_attribute('aria-pressed','true')
            expect(tool_view(page).locator('#mirrorNotice')).to_contain_text('找回小窗')
            tool_view(page).locator('[data-mirror-action="show"]').click()
            expect(tool_view(page).locator('[data-mirror-action="clickThrough"]')).to_have_attribute('aria-pressed','false')
            tool_view(page).locator('[data-mirror-action="source"]').click()
            assert page.evaluate("window.__mirrorCalls.some(c=>c.command==='control_region_mirror' && c.args.action==='source')")
            tool_view(page).locator('[data-mirror-action="reset"]').click()
            expect(tool_view(page).locator('[data-mirror-action="opacity"]')).to_have_value('100')
            expect(tool_view(page).locator('[data-mirror-action="compact"]')).to_have_attribute('aria-pressed','false')

            page.evaluate("window.__mirrorControlError='窗口暂不可用'")
            tool_view(page).locator('[data-mirror-action="pin"]').click()
            expect(tool_view(page).locator('#mirrorNotice')).to_have_text('窗口暂不可用')
            expect(tool_view(page).locator('[data-mirror-action="pin"]')).to_be_enabled()
            page.evaluate("window.__mirrorControlError=''")

            # Old list requests may settle after newer requests or live events.
            page.evaluate('window.__mirrorDeferLists=true')
            tool_view(page).locator('#mirrorRefresh').click()
            tool_view(page).locator('#mirrorRefresh').click()
            page.wait_for_function('window.__mirrorDeferred.length===2')
            page.evaluate("window.__mirrorDeferred[1]([{...window.__mirrorItems[0],title:'new snapshot'}])")
            expect(tool_view(page).locator('.mirror-row__body strong')).to_have_text('new snapshot')
            page.evaluate("window.__mirrorDeferred[0]([])")
            expect(tool_view(page).locator('.mirror-row')).to_have_count(1)
            tool_view(page).locator('#mirrorRefresh').click()
            page.wait_for_function('window.__mirrorDeferred.length===3')
            page.evaluate("window.__mirrorEmit(window.__mirrorItems.map(i=>({...i,title:'live event',error:'DWM <img src=x onerror=alert(1)>'})))")
            page.evaluate('window.__mirrorDeferred[2]([]);window.__mirrorDeferLists=false')
            expect(tool_view(page).locator('.mirror-row__body strong')).to_have_text('live event')
            expect(tool_view(page).locator('.mirror-row__hint--error')).to_have_text('DWM <img src=x onerror=alert(1)>')
            assert tool_view(page).locator('.mirror-row img').count()==0

            tool_view(page).locator('[data-mirror-action="reselect"]').click()
            assert page.evaluate("window.__mirrorCalls.some(c=>c.command==='start_region_mirror'&&c.args.replaceId===2)")
            expect(tool_view(page).locator('.mirror-row')).to_have_count(2)
            page.evaluate('window.__mirrorEmit(window.__mirrorItems.filter(i=>i.status!=="selecting"))')
            expect(tool_view(page).locator('.mirror-row')).to_have_count(1)
            expect(tool_view(page).locator('#mirrorNotice')).to_contain_text('已取消框选')
            page.evaluate("window.__mirrorError='框选启动失败'")
            tool_view(page).locator('[data-mirror-action="reselect"]').focus()
            tool_view(page).locator('[data-mirror-action="reselect"]').press('Enter')
            expect(tool_view(page).locator('#mirrorNotice')).to_have_text('框选启动失败')
            expect(tool_view(page).locator('[data-mirror-action="reselect"]')).to_be_focused()
            tool_view(page).locator('#mirrorSelect').focus()
            tool_view(page).locator('#mirrorSelect').press('Enter')
            expect(tool_view(page).locator('#mirrorSelect')).to_be_focused()
            page.evaluate("window.__mirrorError=''")

            # Closing this page releases listeners without stopping its native mirror.
            # Navigation retains a suspended history page so the user can return to it.
            mirror_tab = page.locator('.tab--active').get_attribute('data-tab-id')
            page.locator('#addTabBtn').click()
            page.locator(f'.tab[data-tab-id="{mirror_tab}"] .tab__close').click()
            page.wait_for_function("window.__listeners['region-mirrors-changed'].size === 0")
            assert page.evaluate('window.__mirrorItems.length') == 1
            page.locator('[data-tool-id="region-mirror"] .tool-card__title').click()
            expect(tool_view(page).locator('.mirror-row')).to_have_count(1)
            assert page.evaluate("window.__listeners['region-mirrors-changed'].size") == 1
            page.evaluate('window.__mirrorDeferClose=true')
            tool_view(page).locator('[data-mirror-action="close"]').focus()
            tool_view(page).locator('[data-mirror-action="close"]').press('Enter')
            expect(tool_view(page).locator('.mirror-empty')).to_be_visible()
            expect(tool_view(page).locator('#mirrorSelect')).to_be_focused()

            page.evaluate("window.__mirrorEmit(Array.from({length:6}, (_,i) => ({id:i+10,title:'视频 '+i,status:'live',width:800,height:450,pinned:true})))")
            expect(tool_view(page).locator('#mirrorSelect')).to_be_disabled()
            page.set_viewport_size({'width': 700, 'height': 850})
            assert tool_view(page).locator('.mirror-shell').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            page.screenshot(path=str(ARTIFACTS / 'narrow.png'), full_page=True)
            tool_view(page).locator('.mirror-options summary').first.click()
            expect(tool_view(page).locator('[data-mirror-action="reselect"]').first).to_be_enabled()
            page.set_viewport_size({'width': 360, 'height': 800})
            assert tool_view(page).locator('.mirror-shell').evaluate('(e)=>e.scrollWidth <= e.clientWidth+1')
            page.screenshot(path=str(ARTIFACTS / 'compact.png'), full_page=True)
            # Failure states carry a direct recovery action, and closed sources cannot be activated.
            page.evaluate("window.__mirrorEmit([{id:20,title:'closed source',status:'closed',width:320,height:180,pinned:true}])")
            expect(tool_view(page).locator('[data-mirror-action="source"]')).to_be_disabled()
            expect(tool_view(page).locator('.mirror-row__hint')).to_contain_text('重新框选')
            assert errors == [], errors

            preview = browser.new_page(viewport={'width': 1000, 'height': 800})
            preview.goto(f'http://127.0.0.1:{server.server_port}', wait_until='networkidle')
            preview.locator('[data-tool-id="region-mirror"] .tool-card__title').click()
            expect(tool_view(preview).locator('#mirrorSelect')).to_be_disabled()
            expect(tool_view(preview).locator('#mirrorNotice')).to_contain_text('Windows 桌面版')
            print('PASS: selection/reselect/cancel, controls/keyboard focus/errors, async snapshot races, escaped titles/errors, lifecycle, six-window replacement, narrow layout, browser fallback')
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
