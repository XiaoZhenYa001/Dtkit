"""Exercise startup-manager improvements with fixtures only; no real startup writes."""

import csv
import functools
import http.server
import importlib.util
import io
import os
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('startup_ui', ROOT / 'tests' / 'startup-manager-ui-smoke.py')
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)

EXTENDED_MOCK = r"""
window.__startupRecoveryState = 'ready';
window.__startupRecoveryFingerprint = 'store-revision-1';
window.__startupDialogResults = [];
window.__startupDialogCalls = [];
const originalStartupSnapshot = window.__startupSnapshot;
window.__startupSnapshot = () => ({...originalStartupSnapshot(),
    recoveryState:window.__startupRecoveryState,
    recoveryFingerprint:window.__startupRecoveryFingerprint,
    recoveryMessage:window.__startupRecoveryState === 'legacy' ? '旧恢复记录需要绑定当前电脑和账户' : ''
});
window.__TAURI__.dialog = {open:async options => {
    window.__startupDialogCalls.push(structuredClone(options));
    return window.__startupDialogResults.shift() ?? null;
}};
const originalStartupInvoke = window.__TAURI__.core.invoke;
window.__TAURI__.core.invoke = async (command,args={}) => {
    if (!['add_system_startup_item','forget_system_startup_backup',
        'adopt_system_startup_backups','create_system_startup_recovery','open_system_startup_folder'].includes(command)) {
        return originalStartupInvoke(command,args);
    }
    window.__startupCalls.push({command,args:structuredClone(args)});
    if (!['startup-manager','system-assistant'].includes(args.toolId)) throw 'Missing tool authorization';
    if (window.__startupFailure[command]) throw window.__startupFailure[command];
    if (command === 'add_system_startup_item') {
        window.__startupItems.push(window.__startupItem({id:'added',name:args.name,
            command:args.path+' '+args.arguments,targetPath:args.path,sourceKind:'startupFolder',
            sourceLabel:'当前用户 · 启动文件夹',sourceDetail:'C:\\Fixture\\Startup',
            sourcePath:'C:\\Fixture\\Startup\\'+args.name+'.lnk',canRevealSource:true}));
    }
    if (command === 'forget_system_startup_backup') {
        const item=window.__startupItems.find(candidate=>candidate.id===args.id);
        if (!item || args.expectedFingerprint!==item.fingerprint) throw '恢复记录已变化';
        item.canForgetBackup=false;item.backupConflict=false;item.backupDisabledAt=null;
        item.fingerprint+='-forgotten';
    }
    if (['adopt_system_startup_backups','create_system_startup_recovery'].includes(command)) {
        if (args.expectedStoreFingerprint!==window.__startupRecoveryFingerprint) throw '恢复文件已变化';
        window.__startupRecoveryState='ready';window.__startupRecoveryFingerprint='store-revision-2';
    }
    if (command === 'create_system_startup_recovery') {
        window.__startupItems=window.__startupItems.map(item=>({...item,managed:false,
            canForgetBackup:false,backupConflict:false,backupDisabledAt:null}));
    }
    return command==='open_system_startup_folder' ? null : window.__startupSnapshot();
};
"""

CONFLICT_SETUP = r"""
window.__startupItems.find(item=>item.id==='workspace').backupDisabledAt=Date.UTC(2026,9,20);
window.__startupItems.push(window.__startupItem({id:'conflict',name:'Conflict entry',
    command:'C:\\Apps\\Replacement.exe --new',fingerprint:'conflict-revision-1',
    sourceKind:'startupFolder',sourceLabel:'当前用户 · 启动文件夹',
    sourceDetail:'C:\\Fixture\\Startup',sourcePath:'C:\\Fixture\\Startup\\Conflict.lnk',
    backupPath:'C:\\Fixture\\DtKitDisabledStartup\\Conflict.lnk',canRevealBackup:true,
    canToggle:false,canForgetBackup:true,backupConflict:true,
    backupDisabledAt:Date.UTC(2026,9,21),disabledReason:'当前配置和旧恢复记录不同'}));
"""

