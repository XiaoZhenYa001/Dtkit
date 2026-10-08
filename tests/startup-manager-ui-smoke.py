"""Startup manager UI against IPC mocks; never reads or edits real startup entries."""

import functools
import http.server
import os
import tempfile
import threading
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = Path(tempfile.gettempdir())
SCAN = 'scan_system_startup_items'
SET_ENABLED = 'set_system_startup_enabled'
REVEAL = 'reveal_system_startup_item'
SETTINGS = 'open_system_startup_settings'
MOCK = r"""
window.__startupCalls = [];
window.__startupFailure = {};
window.__holdStartupScans = false;
window.__holdStartupMutations = false;
window.__holdStartupReveals = false;
window.__pendingStartupScans = [];
window.__pendingStartupMutations = [];
window.__pendingStartupReveals = [];
window.__startupClipboard = '';
Object.defineProperty(navigator, 'clipboard', {configurable:true,value: {writeText: async text => { window.__startupClipboard = text; }}});
window.__startupItem = (overrides = {}) => ({
    id:'cloud', name:'Cloud Sync <img src=x onerror=alert(1)>',
    command:'"C:\\Apps\\Cloud.exe" --background <script>alert(1)</script>',
    targetPath:'C:\\Apps\\Cloud.exe', sourceKind:'registry',
    sourceLabel:'当前用户 · 注册表 Run',
    sourceDetail:'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    sourcePath:null, scope:'user', enabled:true, canToggle:true,
    requiresElevation:false, managed:false, disabledReason:null,
    fingerprint:'revision-1', canReveal:true, targetExists:true, canRevealSource:false,
    ...overrides
});
window.__startupItems = [
    window.__startupItem(),
    window.__startupItem({id:'workspace', name:'Workspace Helper', sourceKind:'startupFolder',
        command:'C:\\Users\\Demo\\Startup\\Workspace.lnk',
        targetPath:'C:\\Apps\\Workspace.exe',
        sourceLabel:'当前用户 · 启动文件夹', sourceDetail:'C:\\Users\\Demo\\Startup',
        sourcePath:'C:\\Users\\Demo\\Startup\\Workspace.lnk.dtkit-disabled', enabled:false, managed:true,
        canRevealSource:true, disabledReason:'由 DtKit 停用，可恢复'}),
    window.__startupItem({id:'system', name:'All-user Utility', scope:'system',
        sourceLabel:'所有用户 · 64 位 Run', sourceDetail:'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        command:'"C:\\Apps\\Utility.exe" --login', targetPath:'C:\\Apps\\Utility.exe',
        canToggle:false, requiresElevation:true, disabledReason:'需要管理员权限，仅可查看'}),
    window.__startupItem({id:'external', name:'Externally disabled', enabled:false, canToggle:false,
        disabledReason:'已在 Windows 启动应用中停用'}),
    window.__startupItem({id:'missing', name:'Missing program', command:'C:\\Removed\\missing.exe',
        targetPath:'C:\\Removed\\missing.exe', canReveal:false, targetExists:false})
];
window.__startupWarnings = [];
window.__startupSnapshot = () => ({
    items:structuredClone(window.__startupItems), total:window.__startupItems.length,
    enabled:window.__startupItems.filter(item => item.enabled).length,
    disabled:window.__startupItems.filter(item => !item.enabled).length,
    userItems:window.__startupItems.filter(item => item.scope === 'user').length,
    systemItems:window.__startupItems.filter(item => item.scope === 'system').length,
    managed:window.__startupItems.filter(item => item.managed && !item.enabled).length,
    readOnly:window.__startupItems.filter(item => !item.canToggle).length,
    scannedAt:Date.now(), warnings:structuredClone(window.__startupWarnings)
});
window.__startupFinishMutation = args => {
    if (window.__startupFailure.set_system_startup_enabled) throw window.__startupFailure.set_system_startup_enabled;
    const item = window.__startupItems.find(candidate => candidate.id === args.id);
    if (!item || !item.canToggle) throw '此启动项仅可查看';
    if (args.expectedFingerprint !== item.fingerprint) throw '启动项已变化，请重新扫描';
    item.enabled = args.enabled;
    item.managed = !args.enabled;
    item.disabledReason = args.enabled ? null : '由 DtKit 停用，可恢复';
    item.fingerprint += '-next';
    return window.__startupSnapshot();
};
window.__releaseStartupScan = () => {
    const pending = window.__pendingStartupScans.shift();
    if (!pending) throw new Error('No pending startup scan');
    if (window.__startupFailure.scan_system_startup_items) pending.reject(window.__startupFailure.scan_system_startup_items);
    else pending.resolve(pending.snapshot);
};
window.__releaseStartupMutation = () => {
    const pending = window.__pendingStartupMutations.shift();
    if (!pending) throw new Error('No pending startup mutation');
    try { pending.resolve(window.__startupFinishMutation(pending.args)); }
    catch (error) { pending.reject(error); }
};
window.__TAURI__ = {
    core:{invoke:async (command,args = {}) => {
        window.__startupCalls.push({command,args:structuredClone(args)});
        if ([ 'scan_system_startup_items', 'set_system_startup_enabled', 'reveal_system_startup_item', 'open_system_startup_settings' ].includes(command)) {
            if (!['startup-manager','system-assistant'].includes(args.toolId)) throw 'Missing tool authorization';
        }
        if (window.__startupFailure[command]) throw window.__startupFailure[command];
        if (command === 'scan_system_startup_items') {
            const snapshot = window.__startupSnapshot();
            if (window.__holdStartupScans) return new Promise((resolve,reject) => {
                window.__pendingStartupScans.push({resolve,reject,snapshot});
            });
            return snapshot;
        }
        if (command === 'set_system_startup_enabled') {
            if (window.__holdStartupMutations) return new Promise((resolve,reject) => {
                window.__pendingStartupMutations.push({resolve,reject,args:structuredClone(args)});
            });
            return window.__startupFinishMutation(args);
        }
        if (command === 'reveal_system_startup_item' && window.__holdStartupReveals) {
            return new Promise((resolve,reject) => window.__pendingStartupReveals.push({resolve,reject}));
        }
        if (['get_tool_module_settings','get_shortcut_bindings','take_missed_alarm_triggers'].includes(command)) return [];
        if (command === 'get_resource_policy') return {minimizeMode:'efficient'};
        return null;
    }},
    event:{listen:async () => () => {}},
    window:{getCurrentWindow:() => ({label:'main',startDragging:async () => {},isMaximized:async () => false})}
};
"""


