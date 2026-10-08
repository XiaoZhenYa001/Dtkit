"""Context menu UI against deterministic IPC mocks; never edits the registry."""

import functools
import http.server
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = Path(tempfile.gettempdir())
SCAN = "scan_context_menu_items"
SET_ENABLED = "set_context_menu_enabled"
MOCK = r"""
window.__contextCalls = [];
window.__contextFailure = {};
window.__contextListeners = {};
window.__holdContextScans = false;
window.__pendingContextScans = [];
window.__holdContextMutations = false;
window.__pendingContextMutations = [];
window.__contextClipboard = '';
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text => { window.__contextClipboard = text; }}});
window.__contextItem = (overrides = {}) => ({
    id:'verb-user',name:'编辑工具 <img src=x onerror=alert(1)>',kind:'verb',
    categories:['files','folders'],scope:'user',registryPath:'HKCU\\Software\\Classes\\*\\shell\\Editor',
    command:'"C:\\Apps\\Editor.exe" "%1" <script>alert(1)</script>',clsid:null,
    enabled:true,canToggle:true,disabledReason:null,requiresElevation:false,
    managed:false,fingerprint:'revision-1',detail:'用户注册菜单 <svg onload=alert(1)>',...overrides
});
window.__contextItems = [
    window.__contextItem(),
    window.__contextItem({id:'extension-system',name:'共享压缩扩展',kind:'extension',scope:'system',
        categories:['folders','folderBackground','desktop'],command:'C:\\Apps\\Compress.dll',
        clsid:'{11111111-1111-1111-1111-111111111111}',detail:'同一扩展用于多个菜单'}),
    window.__contextItem({id:'managed-verb',name:'PDF 转换',categories:['fileTypes'],enabled:false,
        managed:true,detail:'由 DtKit 关闭，可恢复',disabledReason:'由 DtKit 关闭'}),
    window.__contextItem({id:'external-extension',name:'外部禁用扩展',kind:'extension',
        categories:['drives'],enabled:false,canToggle:false,disabledReason:'已由其他工具关闭',
        clsid:'{22222222-2222-2222-2222-222222222222}'}),
    window.__contextItem({id:'protected-verb',name:'系统保护菜单',scope:'system',categories:['files'],
        canToggle:false,requiresElevation:true,disabledReason:'受保护菜单，仅可查看'})
];
window.__contextWarnings = [];
window.__contextSnapshot = extension => ({
    items:structuredClone(window.__contextItems),total:window.__contextItems.length,
    enabled:window.__contextItems.filter(item => item.enabled).length,
    disabled:window.__contextItems.filter(item => !item.enabled).length,
    readOnly:window.__contextItems.filter(item => !item.canToggle).length,
    scannedAt:Date.now(),warnings:structuredClone(window.__contextWarnings),extension:extension || null
});
window.__contextFinishMutation = args => {
    if (window.__contextFailure.set_context_menu_enabled) throw window.__contextFailure.set_context_menu_enabled;
    const item = window.__contextItems.find(candidate => candidate.id === args.id);
    if (!item || !item.canToggle) throw '此菜单仅可查看';
    if (item.fingerprint !== args.expectedFingerprint) throw '菜单已被其他程序修改，请刷新后重试';
    item.enabled = args.enabled;
    item.managed = !args.enabled;
    item.disabledReason = args.enabled ? null : '由 DtKit 关闭';
    item.fingerprint += '-next';
    return window.__contextSnapshot(args.extension);
};
window.__releaseContextScan = (index = 0) => {
    const pending = window.__pendingContextScans.splice(index,1)[0];
    if (!pending) throw new Error('No pending scan');
    if (window.__contextFailure.scan_context_menu_items) pending.reject(window.__contextFailure.scan_context_menu_items);
    else pending.resolve(pending.snapshot);
};
window.__releaseContextMutation = () => {
    const pending = window.__pendingContextMutations.shift();
    if (!pending) throw new Error('No pending mutation');
    try { pending.resolve(window.__contextFinishMutation(pending.args)); }
    catch (error) { pending.reject(error); }
};
window.__TAURI__ = {
    core:{invoke:async (command,args = {}) => {
        window.__contextCalls.push({command,args:structuredClone(args)});
        if (window.__contextFailure[command]) throw window.__contextFailure[command];
        if (command === 'scan_context_menu_items') {
            const snapshot = window.__contextSnapshot(args.extension);
            if (window.__holdContextScans) return new Promise((resolve,reject) => {
                window.__pendingContextScans.push({resolve,reject,snapshot});
            });
            return snapshot;
        }
        if (command === 'set_context_menu_enabled') {
            if (window.__holdContextMutations) return new Promise((resolve,reject) => {
                window.__pendingContextMutations.push({resolve,reject,args:structuredClone(args)});
            });
            return window.__contextFinishMutation(args);
        }
        if (['get_tool_module_settings','get_shortcut_bindings','take_missed_alarm_triggers'].includes(command)) return [];
        if (command === 'get_resource_policy') return {minimizeMode:'efficient'};
        return null;
    }},
    event:{listen:async (name,callback) => {
        (window.__contextListeners[name] ||= new Set()).add(callback);
        return () => window.__contextListeners[name].delete(callback);
    }},
    window:{getCurrentWindow:() => ({})}
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


def call_count(page, command):
    return page.evaluate("command => window.__contextCalls.filter(call => call.command === command).length", command)


def wait_for_calls(page, command, count):
    page.wait_for_function(
        "({command,count}) => window.__contextCalls.filter(call => call.command === command).length === count",
        arg={"command": command, "count": count},
    )


def toggle(page, item_id):
    return tool_view(page).locator(f'[data-context-toggle="{item_id}"]')


def open_panel(browser, base_url, errors, *, quick=False, width=1180, height=920, setup='', ready=True, native=True):
    page = browser.new_page(viewport={"width": width, "height": height})
    if native:
        page.add_init_script(MOCK + '\n' + setup)
    page.on("pageerror", lambda error: errors.append(str(error)))
    path = "/quick.html?kind=tool&toolId=context-menu" if quick else "/"
    page.goto(base_url + path, wait_until="networkidle")
    if not quick:
        page.locator('[data-tool-id="context-menu"] .tool-card__title').click()
    expect(tool_view(page).locator("#contextList")).to_be_visible()
    if ready:
        expect(toggle(page, "verb-user")).to_be_visible()
    return page


def item_row(page, item_id):
    return tool_view(page).locator(f'[data-context-id="{item_id}"]')


def reopen_panel(page):
    page.locator('[data-view="toolLibrary"]').click()
    page.locator('[data-tool-id="context-menu"] .tool-card__title').click()
    expect(tool_view(page).locator('#contextList')).to_be_visible()


def test_scan_and_filters(browser, base_url, errors):
    page = open_panel(browser, base_url, errors)
    expect(tool_view(page).locator('.context-row')).to_have_count(5)
    for selector, text in [('#contextTotal', '5'), ('#contextEnabled', '3'),
                           ('#contextDisabled', '2'), ('#contextReadOnly', '2')]:
        expect(tool_view(page).locator(selector)).to_have_text(text)
    assert call_count(page, SCAN) == 1

    # Names, commands, details and warnings are data, including when opened or copied.
    expect(item_row(page, 'verb-user').locator('h3')).to_contain_text('<img src=x onerror=alert(1)>')
    tool_view(page).locator('[data-context-details="verb-user"]').click()
    expect(item_row(page, 'verb-user').locator('.context-detail')).to_contain_text('<script>alert(1)</script>')
    tool_view(page).locator('[data-context-copy="verb-user"]').click()
    page.wait_for_function("window.__contextClipboard.includes('HKCU\\\\Software')")
    assert tool_view(page).locator('.context-shell img,.context-shell svg,.context-shell script').count() == 0

    tool_view(page).locator('[data-context-category="folders"]').click()
    expect(tool_view(page).locator('.context-row')).to_have_count(2)
    tool_view(page).locator('[data-context-category="desktop"]').click()
    expect(tool_view(page).locator('.context-row')).to_have_count(1)
    expect(toggle(page, 'extension-system')).to_be_visible()
    tool_view(page).locator('[data-context-category="all"]').click()
    tool_view(page).locator('#contextStatus').select_option('managed')
    expect(tool_view(page).locator('.context-row')).to_have_count(1)
    expect(toggle(page, 'managed-verb')).to_be_visible()
    tool_view(page).locator('#contextStatus').select_option('readOnly')
    expect(tool_view(page).locator('.context-row')).to_have_count(2)
    tool_view(page).locator('#contextStatus').select_option('all')
    tool_view(page).locator('#contextScope').select_option('system')
    tool_view(page).locator('#contextKind').select_option('extension')
    expect(tool_view(page).locator('.context-row')).to_have_count(1)
    tool_view(page).locator('#contextSearch').fill('compress.DLL')
    expect(toggle(page, 'extension-system')).to_be_visible()
    tool_view(page).locator('#contextSearch').fill('does not exist')
    expect(tool_view(page).locator('.context-row')).to_have_count(0)
    expect(tool_view(page).locator('.context-empty')).to_contain_text('没有符合条件')
    tool_view(page).locator('#contextSearch').fill('')
    tool_view(page).locator('#contextScope').select_option('all')
    tool_view(page).locator('#contextKind').select_option('all')
    assert call_count(page, SCAN) == 1, 'Local filters must not rescan the registry'

    tool_view(page).locator('#contextExtension').fill('..\\shell')
    tool_view(page).locator('#contextScan').click()
    expect(tool_view(page).locator('#contextNotice')).to_contain_text('有效扩展名')
    assert call_count(page, SCAN) == 1
    tool_view(page).locator('#contextExtension').fill(' PDF ')
    page.evaluate("window.__contextWarnings = ['部分注册位置拒绝访问 <img src=x onerror=alert(1)>']")
    tool_view(page).locator('#contextScan').click()
    wait_for_calls(page, SCAN, 2)
    expect(tool_view(page).locator('#contextExtension')).to_have_value('.pdf')
    assert page.evaluate("window.__contextCalls.filter(call => call.command === 'scan_context_menu_items').at(-1).args.extension") == '.pdf'
    expect(tool_view(page).locator('#contextResultCount')).to_contain_text('.pdf')
    tool_view(page).locator('#contextWarnings summary').click()
    expect(tool_view(page).locator('#contextWarnings')).to_contain_text('拒绝访问 <img src=x onerror=alert(1)>')
    assert tool_view(page).locator('.context-shell img,.context-shell svg,.context-shell script').count() == 0
    page.wait_for_timeout(1400)
    assert call_count(page, SCAN) == 2, 'Idle tools must not poll'
    page.screenshot(path=str(SCREENSHOTS / 'dtkit-context-menu-wide.png'), full_page=True)
    page.close()


def test_toggle_and_confirmation(browser, base_url, errors):
    page = open_panel(browser, base_url, errors)
    # Read-only rows cannot invoke writes, even synthetic clicks on disabled controls.
    for item_id in ['external-extension', 'protected-verb']:
        expect(toggle(page, item_id)).to_be_disabled()
        toggle(page, item_id).dispatch_event('click')
    assert call_count(page, SET_ENABLED) == 0

    toggle(page, 'verb-user').click()
    expect(toggle(page, 'verb-user')).to_have_attribute('aria-checked', 'false')
    expect(tool_view(page).locator('#contextDisabled')).to_have_text('3')
    args = page.evaluate("window.__contextCalls.find(call => call.command === 'set_context_menu_enabled').args")
    args.pop('instanceId', None)  # Host routing identity is separate from the tool command payload.
    assert args == {'id': 'verb-user', 'enabled': False, 'expectedFingerprint': 'revision-1', 'extension': None}
    tool_view(page).locator('#contextStatus').select_option('managed')
    expect(toggle(page, 'verb-user')).to_be_visible()
    toggle(page, 'verb-user').click()
    expect(toggle(page, 'verb-user')).to_have_count(0)
    tool_view(page).locator('#contextStatus').select_option('all')
    expect(toggle(page, 'verb-user')).to_have_attribute('aria-checked', 'true')

    toggle(page, 'extension-system').click()
    expect(tool_view(page).locator('.context-confirm')).to_contain_text('文件夹、文件夹空白处、桌面')
    expect(tool_view(page).locator('#contextCancel')).to_be_focused()
    assert call_count(page, SET_ENABLED) == 2
    tool_view(page).locator('#contextCancel').click()
    expect(tool_view(page).locator('.context-confirm')).to_have_count(0)
    expect(toggle(page, 'extension-system')).to_be_focused()
    assert call_count(page, SET_ENABLED) == 2
    toggle(page, 'extension-system').click()
    page.keyboard.press('Escape')
    expect(tool_view(page).locator('.context-confirm')).to_have_count(0)
    expect(toggle(page, 'extension-system')).to_be_focused()
    toggle(page, 'extension-system').click()
    tool_view(page).locator('#contextConfirm').click()
    expect(toggle(page, 'extension-system')).to_have_attribute('aria-checked', 'false')
    assert call_count(page, SET_ENABLED) == 3
    toggle(page, 'extension-system').click()
    expect(toggle(page, 'extension-system')).to_have_attribute('aria-checked', 'true')
    expect(tool_view(page).locator('.context-confirm')).to_have_count(0)
    assert call_count(page, SET_ENABLED) == 4
    page.close()


def test_failures_and_retry(browser, base_url, errors):
    page = open_panel(browser, base_url, errors, setup="window.__contextFailure.scan_context_menu_items = '读取注册信息失败';", ready=False)
    expect(tool_view(page).locator('#contextNotice')).to_contain_text('扫描失败')
    expect(tool_view(page).locator('.context-row')).to_have_count(0)
    expect(tool_view(page).locator('#contextScan')).to_be_enabled()
    page.evaluate("delete window.__contextFailure.scan_context_menu_items")
    tool_view(page).locator('#contextScan').click()
    expect(tool_view(page).locator('.context-row')).to_have_count(5)

    # An unsuccessful mutation is never optimistically shown as committed.
    page.evaluate("window.__contextFailure.set_context_menu_enabled = '权限不足'; window.__contextItems[0].name = '重新读取后的名称'")
    toggle(page, 'verb-user').click()
    expect(tool_view(page).locator('#contextNotice')).to_contain_text('更改未完成')
    expect(tool_view(page).locator('#contextNotice')).to_contain_text('当前实际状态')
    expect(item_row(page, 'verb-user').locator('h3')).to_have_text('重新读取后的名称')
    expect(toggle(page, 'verb-user')).to_have_attribute('aria-checked', 'true')
    expect(toggle(page, 'verb-user')).to_be_enabled()
    assert call_count(page, SCAN) == 3

    # Failure to refetch preserves the last list and locks writes until a successful rescan.
    page.evaluate("window.__contextFailure.scan_context_menu_items = '暂时不可读取'")
    toggle(page, 'verb-user').click()
    expect(tool_view(page).locator('#contextNotice')).to_contain_text('读取当前状态也失败')
    expect(tool_view(page).locator('.context-row')).to_have_count(5)
    expect(toggle(page, 'verb-user')).to_be_disabled()
    count = call_count(page, SET_ENABLED)
    toggle(page, 'verb-user').dispatch_event('click')
    assert call_count(page, SET_ENABLED) == count
    page.evaluate("window.__contextFailure = {}")
    tool_view(page).locator('#contextScan').click()
    expect(toggle(page, 'verb-user')).to_be_enabled()
    toggle(page, 'verb-user').click()
    expect(toggle(page, 'verb-user')).to_have_attribute('aria-checked', 'false')

    page.evaluate("window.__contextFailure.scan_context_menu_items = '再次读取失败'")
    tool_view(page).locator('#contextScan').click()
    expect(tool_view(page).locator('#contextNotice')).to_contain_text('保留上次列表')
    expect(toggle(page, 'verb-user')).to_be_disabled()
    expect(toggle(page, 'verb-user')).to_have_attribute('aria-checked', 'false')
    page.close()


def test_navigation_races(browser, base_url, errors):
    page = open_panel(browser, base_url, errors)
    page.evaluate("window.__holdContextMutations = true; window.__oldSnapshot = window.__contextSnapshot(null)")
    toggle(page, 'verb-user').click()
    expect(tool_view(page).locator('#contextList')).to_have_attribute('aria-busy', 'true')
    expect(tool_view(page).locator('#contextScan')).to_be_disabled()
    expect(toggle(page, 'managed-verb')).to_be_disabled()
    page.evaluate("window.__contextItems[0].name = '返回工具后的新名称'")
    reopen_panel(page)
    expect(item_row(page, 'verb-user').locator('h3')).to_have_text('返回工具后的新名称')
    page.evaluate("window.__pendingContextMutations.shift().resolve(window.__oldSnapshot)")
    expect(item_row(page, 'verb-user').locator('h3')).to_have_text('返回工具后的新名称')
    expect(tool_view(page).locator('#contextNotice')).to_contain_text('扫描完成')
    expect(tool_view(page).locator('#contextList')).to_have_attribute('aria-busy', 'false')

    # A scan from the previous mount must likewise not replace fresh results.
    page.evaluate("window.__holdContextScans = true")
    tool_view(page).locator('#contextScan').click()
    page.wait_for_function('window.__pendingContextScans.length === 1')
    page.evaluate("window.__holdContextScans = false; window.__contextItems[0].name = '第二次重新打开的新名称'")
    reopen_panel(page)
    expect(item_row(page, 'verb-user').locator('h3')).to_have_text('第二次重新打开的新名称')
    page.evaluate('window.__releaseContextScan()')
    expect(item_row(page, 'verb-user').locator('h3')).to_have_text('第二次重新打开的新名称')
    assert call_count(page, SCAN) == 4

    # A delayed clipboard failure after navigation must not replace the new panel's status.
    page.evaluate("() => { navigator.clipboard.writeText = () => new Promise((resolve,reject) => { window.__rejectContextCopy = reject; }); }")
    tool_view(page).locator('[data-context-details="verb-user"]').click()
    tool_view(page).locator('[data-context-copy="verb-user"]').click()
    page.wait_for_function('typeof window.__rejectContextCopy === "function"')
    reopen_panel(page)
    page.evaluate("window.__rejectContextCopy(new Error('复制被取消'))")
    expect(tool_view(page).locator('#contextNotice')).to_contain_text('扫描完成')
    expect(tool_view(page).locator('#contextNotice')).not_to_contain_text('复制失败')
    page.close()


def test_pagination_layout_and_preview(browser, base_url, errors):
    for width in [560, 420]:
        page = open_panel(browser, base_url, errors, quick=True, width=width, height=840)
        tool_view(page).locator('#quickContent').evaluate('element => { element.scrollTop = 0; }')
        page.screenshot(path=str(SCREENSHOTS / f'dtkit-context-menu-{width}-top.png'), full_page=True)
        toggle(page, 'extension-system').click()
        expect(tool_view(page).locator('#contextConfirm')).to_be_visible()
        assert tool_view(page).locator('.context-shell').evaluate('element => element.scrollWidth <= element.clientWidth + 1')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(SCREENSHOTS / f'dtkit-context-menu-{width}.png'), full_page=True)
        page.keyboard.press('Escape')
        expect(tool_view(page).locator('.context-confirm')).to_have_count(0)
        expect(toggle(page, 'extension-system')).to_be_focused()
        assert call_count(page, 'dismiss_quick_host') == 0, 'Canceling a confirmation must not also dismiss the quick window'
        page.evaluate("window.__contextItems = Array.from({length:165},(_,i) => window.__contextItem({id:`bulk-${i}`,name:`测试菜单 ${String(i).padStart(3,'0')}`}))")
        tool_view(page).locator('#contextScan').click()
        expect(tool_view(page).locator('.context-row')).to_have_count(80)
        expect(tool_view(page).locator('#contextTotal')).to_have_text('165')
        expect(tool_view(page).locator('#contextPage')).to_have_text('1 / 3')
        expect(tool_view(page).locator('#contextPrevious')).to_be_disabled()
        tool_view(page).locator('#contextNext').click()
        expect(tool_view(page).locator('#contextPage')).to_have_text('2 / 3')
        expect(toggle(page, 'bulk-80')).to_be_visible()
        tool_view(page).locator('#contextNext').click()
        expect(tool_view(page).locator('.context-row')).to_have_count(5)
        expect(tool_view(page).locator('#contextNext')).to_be_disabled()
        tool_view(page).locator('#contextSearch').fill('测试菜单 000')
        expect(tool_view(page).locator('.context-row')).to_have_count(1)
        expect(tool_view(page).locator('#contextPagination')).to_be_hidden()
        assert call_count(page, SCAN) == 2
        page.close()

    preview = open_panel(browser, base_url, errors, native=False, ready=False)
    expect(tool_view(preview).locator('#contextScan')).to_be_disabled()
    expect(tool_view(preview).locator('#contextExtension')).to_be_disabled()
    expect(tool_view(preview).locator('.context-empty')).to_contain_text('桌面版')
    preview.close()


def run_suite(browser, base_url, errors):
    test_scan_and_filters(browser, base_url, errors)
    test_toggle_and_confirmation(browser, base_url, errors)
    test_failures_and_retry(browser, base_url, errors)
    test_navigation_races(browser, base_url, errors)
    test_pagination_layout_and_preview(browser, base_url, errors)


handler = functools.partial(QuietHandler, directory=str(ROOT / "dist"))
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page_errors = []
            url = f"http://127.0.0.1:{server.server_port}"
            run_suite(browser, url, page_errors)
            assert page_errors == [], page_errors
            print("PASS: context menu scan/filter/extension validation, immutable read-only rows, toggle/restore, shared-extension confirmation, retry/refetch errors, navigation races, escaped content/copy, no idle scans, pagination and 560/420 px layout; registry untouched")
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