GROUP_SETUP = r"""
window.__longGroupName='超级软件套件 <img src=x onerror="window.__groupInjected=1"> & '+
    '很长的软件名称'.repeat(10)+'LongProductNameWithoutBreaks'.repeat(5);
window.__startupItems = [
    window.__startupItem({id:'cloud',name:'Aurora tray',groupId:'installed-aurora',
        groupName:'北辰云端套件',groupReason:'registered',targetPath:'C:\\Aurora\\tray.exe'}),
    window.__startupItem({id:'aurora-link',name:'Launcher shortcut',groupId:'installed-aurora',
        groupName:'北辰云端套件',groupReason:'registered',sourceKind:'startupFolder',
        sourceLabel:'当前用户 · 启动文件夹',sourcePath:'C:\\Fixture\\Startup\\Aurora.lnk',
        targetPath:'C:\\Aurora\\launcher.exe',enabled:false,managed:true,canRevealSource:true}),
    window.__startupItem({id:'aurora-system',name:'Service companion',groupId:'installed-aurora',
        groupName:'北辰云端套件',groupReason:'registered',scope:'system',canToggle:false,
        requiresElevation:true,disabledReason:'系统级入口仅可查看',targetPath:'C:\\Aurora\\companion.exe'}),
    window.__startupItem({id:'same-a',name:'Duplicate display A',groupId:'installation-a',
        groupName:window.__longGroupName,groupReason:'registered',targetPath:'C:\\SeparateA\\app.exe'}),
    window.__startupItem({id:'same-b',name:'Duplicate display B',groupId:'installation-b',
        groupName:window.__longGroupName,groupReason:'registered',targetPath:'D:\\SeparateB\\app.exe'}),
    window.__startupItem({id:'local-reg',name:'Local helper registry',groupId:'executable-local',
        groupName:'Local utility',groupReason:'sameExecutable',targetPath:'C:\\Local\\helper.exe'}),
    window.__startupItem({id:'local-link',name:'Local helper shortcut',groupId:'executable-local',
        groupName:'Local utility',groupReason:'sameExecutable',targetPath:'C:\\Local\\helper.exe',
        sourceKind:'startupFolder',sourceLabel:'当前用户 · 启动文件夹',sourcePath:'C:\\Fixture\\Startup\\Local.lnk'}),
    window.__startupItem({id:'unknown-a',name:'Unconfirmed helper'}),
    window.__startupItem({id:'unknown-b',name:'Unconfirmed helper'})
];
"""


def open_panel(browser, base_url, errors, *, setup='', ready=True):
    return helper.open_panel(browser, base_url, errors, setup=EXTENDED_MOCK + '\n' + setup, ready=ready)


def view(page):
    return helper.tool_view(page)


def ids(page):
    return view(page).locator('.system-startup-row').evaluate_all('nodes=>nodes.map(node=>node.dataset.startupId)')


def command_args(page, command):
    return [helper.tool_payload(args) for args in page.evaluate(
        'command=>window.__startupCalls.filter(call=>call.command===command).map(call=>call.args)', command)]


def software_group(page, identifier):
    return view(page).locator(f'section[data-system-group="{identifier}"]')