def tool_view(page):
    """Tools in the main app live in an isolated page; quick/editor entries are direct."""
    if page.locator("#toolLibraryView").count():
        return page.frame_locator("iframe.tool-page-frame:not([hidden])")
    return page


def tool_payload(args):
    return {key:value for key,value in args.items() if key != 'instanceId'}


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def call_count(page, command):
    return page.evaluate("command => window.__startupCalls.filter(call => call.command === command).length", command)


def toggle(page, item_id):
    return tool_view(page).locator(f'[data-startup-toggle="{item_id}"]')


def row(page, item_id):
    return tool_view(page).locator(f'[data-startup-id="{item_id}"]')


def open_panel(browser, base_url, errors, *, tool_id='startup-manager', quick=False,
               width=1180, height=920, setup='', ready=True, native=True):
    page = browser.new_page(viewport={'width':width,'height':height})
    if native:
        page.add_init_script(MOCK + '\n' + setup)
    page.on('pageerror', lambda error: errors.append(str(error)))
    path = f'/quick.html?kind=tool&toolId={tool_id}' if quick else '/'
    page.goto(base_url + path, wait_until='networkidle')
    if not quick:
        page.locator(f'[data-tool-id="{tool_id}"] .tool-card__title').click()
    expect(tool_view(page).locator('.system-assistant-shell')).to_be_visible()
    if tool_id == 'system-assistant':
        if ready:
            expect(tool_view(page).locator('#systemOverviewTotal')).to_have_text('5')
        tool_view(page).locator('[data-open-system-module="startup"]').click()
    expect(tool_view(page).locator('#systemStartupPanel')).to_be_visible()
    if ready:
        expect(toggle(page, 'cloud')).to_be_visible()
    return page


