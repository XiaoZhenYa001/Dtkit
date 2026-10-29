"""Read-only software analysis improvements against headless IPC fixtures.

Use a fresh production build. No native application or real software scan runs.
"""

import csv
import functools
import http.server
import importlib.util
import io
import json
import os
import tempfile
import threading
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = ROOT / 'tests' / 'artifacts' / 'software-analysis'
SPEC = importlib.util.spec_from_file_location('software_ui', ROOT / 'tests' / 'software-analysis-ui-smoke.py')
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)

EXTENDED_MOCK = r"""
window.__softwareHoldProgressListen = false;
window.__softwareDeferredListens = [];
const originalSoftwareListen = window.__TAURI__.event.listen;
window.__TAURI__.event.listen = async (name, callback) => {
    const unlisten = await originalSoftwareListen(name, callback);
    if (name === 'software-analysis-progress' && window.__softwareHoldProgressListen) {
        return new Promise(resolve => window.__softwareDeferredListens.push(() => resolve(unlisten)));
    }
    return unlisten;
};
window.__softwareReleaseListen = () => {
    const release = window.__softwareDeferredListens.shift();
    if (!release) throw new Error('No pending software progress listener');
    release();
};
const originalSoftwareReport = window.__softwareReport;
window.__softwareReport = (args, overrides = {}) => {
    const original = originalSoftwareReport(args);
    return {...original, totalBytes:1000, rootFilesBytes:80, fileTypesAvailable:true,
        largestDirectories:[400,200,150,80,40,30,20].map((bytes,index) =>
            ({path:original.root+'\\'+['data','bin','media','locales','docs','plugins','resources'][index],bytes})),
        largestFiles:[{path:original.root+'\\data\\archive.pak',bytes:300}],
        fileTypes:[{extension:'.dll',bytes:600,files:12},{extension:'.pak',bytes:300,files:10},
            {extension:'',bytes:100,files:5}], ...overrides};
};
"""

EXPORT_SETUP = r"""
window.__softwareFormula = '  =SUM(1,2)\r\n"Quoted"';
window.__softwareItems = Array.from({length:75}, (_,index) => window.__softwareItem({
    id:'export-'+index, name:index===2 ? window.__softwareFormula : 'Software '+String(index).padStart(2,'0'),
    publisher:index<72 ? 'Export Labs' : 'Excluded Labs', scope:'user',
    installLocation:'C:\\Bundle\\Software'+String(index).padStart(2,'0'),
    estimatedBytes:index===0 ? null : index===1 ? 0 : 4096
}));
"""


def open_panel(browser, base_url, errors, *, setup='', width=1360):
    return helper.open_panel(browser, base_url, errors, width=width, setup=EXTENDED_MOCK + '\n' + setup)


def row_ids(frame):
    return frame.locator('#softwareList [data-software-id]').evaluate_all(
        'nodes => nodes.map(node => node.dataset.softwareId)')


def release_report(page, frame, overrides=None):
    page.evaluate('overrides => window.__softwareRelease(overrides)', overrides or {})
    expect(frame.locator('#softwareScan')).to_be_enabled()
    expect(frame.locator('.software-report')).to_be_visible()


def download_bytes(page, button):
    with tempfile.TemporaryDirectory(prefix='dtkit-software-export-') as folder:
        with page.expect_download() as captured:
            button.click()
        download = captured.value
        path = Path(folder) / download.suggested_filename
        download.save_as(str(path))
        return download.suggested_filename, path.read_bytes()


def assert_distribution(frame, total):
    segments = frame.locator('[data-software-share]').evaluate_all("""nodes => nodes.map(node => ({
        bytes:Number(node.dataset.softwareShare), grow:Number(getComputedStyle(node).flexGrow),
        width:node.getBoundingClientRect().width
    }))""")
    assert sum(segment['bytes'] for segment in segments) == total
    assert abs(sum(segment['grow'] for segment in segments) - 1) < 0.0001
    assert all(segment['width'] > 0 for segment in segments)
    rendered = sum(segment['width'] for segment in segments)
    assert all(abs(segment['width'] / rendered - segment['bytes'] / total) < 0.02 for segment in segments), segments
    expect(frame.locator('.software-legend')).to_contain_text('根目录直属文件')
    expect(frame.locator('.software-legend')).to_contain_text('其他直属目录')