def test_software_groups_and_independent_controls(browser, base_url, errors):
    page = open_panel(browser, base_url, errors, setup=GROUP_SETUP)
    try:
        expect(view(page).locator('#systemGroupMode')).to_have_value('software')
        expect(view(page).locator('section[data-system-group]')).to_have_count(6)
        expect(view(page).locator('.system-startup-row')).to_have_count(9)
        aurora = software_group(page, 'installed-aurora')
        assert aurora.locator('[data-startup-id]').evaluate_all(
            'nodes=>nodes.map(node=>node.dataset.startupId).sort()') == ['aurora-link','aurora-system','cloud']
        expect(aurora.locator('.system-group-heading h4')).to_have_text('北辰云端套件')
        expect(aurora.locator('.system-group-count')).to_have_text('3 项 · 2 已启用 · 1 已关闭')
        expect(aurora.locator('.system-group-heading')).to_contain_text('按已登记的安装目录归组')
        expect(software_group(page, 'executable-local').locator('.system-group-heading')).to_contain_text('按同一程序文件归组')
        for identifier, member in [('installation-a','same-a'),('installation-b','same-b')]:
            section = software_group(page, identifier)
            expect(section.locator('[data-startup-id]')).to_have_count(1)
            expect(section.locator(f'[data-startup-id="{member}"]')).to_be_visible()
        long_name = page.evaluate('window.__longGroupName')
        expect(view(page).locator('.system-group-heading h4').filter(has_text=long_name)).to_have_count(2)
        assert view(page).locator('#systemStartupList img,#systemStartupList script').count() == 0
        assert page.evaluate('window.__groupInjected') is None
        # Entries without native grouping metadata remain separate even when
        # their names and inherited executable paths are identical.
        unknown_groups = view(page).locator('section[data-system-group]').filter(
            has=view(page).locator('[data-startup-id^="unknown-"]'))
        expect(unknown_groups).to_have_count(2)
        assert unknown_groups.locator('.system-group-heading').count() == 0
        expect(helper.toggle(page, 'aurora-system')).to_be_disabled()
        assert aurora.locator('.system-group-heading [data-startup-toggle]').count() == 0
        page.screenshot(path=str(helper.SCREENSHOTS / 'dtkit-startup-software-groups-wide.png'), full_page=True)

        helper.toggle(page, 'cloud').click()
        expect(helper.toggle(page, 'cloud')).to_have_attribute('aria-checked', 'false')
        expect(helper.toggle(page, 'aurora-link')).to_have_attribute('aria-checked', 'false')
        expect(helper.toggle(page, 'aurora-system')).to_have_attribute('aria-checked', 'true')
        expect(aurora.locator('.system-group-count')).to_have_text('3 项 · 1 已启用 · 2 已关闭')
        helper.toggle(page, 'aurora-link').click()
        expect(helper.toggle(page, 'aurora-link')).to_have_attribute('aria-checked', 'true')
        expect(helper.toggle(page, 'cloud')).to_have_attribute('aria-checked', 'false')
        expect(aurora.locator('.system-group-count')).to_have_text('3 项 · 2 已启用 · 1 已关闭')
        assert [(call['id'],call['enabled']) for call in command_args(page, helper.SET_ENABLED)] == [
            ('cloud',False),('aurora-link',True)]

        view(page).locator('#systemStartupSearch').fill('北辰云端套件')
        assert set(ids(page)) == {'cloud','aurora-link','aurora-system'}
        expect(view(page).locator('section[data-system-group]')).to_have_count(1)
        view(page).locator('#systemStatusFilter').select_option('enabled')
        assert set(ids(page)) == {'aurora-link','aurora-system'}
        expect(aurora.locator('.system-group-count')).to_have_text('2 项 · 2 已启用 · 0 已关闭')
        view(page).locator('#systemScopeFilter').select_option('user')
        assert ids(page) == ['aurora-link']
        expect(aurora.locator('.system-group-count')).to_have_text('1 项 · 1 已启用 · 0 已关闭')
        view(page).locator('#systemClearFilters').click()
        all_ids = set(ids(page))
        view(page).locator('#systemGroupMode').select_option('flat')
        expect(view(page).locator('section[data-system-group]')).to_have_count(0)
        expect(view(page).locator('#systemGroupingNote')).to_be_hidden()
        assert set(ids(page)) == all_ids
        view(page).locator('#systemGroupMode').select_option('software')
        expect(view(page).locator('section[data-system-group]')).to_have_count(6)
        expect(view(page).locator('#systemGroupingNote')).to_be_visible()
        assert helper.call_count(page, helper.SCAN) == 1, 'Grouping, filters and independent toggles must not invoke another scan'
    finally:
        page.close()

    page = helper.open_panel(browser, base_url, errors, quick=True, width=360, height=800,
        setup=EXTENDED_MOCK+'\n'+GROUP_SETUP)
    try:
        helper.no_horizontal_overflow(page)
        assert view(page).locator('.system-group-heading').evaluate_all(
            'nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1)')
        expect(software_group(page, 'installation-a')).to_have_attribute('aria-label', long_name)
        assert view(page).locator('#systemStartupList img,#systemStartupList script').count() == 0
        page.screenshot(path=str(helper.SCREENSHOTS / 'dtkit-startup-software-groups-360.png'), full_page=True)
    finally:
        page.close()


