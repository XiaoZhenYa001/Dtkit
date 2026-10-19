"""Software analysis against IPC mocks; never scans or changes installed software.

Use a fresh production build. DTKIT_TEST_BASE_URL may point to an existing server.
"""

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
LIST = 'list_installed_software'
SCAN = 'analyze_software_space'
CANCEL = 'cancel_software_analysis'
PROGRESS = 'software-analysis-progress'
MOCK = r"""
(() => {
    window.__softwareCalls = [];
    window.__softwareListeners = {};
    window.__softwareListenAdded = {};
    window.__softwareListenRemoved = {};
    window.__softwarePending = [];
    window.__softwarePendingLists = [];
    window.__softwareHoldLists = false;
    window.__softwareStaleRemaining = 0;
    window.__softwareFailures = {};
    window.__softwareTimers = 0;
    window.__softwareAnimations = 0;
    window.__softwareXss = 0;
    window.__softwareClipboard = '';
    const timeout = window.setTimeout.bind(window), interval = window.setInterval.bind(window);
    const animation = window.requestAnimationFrame.bind(window);
    const instrument = callback => typeof callback === 'function' ? (...args) => {
        window.__softwareTimers++; return callback(...args);
    } : callback;
    window.setTimeout = (callback, delay, ...args) => timeout(instrument(callback), delay, ...args);
    window.setInterval = (callback, delay, ...args) => interval(instrument(callback), delay, ...args);
    window.requestAnimationFrame = callback => animation(now => { window.__softwareAnimations++; return callback(now); });
    Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => {window.__softwareClipboard = text;}}});
    window.__softwareItem = (overrides = {}) => ({
        id:'editor', name:'Example Editor <img src=x onerror=window.__softwareXss=1>',
        version:'2.0', publisher:'Example Labs', installLocation:'C:\\Apps\\Editor',
        estimatedBytes:1048576, installDate:'20261001', scope:'user', source:'HKCU · 64 位',
        canAnalyze:true, reason:null, ...overrides
    });
    window.__softwareItems = [
        window.__softwareItem(),
        window.__softwareItem({id:'empty', name:'Empty App', estimatedBytes:0, installLocation:'C:\\Apps\\Empty'}),
        window.__softwareItem({id:'unknown', name:'Unknown App', estimatedBytes:null,
            installLocation:'C:\\Apps\\<svg onload=window.__softwareXss=2>'}),
        window.__softwareItem({id:'missing', name:'Missing Location', estimatedBytes:null,
            installLocation:null, canAnalyze:false, reason:'未提供安装位置，请手动选择目录'}),
        window.__softwareItem({id:'system', name:'System Utility', scope:'system', publisher:'System Labs',
            installLocation:'D:\\Tools\\System', estimatedBytes:4194304}),
        window.__softwareItem({id:'other', name:'Other App', estimatedBytes:512, installLocation:'C:\\Apps\\Other'})
    ];
    window.__softwareReport = (args, overrides = {}) => ({
        requestId:args.requestId, softwareId:args.softwareId || null,
        root:args.path || window.__softwareItems.find(item => item.id === args.softwareId)?.installLocation || 'C:\\Apps\\Editor',
        totalBytes:8388608, files:27, directories:4, skipped:0, complete:true, cancelled:false,
        elapsedMs:1200, largestDirectories:[{path:'C:\\Apps\\Editor\\data',bytes:7340032}],
        largestFiles:[{path:'C:\\Apps\\Editor\\<img src=x onerror=window.__softwareXss=3>',bytes:1048576}],
        warnings:[], ...overrides
    });
    window.__softwareRelease = (overrides = {}, index = 0) => {
        const pending = window.__softwarePending.splice(index, 1)[0];
        if (!pending) throw new Error('No pending software scan');
        pending.resolve(window.__softwareReport(pending.args, overrides));
    };
    window.__softwareReleaseList = () => {
        const pending = window.__softwarePendingLists.shift();
        if (!pending) throw new Error('No pending software inventory refresh');
        pending.snapshot.items[0].name = 'Late stale refresh result';
        pending.resolve(pending.snapshot);
    };
    window.__softwareEmit = payload => {
        for (const callback of window.__softwareListeners['software-analysis-progress'] || []) callback({payload});
    };
    window.__TAURI__ = {
        core:{invoke:async (command, args = {}) => {
            window.__softwareCalls.push({command,args:structuredClone(args)});
            if (window.__softwareFailures[command]) throw window.__softwareFailures[command];
            if (command === 'list_installed_software') {
                const snapshot = {items:structuredClone(window.__softwareItems), scannedAt:Date.now(), warnings:[], cached:!args.refresh};
                if (window.__softwareHoldLists) return new Promise((resolve,reject) => {
                    window.__softwarePendingLists.push({resolve,reject,snapshot});
                });
                return snapshot;
            }
            if (command === 'analyze_software_space') {
                if (window.__softwareStaleRemaining > 0) {
                    window.__softwareStaleRemaining--;
                    throw '软件列表已过期，请刷新后重试';
                }
                return new Promise((resolve,reject) => {
                    window.__softwarePending.push({resolve,reject,args:structuredClone(args)});
                });
            }
            if (command === 'cancel_software_analysis') return true;
            if (command === 'scan_system_startup_items') return {items:[
                {id:'editor-startup',name:'Editor background task',targetPath:'c:\\apps\\EDITOR\\bin\\editor.exe',
                    command:'editor.exe --background',sourceKind:'registry',scope:'user',enabled:true},
                {id:'unrelated',name:'Boundary neighbor must stay excluded',targetPath:'C:\\Apps\\EditorExtra\\helper.exe',
                    command:'helper.exe',sourceKind:'registry',scope:'user',enabled:true}
            ],warnings:[]};
            if (['get_tool_module_settings','get_shortcut_bindings','take_missed_alarm_triggers'].includes(command)) return [];
            if (command === 'get_resource_policy') return {minimizeMode:'efficient',maxConcurrentJobs:2,quickHostRetentionSeconds:0};
            return null;
        }},
        event:{listen:async (name, callback) => {
            const listeners = window.__softwareListeners[name] ||= new Set();
            listeners.add(callback);
            window.__softwareListenAdded[name] = (window.__softwareListenAdded[name] || 0) + 1;
            return () => {
                if (listeners.delete(callback)) window.__softwareListenRemoved[name] = (window.__softwareListenRemoved[name] || 0) + 1;
            };
        }},
        window:{getCurrentWindow:() => ({label:'main',isMaximized:async () => false,startDragging:async () => {}})},
        dialog:{open:async () => 'D:\\Portable\\Example'}
    };
})();
"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def tool_frame(page):
    if not page.locator('#toolLibraryView').count():
        return page
    host = page.locator('iframe.tool-page-frame:not([hidden])')
    expect(host).to_have_count(1)
    return host.element_handle().content_frame()


def calls(page, command):
    return page.evaluate('command => window.__softwareCalls.filter(call => call.command === command)', command)


def wait_calls(page, command, number):
    page.wait_for_function('({command,number}) => window.__softwareCalls.filter(call => call.command === command).length === number',
                           arg={'command':command,'number':number})


def open_panel(browser, base_url, errors, *, quick=True, setup='', native=True, width=1180, new_tab=False):
    page = browser.new_page(viewport={'width':width,'height':920})
    if native:
        page.add_init_script(MOCK + '\n' + setup)
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url + ('/quick.html?kind=tool&toolId=software-analysis' if quick else '/'), wait_until='networkidle')
    if not quick:
        assert not calls(page, LIST), 'The unopened tool must not request a native inventory'
        if new_tab:
            page.locator('#addTabBtn').click()
        page.locator('[data-tool-id="software-analysis"] .tool-card__title').click()
    frame = tool_frame(page)
    expect(frame.locator('.software-shell')).to_be_visible()
    if native:
        expect(frame.locator('#softwareList [data-software-id]')).not_to_have_count(0)
    return page, frame


def select(frame, item_id):
    frame.locator(f'#softwareList [data-software-id="{item_id}"]').click()
    expect(frame.locator('#softwareDetail')).to_be_visible()


def begin_scan(page, frame, item_id='editor'):
    select(frame, item_id)
    previous = len(calls(page, SCAN))
    frame.locator('#softwareScan').click()
    wait_calls(page, SCAN, previous + 1)
    page.wait_for_function('window.__softwarePending.length > 0')
    return calls(page, SCAN)[-1]['args']['requestId']


def assert_no_overflow(page, frame):
    assert frame.locator('.software-shell').evaluate('node => node.scrollWidth <= node.clientWidth + 1')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')


def test_inventory_and_pagination(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors, quick=False)
    assert len(calls(page, LIST)) == 1
    assert not calls(page, SCAN)
    assert not calls(page, 'scan_system_startup_items'), 'Startup correlation must also be explicit'
    expect(frame.locator('#softwareList [data-software-id]')).to_have_count(6)
    select(frame, 'editor')
    expect(frame.locator('#softwareDetail')).to_contain_text('<img src=x onerror=window.__softwareXss=1>')
    select(frame, 'unknown')
    expect(frame.locator('#softwareDetail')).to_contain_text('<svg onload=window.__softwareXss=2>')
    select(frame, 'empty')
    expect(frame.locator('#softwareDetail')).to_contain_text('0 B')
    select(frame, 'unknown')
    expect(frame.locator('#softwareDetail')).to_contain_text('未提供')
    select(frame, 'missing')
    expect(frame.locator('#softwareScan')).to_be_disabled()
    assert frame.locator('.software-shell img,.software-shell svg,.software-shell script').count() == 0
    assert page.evaluate('window.__softwareXss') == 0

    frame.locator('#softwareSort').select_option('estimated')
    assert frame.locator('#softwareList [data-software-id]').first.get_attribute('data-software-id') == 'system'
    frame.locator('#softwareScope').select_option('system')
    expect(frame.locator('#softwareList [data-software-id]')).to_have_count(1)
    frame.locator('#softwareScope').select_option('all')
    frame.locator('#softwareSearch').fill('example 2.0')
    expect(frame.locator('#softwareList [data-software-id]')).to_have_count(5)
    assert len(calls(page, LIST)) == 1
    assert not calls(page, SCAN)
    frame.locator('#softwareSearch').fill('')

    page.evaluate("window.__softwareItems = Array.from({length:1500}, (_,index) => window.__softwareItem({id:`bulk-${index}`,name:`Application ${String(index).padStart(4,'0')}`}))")
    frame.locator('#softwareRefresh').click()
    expect(frame.locator('#softwareList [data-software-id]')).to_have_count(60)
    expect(frame.locator('#softwarePage')).to_contain_text('25')
    expect(frame.locator('#softwarePrevious')).to_be_disabled()
    frame.locator('#softwareNext').click()
    expect(frame.locator('#softwareList [data-software-id]')).to_have_count(60)
    frame.locator('#softwareSearch').fill('1499')
    expect(frame.locator('#softwareList [data-software-id]')).to_have_count(1)
    expect(frame.locator('#softwareList [data-software-id="bulk-1499"]')).to_be_visible()
    expect(frame.locator('#softwarePrevious')).to_be_disabled()
    assert len(calls(page, LIST)) == 2
    assert not calls(page, SCAN)
    print('Performance: 1,500 inventory entries -> 60 rendered rows; search/pagination caused 0 native rescans', flush=True)
    assert_no_overflow(page, frame)
    page.screenshot(path=str(SCREENSHOTS / 'dtkit-software-analysis-wide.png'), full_page=True)
    page.close()


def test_progress_results_and_cancellation(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors)
    request_id = begin_scan(page, frame)
    assert request_id
    expect(frame.locator('#softwareCancel')).to_be_visible()
    page.evaluate("requestId => window.__softwareEmit({requestId,files:1234,directories:8,totalBytes:2097152,skipped:0,elapsedMs:500})", 'unrelated-request')
    expect(frame.locator('#softwareProgress')).not_to_contain_text('1,234')
    page.evaluate("requestId => window.__softwareEmit({requestId,files:1234,directories:8,totalBytes:2097152,skipped:0,elapsedMs:500})", request_id)
    expect(frame.locator('#softwareProgress')).to_contain_text('1,234')
    frame.evaluate("""() => {
        window.__softwareRowMutations = 0;
        window.__softwareRowObserver = new MutationObserver(records => { window.__softwareRowMutations += records.length; });
        window.__softwareRowObserver.observe(document.getElementById('softwareList'), {childList:true,subtree:true});
    }""")
    page.evaluate("""requestId => {
        for (let files = 1235; files < 2235; files++) window.__softwareEmit({requestId,files,directories:8,totalBytes:2097152,elapsedMs:500});
    }""", request_id)
    expect(frame.locator('#softwareProgress')).to_contain_text('2,234')
    assert frame.evaluate('window.__softwareRowMutations') == 0, 'Progress events rebuilt the inventory DOM'
    frame.evaluate('window.__softwareRowObserver.disconnect()')
    page.evaluate('window.__softwareRelease()')
    expect(frame.locator('#softwareDetail')).to_contain_text('8 MB')
    expect(frame.locator('#softwareDetail')).to_contain_text('<img src=x onerror=window.__softwareXss=3>')
    expect(frame.locator('#softwareScan')).to_be_enabled()
    assert page.evaluate("window.__softwareListeners['software-analysis-progress']?.size || 0") == 0
    assert frame.locator('.software-shell img,.software-shell svg,.software-shell script').count() == 0
    frame.locator('.software-path [data-software-copy]').click()
    page.wait_for_function("window.__softwareClipboard === 'C:\\\\Apps\\\\Editor'")
    frame.locator('.software-path [data-software-reveal]').click()
    wait_calls(page, 'reveal_software_location', 1)
    assert calls(page, 'reveal_software_location')[-1]['args']['path'] == 'C:\\Apps\\Editor'
    frame.locator('#softwareSort').select_option('measured')
    assert frame.locator('#softwareList [data-software-id]').first.get_attribute('data-software-id') == 'editor'

    request_id = begin_scan(page, frame, 'other')
    frame.locator('#softwareCancel').click()
    wait_calls(page, CANCEL, 1)
    assert calls(page, CANCEL)[-1]['args']['requestId'] == request_id
    page.evaluate("window.__softwareRelease({totalBytes:2048,files:3,complete:false,cancelled:true,warnings:['扫描由用户取消']})")
    expect(frame.locator('#softwareDetail')).to_contain_text('2 KB')
    expect(frame.locator('#softwareDetail')).to_contain_text('取消')
    expect(frame.locator('#softwareScan')).to_be_enabled()

    begin_scan(page, frame, 'empty')
    page.evaluate("window.__softwareRelease({totalBytes:0,files:0,skipped:1,complete:false,warnings:['目录拒绝访问']})")
    expect(frame.locator('#softwareDetail')).to_contain_text('目录拒绝访问')
    expect(frame.locator('#softwareDetail')).to_contain_text('0 B')
    begin_scan(page, frame, 'system')
    page.evaluate("window.__softwarePending.shift().reject('读取失败 <svg onload=window.__softwareXss=4>')")
    expect(frame.locator('#softwareNotice')).to_contain_text('读取失败 <svg onload=window.__softwareXss=4>')
    expect(frame.locator('#softwareScan')).to_be_enabled()
    assert page.evaluate("window.__softwareListeners['software-analysis-progress']?.size || 0") == 0
    assert page.evaluate('window.__softwareXss') == 0
    # A failed refresh keeps usable inventory and can be retried.
    page.evaluate("window.__softwareFailures.list_installed_software = '读取软件列表失败'")
    frame.locator('#softwareRefresh').click()
    expect(frame.locator('#softwareNotice')).to_contain_text('失败')
    expect(frame.locator('#softwareList [data-software-id]')).to_have_count(6)
    page.evaluate('window.__softwareFailures = {}')
    frame.locator('#softwareRefresh').click()
    expect(frame.locator('#softwareRefresh')).to_be_enabled()
    page.close()


def test_startup_association_and_folder(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors)
    select(frame, 'editor')
    frame.locator('#softwareStartupScan').click()
    wait_calls(page, 'scan_system_startup_items', 1)
    expect(frame.locator('#softwareDetail')).to_contain_text('Editor background task')
    expect(frame.locator('#softwareDetail')).not_to_contain_text('Boundary neighbor must stay excluded')
    assert calls(page, 'scan_system_startup_items')[-1]['args']['toolId'] == 'startup-manager'
    frame.locator('#softwareStartupOpen').click()
    wait_calls(page, 'open_quick_host', 1)
    assert calls(page, 'open_quick_host')[-1]['args']['target'] == {'kind':'tool','toolId':'startup-manager'}
    frame.locator('#softwareChooseFolder').click()
    expect(frame.locator('#softwareDetail')).to_contain_text('Portable')
    assert not calls(page, SCAN), 'Choosing a directory must still wait for an explicit scan'
    frame.locator('#softwareScan').click()
    wait_calls(page, SCAN, 1)
    assert calls(page, SCAN)[-1]['args']['path'] == 'D:\\Portable\\Example'
    page.evaluate("window.__softwareRelease({root:'D:\\\\Portable\\\\Example'})")
    expect(frame.locator('#softwareDetail')).to_contain_text('Portable')
    page.close()


def test_hidden_close_and_idle(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors, quick=False, new_tab=True)
    request_id = begin_scan(page, frame)
    instance_id = page.locator('iframe.tool-page-frame:not([hidden])').get_attribute('data-instance-id')
    tab_id = page.locator('.tab--active').get_attribute('data-tab-id')
    page.locator('[data-view="toolLibrary"]').click()
    wait_calls(page, CANCEL, 1)
    assert calls(page, CANCEL)[-1]['args']['requestId'] == request_id
    page.evaluate("window.__softwareRelease({totalBytes:999999999,warnings:['late hidden report']})")
    page.locator('#backBtn').click()
    expect(frame.locator('.software-shell')).to_be_visible()
    expect(frame.locator('#softwareDetail')).not_to_contain_text('late hidden report')
    expect(frame.locator('#softwareScan')).to_be_enabled()
    for _ in range(3):
        page.locator('[data-view="toolLibrary"]').click()
        page.locator('#backBtn').click()
        expect(frame.locator('.software-shell')).to_be_visible()
    assert len(calls(page, LIST)) == 1, 'Showing the retained page must reuse its inventory'
    assert page.evaluate("window.__softwareListeners['software-analysis-progress']?.size || 0") <= 1

    request_id = begin_scan(page, frame)
    page.locator(f'.tab[data-tab-id="{tab_id}"] .tab__close').click()
    wait_calls(page, CANCEL, 2)
    assert calls(page, CANCEL)[-1]['args']['requestId'] == request_id
    page.evaluate("window.__softwareRelease({warnings:['late closed report']})")
    expect(page.locator(f'iframe[data-instance-id="{instance_id}"]')).to_have_count(0)
    page.wait_for_function("(window.__softwareListeners['software-analysis-progress']?.size || 0) === 0")
    page.close()

    quick, view = open_panel(browser, base_url, errors)
    quick.wait_for_timeout(250)
    settled = quick.evaluate('[window.__softwareTimers,window.__softwareAnimations,window.__softwareCalls.length]')
    quick.wait_for_timeout(650)
    assert quick.evaluate('[window.__softwareTimers,window.__softwareAnimations,window.__softwareCalls.length]') == settled, 'Idle tool kept polling IPC or scheduling work'
    print('Performance: settled standalone tool -> 0 timer callbacks, 0 animation callbacks, 0 IPC over 650 ms', flush=True)
    quick.close()


def test_stale_inventory_retry(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors)
    page.evaluate("window.__softwareStaleRemaining = 1; window.__softwareItems[0].installLocation = 'D:\\\\Refreshed\\\\Editor'")
    select(frame, 'editor')
    frame.locator('#softwareScan').click()
    wait_calls(page, SCAN, 2)
    page.wait_for_function('window.__softwarePending.length === 1')
    assert len(calls(page, LIST)) == 2, 'An expired inventory should trigger exactly one automatic refresh'
    assert len(calls(page, SCAN)) == 2
    for call in calls(page, SCAN):
        assert call['args']['softwareId'] == 'editor'
        assert call['args'].get('path') is None, 'Retry must resolve the software ID instead of reusing an old directory'
    page.evaluate('window.__softwareRelease()')
    expect(frame.locator('#softwareDetail')).to_contain_text('8 MB')
    expect(frame.locator('.software-path')).to_contain_text('D:\\Refreshed\\Editor')
    expect(frame.locator('#softwareScan')).to_be_enabled()
    assert len(calls(page, LIST)) == 2
    assert len(calls(page, SCAN)) == 2
    page.close()

    for action in ['cancel', 'hide', 'close']:
        page, frame = open_panel(browser, base_url, errors, quick=action == 'cancel', new_tab=action != 'cancel')
        page.evaluate('window.__softwareStaleRemaining = 1; window.__softwareHoldLists = true')
        select(frame, 'editor')
        frame.locator('#softwareScan').click()
        wait_calls(page, SCAN, 1)
        wait_calls(page, LIST, 2)
        page.wait_for_function('window.__softwarePendingLists.length === 1')
        instance_id = None
        if action == 'cancel':
            frame.locator('#softwareCancel').click()
        elif action == 'hide':
            page.locator('[data-view="toolLibrary"]').click()
            expect(page.locator('iframe.tool-page-frame:not([hidden])')).to_have_count(0)
        else:
            instance_id = page.locator('iframe.tool-page-frame:not([hidden])').get_attribute('data-instance-id')
            tab_id = page.locator('.tab--active').get_attribute('data-tab-id')
            page.locator(f'.tab[data-tab-id="{tab_id}"] .tab__close').click()
        page.evaluate('window.__softwareReleaseList()')
        if action == 'close':
            expect(page.locator(f'iframe[data-instance-id="{instance_id}"]')).to_have_count(0)
        else:
            if action == 'hide':
                page.locator('#backBtn').click()
            expect(frame.locator('#softwareScan')).to_be_enabled()
            expect(frame.locator('#softwareList')).not_to_contain_text('Late stale refresh result')
            expect(frame.locator('#softwareDetail')).not_to_contain_text('Late stale refresh result')
        page.wait_for_function("(window.__softwareListeners['software-analysis-progress']?.size || 0) === 0")
        assert len(calls(page, SCAN)) == 1, f'{action} during the inventory refresh started an unwanted retry'
        assert len(calls(page, LIST)) == 2, f'{action} during the inventory refresh repeated the refresh'
        page.close()


def test_preview_and_narrow_layout(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors, native=False, width=420)
    expect(frame.locator('#softwareRefresh')).to_be_disabled()
    expect(frame.locator('#softwareChooseFolder')).to_be_disabled()
    expect(frame.locator('#softwareList [data-software-id]')).to_have_count(0)
    expect(frame.locator('#softwareNotice')).to_contain_text('桌面')
    assert_no_overflow(page, frame)
    page.close()
    page, frame = open_panel(browser, base_url, errors, width=420)
    begin_scan(page, frame)
    page.evaluate('window.__softwareRelease()')
    expect(frame.locator('#softwareDetail')).to_contain_text('8 MB')
    assert_no_overflow(page, frame)
    page.screenshot(path=str(SCREENSHOTS / 'dtkit-software-analysis-420.png'), full_page=True)
    page.close()


def run(base_url):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for test in [test_inventory_and_pagination, test_progress_results_and_cancellation,
                         test_startup_association_and_folder, test_hidden_close_and_idle,
                         test_stale_inventory_retry, test_preview_and_narrow_layout]:
                print(f'Software UI: {test.__name__}', flush=True)
                test(browser, base_url, errors)
        except Exception:
            traceback.print_exc()
            for index, context in enumerate(browser.contexts):
                for page_index, page in enumerate(context.pages):
                    try:
                        page.screenshot(path=str(SCREENSHOTS / f'dtkit-software-failure-{index}-{page_index}.png'), full_page=True, timeout=5000)
                    except Exception:
                        pass
            raise
        finally:
            browser.close()
    assert not errors, 'Runtime errors:\n' + '\n'.join(errors)
    print('Software analysis UI smoke passed: lazy inventory, bounded DOM, progress, cancellation, lifecycle, stale inventory retry, startup links, folder scan, fallback, XSS and narrow layout')


if __name__ == '__main__':
    configured = os.environ.get('DTKIT_TEST_BASE_URL')
    if configured:
        run(configured.rstrip('/'))
    else:
        server = http.server.ThreadingHTTPServer(('127.0.0.1',0), functools.partial(QuietHandler,directory=str(ROOT / 'dist')))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            run(f'http://127.0.0.1:{server.server_port}')
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