def test_combined_filters_and_reset(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors)
    try:
        frame.locator('#softwarePublisher').select_option('Example Labs')
        frame.locator('#softwareStatus').select_option('unknown-size')
        assert set(row_ids(frame)) == {'unknown', 'missing'}
        frame.locator('#softwareScope').select_option('user')
        frame.locator('#softwareSearch').fill('missing')
        expect(frame.locator('#softwareList [data-software-id]')).to_have_count(1)
        assert row_ids(frame) == ['missing']
        frame.locator('#softwareStatus').select_option('analyzable')
        expect(frame.locator('#softwareList [data-software-id]')).to_have_count(0)
        expect(frame.locator('#softwareExportInventory')).to_be_disabled()
        frame.locator('#softwareSort').select_option('date')
        frame.locator('#softwareResetFilters').click()
        for control, value in [('softwareSearch',''),('softwareScope','all'),('softwareSort','name'),
                               ('softwarePublisher',''),('softwareStatus','all')]:
            expect(frame.locator('#'+control)).to_have_value(value)
        expect(frame.locator('#softwareList [data-software-id]')).to_have_count(6)
        helper.begin_scan(page, frame, 'empty')
        release_report(page, frame, {'totalBytes':0,'rootFilesBytes':0,'files':0,
                                    'largestDirectories':[],'largestFiles':[],'fileTypes':[]})
        helper.begin_scan(page, frame, 'other')
        release_report(page, frame, {'complete':False,'cancelled':True,'skipped':1})
        frame.locator('#softwarePublisher').select_option('Example Labs')
        frame.locator('#softwareStatus').select_option('measured')
        assert row_ids(frame) == ['empty']
        frame.locator('#softwareStatus').select_option('partial')
        assert row_ids(frame) == ['other']
        frame.locator('#softwareStatus').select_option('unmeasured')
        assert set(row_ids(frame)) == {'editor','unknown','missing'}
        assert len(helper.calls(page, helper.LIST)) == 1
        assert len(helper.calls(page, helper.SCAN)) == 2, 'Filtering must not scan or refresh software'
    finally:
        page.close()


def test_export_all_filtered_pages(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors, setup=EXPORT_SETUP)
    try:
        frame.locator('#softwarePublisher').select_option('Export Labs')
        frame.locator('#softwareScope').select_option('user')
        frame.locator('#softwareStatus').select_option('unmeasured')
        frame.locator('#softwareSearch').fill('bundle')
        expect(frame.locator('#softwareResultCount')).to_contain_text('72 款')
        expect(frame.locator('#softwareList [data-software-id]')).to_have_count(60)
        frame.locator('#softwareNext').click()
        expect(frame.locator('#softwarePage')).to_have_text('2 / 2')
        expect(frame.locator('#softwareList [data-software-id]')).to_have_count(12)
        name, data = download_bytes(page, frame.locator('#softwareExportInventory'))
        assert name.endswith('.csv')
        assert data.startswith(b'\xef\xbb\xbf')
        rows = list(csv.DictReader(io.StringIO(data.decode('utf-8-sig'), newline='')))
        assert len(rows) == 72, f'CSV must include all matching pages, received {len(rows)} rows'
        assert all(row['发布者'] == 'Export Labs' for row in rows)
        by_name = {row['软件名称']:row for row in rows}
        assert by_name['Software 00']['登记大小（字节）'] == ''
        assert by_name['Software 01']['登记大小（字节）'] == '0'
        formula = page.evaluate('window.__softwareFormula')
        assert "'" + formula in by_name, 'Whitespace-prefixed formula must be neutralized and its CSV delimiters preserved'
        assert all(row['已统计逻辑大小（字节）'] == '' and row['扫描状态'] == '未扫描' for row in rows)
        expect(frame.locator('#softwareNotice')).to_contain_text('全部 72 项')
        assert not helper.calls(page, helper.SCAN)
    finally:
        page.close()


def test_partial_report_download_summary_and_distribution(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors)
    try:
        helper.begin_scan(page, frame)
        release_report(page, frame, {'complete':False,'cancelled':True,'skipped':2,
                                    'warnings':['目录拒绝访问：locked.dat']})
        expect(frame.locator('.software-report-status')).to_contain_text('已取消 · 部分结果')
        expect(frame.locator('.software-breakdown header')).to_contain_text('仅占已统计部分')
        expect(frame.locator('.software-quality-note')).to_contain_text('停止前已统计的数据')
        expect(frame.locator('.software-file-types')).to_contain_text('.dll')
        expect(frame.locator('.software-file-types')).to_contain_text('无扩展名')
        expect(frame.locator('.software-file-types')).to_contain_text('60.0%')
        assert_distribution(frame, 1000)
        name, data = download_bytes(page, frame.locator('#softwareExportReport'))
        assert name.endswith('.json')
        report = json.loads(data.decode('utf-8'))
        assert report['measurement'] == 'logical-file-bytes'
        assert report['report']['complete'] is False and report['report']['cancelled'] is True
        assert report['report']['skipped'] == 2 and report['report']['rootFilesBytes'] == 80
        assert report['report']['fileTypesAvailable'] is True
        assert sum(row['bytes'] for row in report['report']['fileTypes']) == 1000
        assert '逻辑大小不等于实际分配空间' in report['scopeNote']
        assert report['report']['warnings'] == ['目录拒绝访问：locked.dat']
        frame.locator('#softwareCopySummary').click()
        page.wait_for_function('window.__softwareClipboard.includes("结果不完整")')
        summary = page.evaluate('window.__softwareClipboard')
        assert '已取消（部分）' in summary
        assert '逻辑文件大小不等于磁盘实际分配空间' in summary
        assert '目录拒绝访问：locked.dat' in summary
        assert page.evaluate('window.__softwareXss') == 0
    finally:
        page.close()