def grouped_batch_setup(sizes):
    return r"""
window.__startupItems=SIZES.flatMap((size,group)=>Array.from({length:size},(_,index)=>window.__startupItem({
    id:group===0&&index===0?'cloud':`group-${group}-${index}`,
    name:`Entry ${group} ${String(index).padStart(3,'0')}`,
    groupId:'batch-'+group,groupName:'BatchSoftware'+String(group+1).padStart(2,'0'),groupReason:'registered',
    enabled:group!==1||index%3!==0,fingerprint:`group-${group}-${index}-revision`
})));
""".replace('SIZES', str(sizes))


def test_software_group_pagination(browser, base_url, errors):
    page = open_panel(browser, base_url, errors, setup=grouped_batch_setup([50,40,20]))
    try:
        expect(view(page).locator('#systemPage')).to_have_text('1 / 2')
        expect(view(page).locator('.system-startup-row')).to_have_count(50)
        expect(software_group(page, 'batch-0').locator('[data-startup-id]')).to_have_count(50)
        assert view(page).locator('section[data-system-group]').count() == 1
        seen = ids(page)
        view(page).locator('#systemNext').click()
        expect(view(page).locator('#systemPage')).to_have_text('2 / 2')
        expect(view(page).locator('.system-startup-row')).to_have_count(60)
        expect(software_group(page, 'batch-1').locator('[data-startup-id]')).to_have_count(40)
        expect(software_group(page, 'batch-2').locator('[data-startup-id]')).to_have_count(20)
        seen += ids(page)
        assert len(seen) == len(set(seen)) == 110
        assert set(seen) == set(page.evaluate('window.__startupItems.map(item=>item.id)'))
        assert view(page).locator('.system-group-heading small').count() == 0
        view(page).locator('#systemGroupMode').select_option('flat')
        expect(view(page).locator('#systemPage')).to_have_text('1 / 2')
        expect(view(page).locator('.system-startup-row')).to_have_count(80)
        view(page).locator('#systemGroupMode').select_option('software')
        expect(view(page).locator('.system-startup-row')).to_have_count(50)
        view(page).locator('#systemStartupSearch').fill('BatchSoftware03')
        expect(view(page).locator('.system-startup-row')).to_have_count(20)
        expect(view(page).locator('#systemPagination')).to_be_hidden()
        expect(view(page).locator('#systemResultCount')).to_have_text('显示 20 / 110 项')
        assert helper.call_count(page, helper.SCAN) == 1
    finally:
        page.close()

    page = open_panel(browser, base_url, errors, setup=grouped_batch_setup([10,205,15]))
    try:
        seen = []
        for index, (total, large) in enumerate([(80,70),(80,80),(70,55)]):
            expect(view(page).locator('#systemPage')).to_have_text(f'{index+1} / 3')
            expect(view(page).locator('.system-startup-row')).to_have_count(total)
            section = software_group(page, 'batch-1')
            expect(section.locator('[data-startup-id]')).to_have_count(large)
            expect(section.locator('.system-group-count')).to_have_text(
                f'205 项 · 136 已启用 · 69 已关闭 · 本页 {large} 项')
            if index:
                expect(section.locator('.system-group-heading h4 small')).to_have_text('（续）')
            else:
                assert section.locator('.system-group-heading h4 small').count() == 0
            seen += ids(page)
            assert len(ids(page)) <= 80
            if index < 2:
                view(page).locator('#systemNext').click()
        assert len(seen) == len(set(seen)) == 230
        assert set(seen) == set(page.evaluate('window.__startupItems.map(item=>item.id)'))
        expect(view(page).locator('#systemNext')).to_be_disabled()
        view(page).locator('#systemPrevious').click()
        expect(view(page).locator('#systemPage')).to_have_text('2 / 3')
        expect(view(page).locator('.system-startup-row')).to_have_count(80)
        assert helper.call_count(page, helper.SCAN) == 1
    finally:
        page.close()