def reopen_panel(page, tool_id='startup-manager'):
    page.locator('[data-view="toolLibrary"]').click()
    page.locator(f'[data-tool-id="{tool_id}"] .tool-card__title').click()
    expect(tool_view(page).locator('#systemStartupPanel')).to_be_visible()


def no_horizontal_overflow(page):
    assert tool_view(page).locator('.system-assistant-shell').evaluate('node => node.scrollWidth <= node.clientWidth + 1')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')


def actions_align_with_identity(page, item_id='cloud'):
    positions = row(page, item_id).evaluate('''node => {
        const outer = node.getBoundingClientRect();
        const identity = node.querySelector('.system-startup-identity').getBoundingClientRect();
        const actions = node.querySelector('.system-row-actions').getBoundingClientRect();
        return { identityTop: identity.top, identityBottom: identity.bottom,
            actionsTop: actions.top, actionsBottom: actions.bottom, rightGap: outer.right - actions.right };
    }''')
    assert positions['actionsTop'] <= positions['identityBottom'] and positions['actionsBottom'] >= positions['identityTop'], positions
    assert 0 <= positions['rightGap'] <= 24, positions


def test_scan_filters_and_reveal(browser, base_url, errors):
    page = open_panel(browser, base_url, errors)
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(5)
    for selector,text in [('#systemTotal','5'),('#systemEnabled','3'),('#systemDisabled','2'),('#systemReadOnly','2')]:
        expect(tool_view(page).locator(selector)).to_have_text(text)
    assert call_count(page, SCAN) == 1
    assert tool_payload(page.evaluate("window.__startupCalls.find(call => call.command === 'scan_system_startup_items').args")) == {'toolId':'startup-manager'}

    expect(row(page, 'cloud')).to_contain_text('<img src=x onerror=alert(1)>')
    tool_view(page).locator('[data-startup-details="cloud"]').click()
    expect(row(page, 'cloud')).to_contain_text('<script>alert(1)</script>')
    tool_view(page).locator('[data-startup-copy="cloud"]').click()
    page.wait_for_function("window.__startupClipboard.includes('<script>alert(1)</script>')")
    assert tool_view(page).locator('.system-assistant-shell img,.system-assistant-shell svg,.system-assistant-shell script').count() == 0

    tool_view(page).locator('#systemSourceFilter').select_option('startupFolder')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(1)
    expect(toggle(page, 'workspace')).to_be_visible()
    tool_view(page).locator('#systemSourceFilter').select_option('registry')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(4)
    tool_view(page).locator('#systemSourceFilter').select_option('all')
    tool_view(page).locator('#systemStatusFilter').select_option('managed')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(1)
    expect(toggle(page, 'workspace')).to_be_visible()
    tool_view(page).locator('#systemStatusFilter').select_option('readOnly')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(2)
    tool_view(page).locator('#systemStatusFilter').select_option('enabled')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(3)
    tool_view(page).locator('#systemScopeFilter').select_option('system')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(1)
    tool_view(page).locator('#systemScopeFilter').select_option('all')
    tool_view(page).locator('#systemStatusFilter').select_option('all')
    tool_view(page).locator('#systemStartupSearch').fill('workspace.LNK')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(1)
    tool_view(page).locator('#systemStartupSearch').fill('no-such-program')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(0)
    expect(tool_view(page).locator('#systemEmpty')).to_be_visible()
    tool_view(page).locator('#systemStartupSearch').fill('')
    assert call_count(page, SCAN) == 1, 'Local filters must not invoke native scans'

    expect(tool_view(page).locator('[data-startup-reveal="missing"]')).to_be_disabled()
    expect(tool_view(page).locator('[data-startup-source="cloud"]')).to_have_count(0)
    tool_view(page).locator('[data-startup-reveal="missing"]').dispatch_event('click')
    assert call_count(page, REVEAL) == 0
    tool_view(page).locator('[data-startup-reveal="cloud"]').click()
    expect(tool_view(page).locator('#systemStatus')).to_contain_text('定位')
    tool_view(page).locator('[data-startup-source="workspace"]').click()
    page.wait_for_function("window.__startupCalls.filter(call => call.command === 'reveal_system_startup_item').length === 2")
    assert [tool_payload(args) for args in page.evaluate("window.__startupCalls.filter(call => call.command === 'reveal_system_startup_item').map(call => call.args)")] == [
        {'id':'cloud','target':'program','toolId':'startup-manager'},
        {'id':'workspace','target':'source','toolId':'startup-manager'}]
    tool_view(page).locator('#systemStartupSettings').click()
    page.wait_for_function("window.__startupCalls.filter(call => call.command === 'open_system_startup_settings').length === 1")
    assert tool_payload(page.evaluate("window.__startupCalls.find(call => call.command === 'open_system_startup_settings').args")) == {'toolId':'startup-manager'}

    page.evaluate("window.__startupWarnings = ['注册表拒绝访问 <img src=x onerror=alert(1)>']")
    tool_view(page).locator('#systemRefresh').click()
    expect(tool_view(page).locator('#systemWarnings')).to_contain_text('拒绝访问 <img src=x onerror=alert(1)>')
    assert tool_view(page).locator('.system-assistant-shell img,.system-assistant-shell svg,.system-assistant-shell script').count() == 0
    page.wait_for_timeout(1400)
    assert call_count(page, SCAN) == 2, 'Idle startup manager must not poll'
    no_horizontal_overflow(page)
    actions_align_with_identity(page)
    page.screenshot(path=str(SCREENSHOTS / 'dtkit-startup-manager-wide.png'), full_page=True)
    page.close()