def test_drill_children_return_and_cancel(browser, base_url, errors):
    page, frame = open_panel(browser, base_url, errors)
    try:
        helper.begin_scan(page, frame)
        release_report(page, frame)
        original_report = frame.locator('.software-report').inner_text()
        root_path = frame.locator('.software-path > p').inner_text()
        original_child = frame.locator('[data-software-drill]').first.get_attribute('data-software-drill')
        # A forged root or sibling path must not cross the report-child guard.
        for invalid in [root_path, root_path+'Extra\\outside']:
            frame.locator('[data-software-drill]').first.evaluate(
                '(node,path) => node.dataset.softwareDrill = path', invalid)
            frame.locator('[data-software-drill]').first.click()
            expect(frame.locator('#softwareNotice')).to_contain_text('不属于当前分析结果')
            assert len(helper.calls(page, helper.SCAN)) == 1
        frame.locator('[data-software-drill]').first.evaluate(
            '(node,path) => node.dataset.softwareDrill = path', original_child)
        frame.locator('[data-software-drill]').first.click()
        helper.wait_calls(page, helper.SCAN, 2)
        page.wait_for_function('window.__softwarePending.length === 1')
        child_call = helper.calls(page, helper.SCAN)[-1]['args']
        assert child_call['softwareId'] is None
        assert child_call['path'] == original_child
        expect(frame.locator('#softwareBack')).to_be_disabled()
        frame.locator('#softwareCancel').click()
        helper.wait_calls(page, helper.CANCEL, 1)
        assert helper.calls(page, helper.CANCEL)[-1]['args']['requestId'] == child_call['requestId']
        release_report(page, frame, {'totalBytes':25,'rootFilesBytes':25,'complete':False,'cancelled':True,
                                    'largestDirectories':[],'largestFiles':[],
                                    'fileTypes':[{'extension':'.log','bytes':25,'files':1}]})
        expect(frame.locator('.software-report-status')).to_contain_text('部分结果')
        frame.locator('#softwareBack').click()
        expect(frame.locator('.software-path > p')).to_have_text(root_path)
        expect(frame.locator('.software-report')).to_have_text(original_report, use_inner_text=True)
        expect(frame.locator('#softwareBack')).to_have_count(0)
        assert len(helper.calls(page, helper.SCAN)) == 2, 'Returning must reuse the original aggregate report'
    finally:
        page.close()


def test_drill_cancel_or_suspend_before_listener_does_not_start_scan(browser, base_url, errors):
    for action in ['cancel','suspend']:
        page, frame = open_panel(browser, base_url, errors)
        try:
            helper.begin_scan(page, frame)
            release_report(page, frame)
            original_report = frame.locator('.software-report').inner_text()
            page.evaluate('window.__softwareHoldProgressListen = true')
            frame.locator('[data-software-drill]').first.click()
            page.wait_for_function('window.__softwareDeferredListens.length === 1')
            assert len(helper.calls(page, helper.SCAN)) == 1
            if action == 'cancel':
                frame.locator('#softwareCancel').click()
            else:
                frame.evaluate("window.dispatchEvent(new CustomEvent('dtkit:power-state',{detail:{suspended:true}}))")
            page.evaluate('window.__softwareReleaseListen()')
            page.wait_for_function("(window.__softwareListeners['software-analysis-progress']?.size || 0) === 0")
            if action == 'suspend':
                frame.evaluate("window.dispatchEvent(new CustomEvent('dtkit:power-state',{detail:{suspended:false}}))")
            expect(frame.locator('#softwareScan')).to_be_enabled()
            expect(frame.locator('#softwareBack')).to_be_enabled()
            assert len(helper.calls(page, helper.SCAN)) == 1, f'{action} started a deferred child scan'
            assert not helper.calls(page, helper.CANCEL), 'A scan not sent to native needs no native cancellation'
            frame.locator('#softwareBack').click()
            expect(frame.locator('.software-report')).to_have_text(original_report, use_inner_text=True)
            assert len(helper.calls(page, helper.LIST)) == 1
        finally:
            page.close()