def test_filters_sort_copy_and_undo(browser, base_url, errors):
    page = open_panel(browser, base_url, errors, setup=CONFLICT_SETUP)
    try:
        expect(view(page).locator('.system-startup-row')).to_have_count(6)
        for status, identifier in [('managed', 'workspace'), ('conflicts', 'conflict'), ('unlocated', 'missing')]:
            view(page).locator(f'[data-system-status="{status}"]').click()
            expect(view(page).locator('#systemStatusFilter')).to_have_value(status)
            expect(view(page).locator(f'[data-system-status="{status}"]')).to_have_attribute('aria-pressed', 'true')
            assert ids(page) == [identifier]
        view(page).locator('#systemClearFilters').click()
        view(page).locator('#systemStartupSearch').fill('workspace')
        view(page).locator('#systemScopeFilter').select_option('user')
        view(page).locator('#systemSourceFilter').select_option('startupFolder')
        assert ids(page) == ['workspace']
        view(page).locator('#systemClearFilters').click()
        expect(view(page).locator('#systemStartupSearch')).to_have_value('')
        for selector in ['#systemStatusFilter', '#systemScopeFilter', '#systemSourceFilter']:
            expect(view(page).locator(selector)).to_have_value('all')
        expect(view(page).locator('#systemClearFilters')).to_be_hidden()
        view(page).locator('#systemSort').select_option('recent')
        assert ids(page)[:2] == ['conflict', 'workspace']
        view(page).locator('#systemSort').select_option('state')
        states = view(page).locator('[data-startup-toggle]').evaluate_all('nodes=>nodes.map(node=>node.getAttribute("aria-checked"))')
        assert states == ['true'] * 4 + ['false'] * 2, states
        view(page).locator('#systemSort').select_option('name')
        assert ids(page)[0] == 'system'
        assert helper.call_count(page, helper.SCAN) == 1, 'Local filters and sorting must not rescan'

        view(page).locator('[data-startup-details="cloud"]').click()
        view(page).locator('[data-startup-copy="cloud"]').click()
        page.wait_for_function('window.__startupClipboard.length>0')
        copied = page.evaluate('window.__startupClipboard')
        assert '\n状态：已启用\n范围：当前用户\n启动命令：' in copied, repr(copied)
        assert '\\n状态：' not in copied, repr(copied)
        assert '<script>alert(1)</script>' in copied

        helper.toggle(page, 'cloud').click()
        expect(helper.toggle(page, 'cloud')).to_have_attribute('aria-checked', 'false')
        expect(view(page).locator('#systemUndo')).to_be_visible()
        expect(view(page).locator('#systemUndo')).to_contain_text('撤销关闭')
        view(page).locator('#systemUndo').click()
        expect(helper.toggle(page, 'cloud')).to_have_attribute('aria-checked', 'true')
        expect(view(page).locator('#systemUndo')).to_be_hidden()
        calls = command_args(page, helper.SET_ENABLED)
        assert calls == [
            {'id':'cloud','enabled':False,'expectedFingerprint':'revision-1','toolId':'startup-manager'},
            {'id':'cloud','enabled':True,'expectedFingerprint':'revision-1-next','toolId':'startup-manager'}], calls
        view(page).locator('#systemOpenFolder').click()
        page.wait_for_function("window.__startupCalls.some(call=>call.command==='open_system_startup_folder')")
    finally:
        page.close()