def test_toggle_ack_and_failures(browser, base_url, errors):
    page = open_panel(browser, base_url, errors)
    for item_id in ['system','external']:
        expect(toggle(page, item_id)).to_be_disabled()
        toggle(page, item_id).dispatch_event('click')
    assert call_count(page, SET_ENABLED) == 0
    expect(row(page, 'external')).to_contain_text('Windows 启动应用')
    page.evaluate('window.__holdStartupMutations = true')
    toggle(page, 'cloud').click()
    page.wait_for_function('window.__pendingStartupMutations.length === 1')
    expect(toggle(page, 'cloud')).to_have_attribute('aria-checked', 'true')
    expect(toggle(page, 'workspace')).to_be_disabled()
    expect(tool_view(page).locator('#systemRefresh')).to_be_disabled()
    assert tool_payload(page.evaluate("window.__startupCalls.find(call => call.command === 'set_system_startup_enabled').args")) == {
        'id':'cloud','enabled':False,'expectedFingerprint':'revision-1','toolId':'startup-manager'}
    page.evaluate('window.__releaseStartupMutation(); window.__holdStartupMutations = false')
    expect(toggle(page, 'cloud')).to_have_attribute('aria-checked', 'false')
    expect(tool_view(page).locator('#systemDisabled')).to_have_text('3')
    tool_view(page).locator('#systemStatusFilter').select_option('managed')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(2)
    toggle(page, 'cloud').click()
    expect(toggle(page, 'cloud')).to_have_count(0)
    tool_view(page).locator('#systemStatusFilter').select_option('all')
    expect(toggle(page, 'cloud')).to_have_attribute('aria-checked', 'true')
    assert page.evaluate("window.__startupCalls.filter(call => call.command === 'set_system_startup_enabled').at(-1).args.expectedFingerprint") == 'revision-1-next'

    # A partial write/error followed by a read must display the actual disabled state.
    page.evaluate("window.__startupFailure.set_system_startup_enabled = '恢复信息保存失败'; window.__startupItems[0].enabled = false; window.__startupItems[0].managed = true; window.__startupItems[0].name = '重新读取后的名称'")
    toggle(page, 'cloud').click()
    expect(tool_view(page).locator('#systemStatus')).to_contain_text('失败')
    expect(row(page, 'cloud')).to_contain_text('重新读取后的名称')
    expect(toggle(page, 'cloud')).to_have_attribute('aria-checked', 'false')
    expect(toggle(page, 'cloud')).to_be_enabled()
    assert call_count(page, SCAN) == 2

    page.evaluate("window.__startupFailure.scan_system_startup_items = '暂时不能读取'")
    toggle(page, 'cloud').click()
    expect(tool_view(page).locator('#systemStatus')).to_contain_text('失败')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(5)
    expect(toggle(page, 'cloud')).to_be_disabled()
    count = call_count(page, SET_ENABLED)
    toggle(page, 'cloud').dispatch_event('click')
    assert call_count(page, SET_ENABLED) == count
    page.evaluate('window.__startupFailure = {}')
    tool_view(page).locator('#systemRefresh').click()
    expect(toggle(page, 'cloud')).to_be_enabled()
    toggle(page, 'cloud').click()
    expect(toggle(page, 'cloud')).to_have_attribute('aria-checked', 'true')

    page.evaluate("window.__startupFailure.scan_system_startup_items = '再次读取失败'")
    tool_view(page).locator('#systemRefresh').click()
    expect(tool_view(page).locator('#systemStatus')).to_contain_text('失败')
    expect(tool_view(page).locator('.system-startup-row')).to_have_count(5)
    expect(toggle(page, 'cloud')).to_have_attribute('aria-checked', 'true')
    expect(toggle(page, 'cloud')).to_be_disabled()
    page.close()

    first_failure = open_panel(browser, base_url, errors, ready=False,
        setup="window.__startupFailure.scan_system_startup_items = '初次读取失败';")
    expect(tool_view(first_failure).locator('#systemStatus')).to_contain_text('扫描失败')
    expect(tool_view(first_failure).locator('.system-startup-row')).to_have_count(0)
    expect(tool_view(first_failure).locator('#systemRefresh')).to_be_enabled()
    first_failure.evaluate('window.__startupFailure = {}')
    tool_view(first_failure).locator('#systemRefresh').click()
    expect(tool_view(first_failure).locator('.system-startup-row')).to_have_count(5)
    first_failure.close()