def test_light_dark_responsive_layout(browser, base_url, errors):
    backgrounds = {}
    setup = r"""
window.__softwareItems[0].name = 'Example Editor';
window.__softwareItems[2].installLocation = 'C:\\Apps\\Unknown';
"""
    for theme in ['light','dark']:
        for width in [1360,760,420]:
            page, frame = open_panel(browser, base_url, errors, width=width, setup=setup)
            try:
                page.set_viewport_size({'width':width,'height':900})
                page.emulate_media(color_scheme=theme)
                frame.evaluate('(theme) => {document.documentElement.dataset.theme=theme}', theme)
                helper.begin_scan(page, frame)
                release_report(page, frame, {'complete':False,'skipped':1})
                helper.assert_no_overflow(page, frame)
                for selector in ['.software-filters','.software-report-tools','.software-breakdown',
                                 '.software-legend','.software-file-types']:
                    assert frame.locator(selector).evaluate('node => node.scrollWidth <= node.clientWidth + 1'), (theme,width,selector)
                assert_distribution(frame, 1000)
                backgrounds[(theme,width)] = frame.locator('.software-detail').evaluate(
                    'node => getComputedStyle(node).backgroundColor')
                if theme == 'dark':
                    header_backgrounds = frame.locator('.software-shell header').evaluate_all(r"""nodes => nodes.map(node => {
                        const layers = [];
                        for (let current = node; current; current = current.parentElement) {
                            const rgba = getComputedStyle(current).backgroundColor.match(/[\d.]+/g)?.map(Number);
                            if (!rgba) continue;
                            layers.push([...rgba.slice(0,3),rgba[3] ?? 1]);
                            if ((rgba[3] ?? 1) === 1) break;
                        }
                        let rgb = [255,255,255];
                        for (const layer of layers.reverse()) rgb = rgb.map((value,index) =>
                            layer[index] * layer[3] + value * (1-layer[3]));
                        return {className:node.className, rgb};
                    })""")
                    assert all(max(header['rgb']) < 160 for header in header_backgrounds), header_backgrounds
                frame.evaluate("document.getElementById('quickContent').scrollTop = 0")
                expect(frame.locator('.software-heading h2')).to_be_in_viewport()
                workspace = f'workspace-{theme}.png' if width == 1360 else f'improvements-{theme}-{width}.png'
                page.screenshot(path=str(SCREENSHOTS / workspace), full_page=False, timeout=15000)
                if width == 1360:
                    frame.evaluate("""() => {
                        const container = document.getElementById('quickContent');
                        const chart = document.querySelector('.software-breakdown');
                        container.scrollTop += chart.getBoundingClientRect().top - container.getBoundingClientRect().top - 140;
                    }""")
                    expect(frame.locator('.software-breakdown')).to_be_in_viewport()
                    expect(frame.locator('.software-file-types')).to_be_in_viewport()
                    page.screenshot(path=str(SCREENSHOTS / f'report-{theme}.png'), full_page=False, timeout=15000)
            finally:
                page.close()
    for width in [1360,760,420]:
        assert backgrounds[('light',width)] != backgrounds[('dark',width)], 'Dark mode must change the panel surface'


def run(base_url):
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for test in [test_combined_filters_and_reset, test_export_all_filtered_pages,
                         test_partial_report_download_summary_and_distribution, test_drill_children_return_and_cancel,
                         test_drill_cancel_or_suspend_before_listener_does_not_start_scan,
                         test_light_dark_responsive_layout]:
                print('Software improvements: '+test.__name__, flush=True)
                test(browser, base_url, errors)
        except Exception:
            traceback.print_exc()
            for context_index, context in enumerate(browser.contexts):
                for page_index, page in enumerate(context.pages):
                    try:
                        page.screenshot(path=str(SCREENSHOTS / f'improvements-failure-{context_index}-{page_index}.png'),
                                        full_page=True, timeout=5000)
                    except Exception:
                        pass
            raise
        finally:
            browser.close()
    assert not errors, 'Runtime errors:\n'+'\n'.join(errors)
    print('PASS: combined filters/reset, complete filtered CSV, partial JSON/summary, proportional distribution, '
          'file types, guarded child analysis/return, cancel/suspend, light/dark at 1360/760/420', flush=True)


if __name__ == '__main__':
    external = os.environ.get('DTKIT_TEST_BASE_URL')
    if external:
        run(external.rstrip('/'))
    else:
        server = http.server.ThreadingHTTPServer(('127.0.0.1',0),
            functools.partial(helper.QuietHandler, directory=str(ROOT / 'dist')))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            run(f'http://127.0.0.1:{server.server_port}')
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