def test_export_all_filtered_pages(browser, base_url, errors):
    setup = r"""
window.__startupItems=[window.__startupItem(),...Array.from({length:161},(_,index)=>window.__startupItem({
    id:'export-'+index,name:'Export batch '+String(index).padStart(3,'0')+' 中文',
    command:'"C:\\程序,目录\\工具.exe" --label="你好"\r\nnext',
    disabledReason:index===160?'=HYPERLINK("https://example.invalid")':null,
    backupDisabledAt:index===160?Date.UTC(2026,9,22,4,5,6):null,
    fingerprint:'export-revision-'+index})),window.__startupItem({id:'excluded',name:'Export batch disabled',enabled:false})];
"""
    page = open_panel(browser, base_url, errors, setup=setup)
    try:
        view(page).locator('#systemStartupSearch').fill('Export batch')
        view(page).locator('#systemStatusFilter').select_option('enabled')
        expect(view(page).locator('#systemResultCount')).to_have_text('显示 161 / 163 项')
        expect(view(page).locator('.system-startup-row')).to_have_count(80)
        view(page).locator('#systemNext').click()
        expect(view(page).locator('#systemPage')).to_have_text('2 / 3')
        with page.expect_download() as captured:
            view(page).locator('#systemExport').click()
        download = captured.value
        assert download.suggested_filename.startswith('DtKit-启动项-')
        data = Path(download.path()).read_bytes()
        assert data.startswith(b'\xef\xbb\xbf'), 'Excel requires a UTF-8 BOM for Chinese text'
        rows = list(csv.reader(io.StringIO(data.decode('utf-8-sig'), newline='')))
        assert rows[0] == ['名称','状态','范围','来源','命令','程序路径','来源位置','关闭时间','备注']
        assert len(rows) == 162, f'Expected all 161 matching entries, not one page: {len(rows)-1}'
        assert [row[0] for row in rows[1:]] == [f'Export batch {index:03d} 中文' for index in range(161)]
        assert all(len(row) == 9 for row in rows)
        assert rows[1][4] == '"C:\\程序,目录\\工具.exe" --label="你好"\r\nnext'
        assert rows[-1][7] == '2026-10-22T04:05:06.000Z'
        assert rows[-1][8] == '\'=HYPERLINK("https://example.invalid")'
        expect(view(page).locator('#systemStatus')).to_contain_text('161 项')
        assert helper.call_count(page, helper.SCAN) == 1
    finally:
        page.close()


def test_add_dialog_cancel_failure_retry(browser, base_url, errors):
    page = open_panel(browser, base_url, errors)
    try:
        page.set_viewport_size({'width':360,'height':800})
        view(page).locator('#systemAdd').click()
        expect(view(page).locator('#systemAddDialog')).to_be_visible()
        helper.no_horizontal_overflow(page)
        assert view(page).locator('#systemAddDialog').evaluate('node=>node.scrollWidth<=node.clientWidth+1')
        view(page).locator('#systemChooseProgram').click()
        expect(view(page).locator('#systemAddPath')).to_have_value('')
        view(page).locator('[data-system-close="systemAddDialog"]').click()
        expect(view(page).locator('#systemAddDialog')).not_to_be_visible()
        assert command_args(page, 'add_system_startup_item') == []

        page.evaluate(r"window.__startupDialogResults.push('C:\\应用目录\\工具.exe')")
        view(page).locator('#systemAdd').click()
        view(page).locator('#systemChooseProgram').click()
        expect(view(page).locator('#systemAddPath')).to_have_value('C:\\应用目录\\工具.exe')
        expect(view(page).locator('#systemAddName')).to_have_value('工具')
        options = page.evaluate('window.__startupDialogCalls')
        assert options == [{'multiple':False,'directory':False,'filters':[{'name':'Windows 程序','extensions':['exe']}]}] * 2
        view(page).locator('#systemAddName').fill('重复名字')
        view(page).locator('#systemAddArguments').fill('--label="你好" --quiet')
        page.evaluate("window.__startupFailure.add_system_startup_item='同名启动文件已存在，请更换名称'")
        view(page).locator('#systemAddSubmit').click()
        expect(view(page).locator('#systemAddError')).to_contain_text('同名启动文件')
        expect(view(page).locator('#systemAddDialog')).to_be_visible()
        expect(view(page).locator('#systemAddPath')).to_have_value('C:\\应用目录\\工具.exe')
        expect(view(page).locator('#systemAddArguments')).to_have_value('--label="你好" --quiet')
        page.evaluate("delete window.__startupFailure.add_system_startup_item")
        view(page).locator('#systemAddName').fill('新启动工具')
        view(page).locator('#systemAddSubmit').click()
        expect(view(page).locator('#systemAddDialog')).not_to_be_visible()
        expect(helper.row(page, 'added')).to_contain_text('新启动工具')
        assert command_args(page, 'add_system_startup_item') == [
            {'path':'C:\\应用目录\\工具.exe','name':'重复名字','arguments':'--label="你好" --quiet','toolId':'startup-manager'},
            {'path':'C:\\应用目录\\工具.exe','name':'新启动工具','arguments':'--label="你好" --quiet','toolId':'startup-manager'}]
    finally:
        page.close()