def test_navigation_races(browser, base_url, errors):
    page = open_panel(browser, base_url, errors)
    page.evaluate('window.__holdStartupMutations = true; window.__oldStartupSnapshot = window.__startupSnapshot()')
    toggle(page, 'cloud').click()
    page.wait_for_function('window.__pendingStartupMutations.length === 1')
    page.evaluate("window.__startupItems[0].name = '重新打开后的名称'")
    reopen_panel(page)
    expect(row(page, 'cloud')).to_contain_text('重新打开后的名称')
    page.evaluate('window.__pendingStartupMutations.shift().resolve(window.__oldStartupSnapshot)')
    expect(row(page, 'cloud')).to_contain_text('重新打开后的名称')
    expect(toggle(page, 'cloud')).to_be_enabled()
    expect(tool_view(page).locator('#systemStatus')).to_contain_text('扫描完成')

    page.evaluate('window.__holdStartupScans = true')
    tool_view(page).locator('#systemRefresh').click()
    page.wait_for_function('window.__pendingStartupScans.length === 1')
    page.evaluate("window.__holdStartupScans = false; window.__startupItems[0].name = '第二次打开的新名称'")
    reopen_panel(page)
    expect(row(page, 'cloud')).to_contain_text('第二次打开的新名称')
    page.evaluate('window.__releaseStartupScan()')
    expect(row(page, 'cloud')).to_contain_text('第二次打开的新名称')
    assert call_count(page, SCAN) == 4

    page.evaluate('window.__holdStartupReveals = true')
    tool_view(page).locator('[data-startup-reveal="cloud"]').click()
    page.wait_for_function('window.__pendingStartupReveals.length === 1')
    reopen_panel(page)
    page.evaluate("window.__pendingStartupReveals.shift().reject('延迟定位失败')")
    expect(tool_view(page).locator('#systemStatus')).to_contain_text('扫描完成')
    expect(tool_view(page).locator('#systemStatus')).not_to_contain_text('延迟定位失败')

    page.evaluate("() => { navigator.clipboard.writeText = () => new Promise((resolve,reject) => { window.__rejectStartupCopy = reject; }); }")
    tool_view(page).locator('[data-startup-details="cloud"]').click()
    tool_view(page).locator('[data-startup-copy="cloud"]').click()
    page.wait_for_function('typeof window.__rejectStartupCopy === "function"')
    reopen_panel(page)
    page.evaluate("window.__rejectStartupCopy(new Error('延迟复制失败'))")
    expect(tool_view(page).locator('#systemStatus')).to_contain_text('扫描完成')
    expect(tool_view(page).locator('#systemStatus')).not_to_contain_text('延迟复制失败')
    page.close()