def test_forget_and_legacy_binding(browser, base_url, errors):
    page = open_panel(browser, base_url, errors, setup=CONFLICT_SETUP)
    try:
        view(page).locator('[data-startup-details="conflict"]').click()
        expect(helper.row(page, 'conflict')).to_contain_text('C:\\Fixture\\DtKitDisabledStartup\\Conflict.lnk')
        view(page).locator('[data-startup-backup="conflict"]').click()
        page.wait_for_function("window.__startupCalls.some(call=>call.command==='reveal_system_startup_item'&&call.args.target==='backup')")
        assert command_args(page, helper.REVEAL) == [
            {'id':'conflict','target':'backup','toolId':'startup-manager'}]
        view(page).locator('[data-startup-forget="conflict"]').click()
        expect(view(page).locator('#systemForgetDialog')).to_be_visible()
        expect(view(page).locator('#systemForgetDescription')).to_contain_text('Conflict entry')
        view(page).locator('[data-system-close="systemForgetDialog"]').click()
        assert command_args(page, 'forget_system_startup_backup') == []
        view(page).locator('[data-startup-forget="conflict"]').click()
        view(page).locator('#systemForgetConfirm').click()
        expect(view(page).locator('#systemForgetDialog')).not_to_be_visible()
        assert command_args(page, 'forget_system_startup_backup') == [
            {'id':'conflict','expectedFingerprint':'conflict-revision-1','toolId':'startup-manager'}]
        item = page.evaluate("window.__startupItems.find(item=>item.id==='conflict')")
        assert item['enabled'] is True and item['command'] == 'C:\\Apps\\Replacement.exe --new'
        assert item['canForgetBackup'] is False and item['backupConflict'] is False
        assert command_args(page, helper.SET_ENABLED) == [], 'Forgetting a record must not toggle the current configuration'
    finally:
        page.close()

    page = open_panel(browser, base_url, errors, setup="window.__startupRecoveryState='legacy';")
    try:
        expect(view(page).locator('#systemRecovery')).to_be_visible()
        expect(view(page).locator('#systemAdd')).to_be_disabled()
        expect(helper.toggle(page, 'cloud')).to_be_disabled()
        view(page).locator('#systemAdopt').click()
        expect(view(page).locator('#systemAdoptDialog')).to_be_visible()
        expect(view(page).locator('#systemAdoptConfirm')).to_be_disabled()
        view(page).locator('#systemAdoptConfirm').dispatch_event('click')
        assert command_args(page, 'adopt_system_startup_backups') == []
        view(page).locator('#systemAdoptCheck').check()
        expect(view(page).locator('#systemAdoptConfirm')).to_be_enabled()
        view(page).locator('#systemAdoptConfirm').click()
        expect(view(page).locator('#systemAdoptDialog')).not_to_be_visible()
        expect(view(page).locator('#systemRecovery')).to_be_hidden()
        expect(view(page).locator('#systemAdd')).to_be_enabled()
        expect(helper.toggle(page, 'cloud')).to_be_enabled()
        assert command_args(page, 'adopt_system_startup_backups') == [
            {'expectedStoreFingerprint':'store-revision-1','toolId':'startup-manager'}]
    finally:
        page.close()


def test_settings_return_once_and_about(browser, base_url, errors):
    page = open_panel(browser, base_url, errors)
    try:
        page.evaluate("window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'))")
        assert helper.call_count(page, helper.SCAN) == 1
        view(page).locator('#systemStartupSettings').click()
        page.wait_for_function("window.__startupCalls.some(call=>call.command==='open_system_startup_settings')")
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        assert helper.call_count(page, helper.SCAN) == 1, 'Opening settings alone must not refresh before leaving'
        page.evaluate("window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'))")
        page.wait_for_function("window.__startupCalls.filter(call=>call.command==='scan_system_startup_items').length===2")
        page.evaluate("window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'))")
        view(page).locator('#systemStartupSearch').click()
        page.wait_for_timeout(1100)
        assert helper.call_count(page, helper.SCAN) == 2, 'Returning from settings must refresh only once'
        page.locator('[data-view="settings"]').click()
        link = page.locator('#aboutProjectLink')
        expect(link).to_have_attribute('href', 'https://github.com/XiaoZhenYa001/Dtkit')
        link.click()
        page.wait_for_function("window.__startupCalls.some(call=>call.command==='open_project_page')")
        assert len(command_args(page, 'open_project_page')) == 1
    finally:
        page.close()