def test_compatibility_pagination_and_layout(browser, base_url, errors):
    legacy = open_panel(browser, base_url, errors, tool_id='system-assistant')
    expect(tool_view(legacy).locator('.system-startup-row')).to_have_count(5)
    assert legacy.evaluate("window.__startupCalls.find(call => call.command === 'scan_system_startup_items').args.toolId") == 'system-assistant'
    toggle(legacy, 'workspace').click()
    expect(toggle(legacy, 'workspace')).to_have_attribute('aria-checked', 'true')
    assert legacy.evaluate("window.__startupCalls.find(call => call.command === 'set_system_startup_enabled').args.toolId") == 'system-assistant'
    legacy.screenshot(path=str(SCREENSHOTS / 'dtkit-startup-system-assistant.png'), full_page=True)
    for width in [1024,760]:
        legacy.set_viewport_size({'width':width,'height':860})
        no_horizontal_overflow(legacy)
        actions_align_with_identity(legacy)
        tool_view(legacy).locator('[data-startup-details="cloud"]').click()
        no_horizontal_overflow(legacy)
        legacy.screenshot(path=str(SCREENSHOTS / f'dtkit-startup-system-assistant-{width}-details.png'), full_page=True)
        tool_view(legacy).locator('[data-startup-details="cloud"]').click()
    legacy.close()

    # The two entry points reuse a view but must keep independent lifecycles.
    interop = open_panel(browser, base_url, errors)
    interop.evaluate('window.__holdStartupScans = true')
    tool_view(interop).locator('#systemRefresh').click()
    interop.wait_for_function('window.__pendingStartupScans.length === 1')
    interop.evaluate("window.__holdStartupScans = false; window.__startupItems[0].name = '来自系统助手的新扫描'")
    interop.locator('[data-view="toolLibrary"]').click()
    interop.locator('[data-tool-id="system-assistant"] .tool-card__title').click()
    expect(tool_view(interop).locator('#systemOverviewTotal')).to_have_text('5')
    tool_view(interop).locator('[data-open-system-module="startup"]').click()
    expect(row(interop, 'cloud')).to_contain_text('来自系统助手的新扫描')
    interop.evaluate('window.__releaseStartupScan()')
    expect(row(interop, 'cloud')).to_contain_text('来自系统助手的新扫描')
    expect(toggle(interop, 'cloud')).to_be_enabled()
    toggle(interop, 'cloud').click()
    expect(toggle(interop, 'cloud')).to_have_attribute('aria-checked', 'false')
    assert interop.evaluate("window.__startupCalls.filter(call => call.command === 'set_system_startup_enabled').at(-1).args.toolId") == 'system-assistant'
    reopen_panel(interop)
    expect(toggle(interop, 'cloud')).to_have_attribute('aria-checked', 'false')
    assert interop.evaluate("window.__startupCalls.filter(call => call.command === 'scan_system_startup_items').at(-1).args.toolId") == 'startup-manager'
    interop.close()

    for width in [560,420]:
        page = open_panel(browser, base_url, errors, quick=True, width=width, height=840)
        no_horizontal_overflow(page)
        page.screenshot(path=str(SCREENSHOTS / f'dtkit-startup-manager-{width}.png'), full_page=True)
        tool_view(page).locator('[data-startup-details="cloud"]').click()
        no_horizontal_overflow(page)
        page.screenshot(path=str(SCREENSHOTS / f'dtkit-startup-manager-{width}-details.png'), full_page=True)
        page.evaluate("window.__startupItems = Array.from({length:165},(_,i) => window.__startupItem({id:`bulk-${i}`, name:`测试启动项 ${String(i).padStart(3,'0')}`}))")
        tool_view(page).locator('#systemRefresh').click()
        expect(tool_view(page).locator('.system-startup-row')).to_have_count(80)
        expect(tool_view(page).locator('#systemTotal')).to_have_text('165')
        expect(tool_view(page).locator('#systemPage')).to_have_text('1 / 3')
        expect(tool_view(page).locator('#systemPrevious')).to_be_disabled()
        tool_view(page).locator('#systemNext').click()
        expect(tool_view(page).locator('.system-startup-row')).to_have_count(80)
        expect(tool_view(page).locator('#systemPage')).to_have_text('2 / 3')
        tool_view(page).locator('#systemNext').click()
        expect(tool_view(page).locator('.system-startup-row')).to_have_count(5)
        expect(tool_view(page).locator('#systemPage')).to_have_text('3 / 3')
        expect(tool_view(page).locator('#systemNext')).to_be_disabled()
        tool_view(page).locator('#systemStartupSearch').fill('164')
        expect(tool_view(page).locator('.system-startup-row')).to_have_count(1)
        expect(toggle(page,'bulk-164')).to_be_visible()
        assert call_count(page, SCAN) == 2
        no_horizontal_overflow(page)
        page.close()

    preview = open_panel(browser, base_url, errors, native=False, ready=False)
    expect(tool_view(preview).locator('#systemRefresh')).to_be_disabled()
    expect(tool_view(preview).locator('.system-startup-row')).to_have_count(0)
    expect(tool_view(preview).locator('#systemStatus')).to_contain_text('桌面')
    preview.close()