def test_start_fresh_preserves_current_configuration(browser, base_url, errors):
    page = open_panel(browser, base_url, errors, setup="window.__startupRecoveryState='legacy';")
    try:
        view(page).locator('#systemStartFresh').click()
        expect(view(page).locator('#systemAdoptDescription')).to_contain_text('保留旧版恢复文件')
        expect(view(page).locator('#systemAdoptCheckLabel')).to_contain_text('从空记录开始')
        expect(view(page).locator('#systemAdoptConfirm')).to_be_disabled()
        view(page).locator('[data-system-close="systemAdoptDialog"]').click()
        assert command_args(page, 'create_system_startup_recovery') == []
        # Reusing the dialog must switch the destructive operation's mode and
        # clear the checkbox, so a previous fresh start cannot become a bind.
        view(page).locator('#systemAdopt').click()
        expect(view(page).locator('#systemAdoptConfirm')).to_have_text('确认绑定')
        expect(view(page).locator('#systemAdoptCheck')).not_to_be_checked()
        view(page).locator('[data-system-close="systemAdoptDialog"]').click()
        view(page).locator('#systemStartFresh').click()
        expect(view(page).locator('#systemAdoptConfirm')).to_have_text('建立本机记录')
        view(page).locator('#systemAdoptConfirm').dispatch_event('click')
        assert command_args(page, 'create_system_startup_recovery') == []
        before = page.evaluate('window.__startupItems.map(({id,enabled,command})=>({id,enabled,command}))')
        view(page).locator('#systemAdoptCheck').check()
        view(page).locator('#systemAdoptConfirm').click()
        expect(view(page).locator('#systemAdoptDialog')).not_to_be_visible()
        expect(view(page).locator('#systemRecovery')).to_be_hidden()
        expect(view(page).locator('#systemAdd')).to_be_enabled()
        assert command_args(page, 'create_system_startup_recovery') == [
            {'expectedStoreFingerprint':'store-revision-1','toolId':'startup-manager'}]
        assert command_args(page, 'adopt_system_startup_backups') == []
        assert command_args(page, helper.SET_ENABLED) == []
        after = page.evaluate('window.__startupItems.map(({id,enabled,command})=>({id,enabled,command}))')
        assert after == before, 'Starting a new recovery store must not toggle or rewrite startup commands'
        expect(view(page).locator('#systemStatus')).to_contain_text('已保留旧恢复文件')
    finally:
        page.close()


def run(base_url):
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for test in [test_filters_sort_copy_and_undo, test_export_all_filtered_pages,
                         test_add_dialog_cancel_failure_retry, test_forget_and_legacy_binding,
                         test_start_fresh_preserves_current_configuration,
                         test_settings_return_once_and_about,
                         test_software_groups_and_independent_controls,
                         test_software_group_pagination]:
                print('Startup improvements: ' + test.__name__, flush=True)
                test(browser, base_url, errors)
        finally:
            browser.close()
    assert errors == [], errors
    print('PASS: quick filters/sort, newline clipboard, undo, complete filtered CSV, add/retry/cancel, forget/adopt, settings return/About, software grouping and complete group pagination', flush=True)
    print('Grouping screenshots: '+str(helper.SCREENSHOTS / 'dtkit-startup-software-groups-wide.png')+', '+
          str(helper.SCREENSHOTS / 'dtkit-startup-software-groups-360.png'), flush=True)


if __name__ == '__main__':
    external = os.environ.get('DTKIT_TEST_BASE_URL')
    if external:
        run(external)
    else:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0),
            functools.partial(helper.QuietHandler, directory=str(ROOT / 'dist')))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            run(f'http://127.0.0.1:{server.server_port}')
        finally:
            server.shutdown(); server.server_close(); worker.join()