def run(base_url):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            print('Startup UI: scan, filters and file locations', flush=True)
            test_scan_filters_and_reveal(browser, base_url, errors)
            print('Startup UI: acknowledged changes and failure recovery', flush=True)
            test_toggle_ack_and_failures(browser, base_url, errors)
            print('Startup UI: navigation and delayed replies', flush=True)
            test_navigation_races(browser, base_url, errors)
            print('Startup UI: legacy compatibility, pagination and responsive layout', flush=True)
            test_compatibility_pagination_and_layout(browser, base_url, errors)
        except Exception:
            traceback.print_exc()
            for index, page in enumerate(browser.contexts[0].pages if browser.contexts else []):
                try:
                    page.screenshot(path=str(SCREENSHOTS / f'dtkit-startup-failure-{index}.png'), full_page=True, timeout=5000)
                except Exception:
                    pass
            raise
        finally:
            browser.close()
    if errors:
        raise AssertionError('Runtime errors:\n' + '\n'.join(errors))
    print('Startup manager UI smoke passed: filters, reveal, recovery, races, legacy entry, pagination and narrow windows')
    print(f'Screenshots: {SCREENSHOTS / "dtkit-startup-manager-wide.png"}, {SCREENSHOTS / "dtkit-startup-manager-420.png"}')


if __name__ == '__main__':
    external_url = os.environ.get('DTKIT_TEST_BASE_URL')
    if external_url:
        run(external_url)
    else:
        server = http.server.ThreadingHTTPServer(('127.0.0.1',0), functools.partial(QuietHandler,directory=str(ROOT / 'dist')))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            run(f'http://127.0.0.1:{server.server_port}')
        finally:
            server.shutdown()
            server.server_close()
            worker.join()
