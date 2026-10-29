"""Production-CSP checks for batch import, cleanup and truthful result exports.

All filesystem commands use independent IPC mocks; this launches headless
Chromium only. Run against a fresh production build.
"""
import csv
import importlib.util
import io
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location('batch_existing', Path(__file__).with_name('file-batch-ui-smoke.py'))
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)
OUT = batch.multi.ROOT / '.tmp' / 'file-batch-improvements-ui'
OUT.mkdir(parents=True, exist_ok=True)

MOCK = r"""(() => {
 let runtime;
 Object.defineProperty(window,'__DTKIT_TOOL_PAGE__',{configurable:true,get:()=>runtime,set:value=>{
  runtime=value;const attach=value.attachTool.bind(value);
  value.attachTool=tool=>{window.__improveTool=tool;return attach(tool)};
 }});
 const install=()=>{
  const fallback=window.__TAURI__.core.invoke;
  window.__improveReady=true;
  window.__improvePendingCollect=[];window.__improveHoldCollect=false;window.__improveCollectResult=null;
  window.__improveConflictSources=[];window.__improvePreviewError='';window.__improveNativePreview=null;
  window.__improveHoldRestore=false;window.__improvePendingRestore=[];
  window.__improveFinish={status:'completed',processed:null,error:null};window.__improveSizes={};
  const folder=source=>{
   const segments=source.replace(/\\/g,'/').replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\//,'').split('/');
   segments.pop();
   while(segments.length&&segments.at(-1)==='')segments.pop();
   if(!segments.length||/^[a-z]:$/i.test(segments.at(-1)))return '';
   if(segments[0]===''&&segments[1]===''&&segments.filter(Boolean).length<=2)return '';
   return segments.at(-1);
  };
  // Deliberately independent of the production core: the expected results below
  // are also checked against fixed Unicode filenames, not just this mock.
  const preview=request=>{
   const options=request.renameOptions||{};let sequence=request.startIndex;
   const items=[];
   for(const source of request.sources){
    const name=source.split(/[\\/]/).at(-1),dot=name.lastIndexOf('.');
    let stem=dot>0?name.substring(0,dot):name,ext=dot>0?name.substring(dot+1):'';
    if(request.extensions.length&&!request.extensions.includes(ext.toLowerCase()))continue;
    if(options.trimWhitespace)stem=stem.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'');
    const letters=[...stem];
    const end=Math.max(0,letters.length-(options.removeEnd||0));
    stem=letters.slice(options.removeStart||0,end).join('');
    if(options.find)stem=stem.split(options.find).join(options.replace||'');
    if(options.caseMode==='lower')stem=stem.toLowerCase();
    if(options.caseMode==='upper')stem=stem.toUpperCase();
    if(options.extensionCase==='lower')ext=ext.toLowerCase();
    if(options.extensionCase==='upper')ext=ext.toUpperCase();
    const variables={name:stem,ext,dotext:ext?'.'+ext:'',n:String(sequence).padStart(options.numberPadding||1,'0'),folder:folder(source)};
    const renamed=request.namePattern.replace(/\{(name|ext|dotext|n|folder)\}/g,(_,key)=>variables[key]);
    sequence+=options.numberStep||1;
    items.push({source,name,size:window.__improveSizes[source]??1024,
     target:request.operation==='delete'?null:request.operation==='rename'?source.substring(0,source.length-name.length)+renamed:request.destination+'\\'+name,
     conflict:window.__improveConflictSources.includes(source)?'目标文件已存在，不会覆盖':null});
   }
   return {operation:request.operation,items,skipped:request.sources.length-items.length,totalBytes:items.reduce((sum,item)=>sum+item.size,0),hasConflicts:items.some(item=>item.conflict),permanent:request.permanent};
  };
  const handled=['collect_file_batch_sources','preview_file_batch','start_file_batch','restore_file_batch','cancel_job'];
  window.__TAURI__.core.invoke=async(command,args={})=>{
   if(!handled.includes(command))return fallback(command,args);
   window.__multiCalls.push({command,args:structuredClone(args)});
   if(command==='collect_file_batch_sources'){
    const value=structuredClone(window.__improveCollectResult||{sources:['C:\\Output\\same.txt','C:\\Output\\report.txt',...(args.recursive?['C:\\Output\\nested\\deep.txt']:[])],skipped:0,truncated:false,warnings:[]});
    return window.__improveHoldCollect?new Promise(resolve=>window.__improvePendingCollect.push(()=>resolve(value))):value;
   }
   if(command==='preview_file_batch'){
    if(window.__improvePreviewError)throw new Error(window.__improvePreviewError);
    const value=preview(args.request);window.__improveNativePreview=structuredClone(value);return value;
   }
   if(command==='start_file_batch'){
    const jobId='improved-job-'+window.__multiCalls.length,value=preview(args.request);
    window.__improveLastJobId=jobId;
    window.__batchEmit({jobId,clientId:args.request.clientId,status:'running',progress:0,result:null,error:null});
    if(window.__batchAutoFinish){
     const terminal=window.__improveFinish,processed=terminal.processed??value.items.length;
     window.__batchEmit({jobId,clientId:args.request.clientId,status:terminal.status,progress:processed/value.items.length,
      result:{processed,total:value.items.length,recoveryBatchId:args.request.operation==='delete'&&!args.request.permanent?'file-batch-improved-'+jobId:null},error:terminal.error});
    }
    return {jobId,fileCount:value.items.length,totalBytes:value.totalBytes};
   }
   if(command==='cancel_job'){
    window.__batchEmit({jobId:args.jobId,status:'cancelled',progress:1/3,result:{processed:1,total:3},error:null});return true;
   }
   if(command==='restore_file_batch'){
    const value={restored:3,skipped:0};
    return window.__improveHoldRestore?new Promise(resolve=>window.__improvePendingRestore.push(()=>resolve(value))):value;
   }
  };
 };
 if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
"""


def open_page(browser, base, *, reduced=False):
    context = batch.setup(browser, base, reduced)
    context.add_init_script(MOCK)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    page.goto(base + '/quick.html?kind=tool&toolId=file-batch', wait_until='networkidle')
    page.wait_for_function('()=>window.__improveReady===true')
    expect(page.locator('#batchSelectFolder')).to_be_visible()
    return context, page, errors


def files(page):
    return page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state.files')


def calls(page, command):
    return page.evaluate('command=>window.__multiCalls.filter(call=>call.command===command)', command)


def export_rows(page, name):
    expect(page.locator('#batchExport')).to_be_enabled()
    with page.expect_download() as event:
        page.locator('#batchExport').click()
    path = OUT / (name + '.csv')
    event.value.save_as(path)
    data = path.read_bytes()
    assert data.startswith(b'\xef\xbb\xbf'), 'Export must retain its Excel-compatible BOM'
    return list(csv.DictReader(io.StringIO(data.decode('utf-8-sig'))))


def import_checks(page):
    batch.seed(page, ['C:\\Output\\same.txt'])
    expect(page.locator('#batchIncludeSubfolders')).not_to_be_checked()
    page.locator('#batchSelectFolder').click()
    expect(page.locator('#batchCountTotal')).to_have_text('2')
    assert calls(page, 'collect_file_batch_sources')[-1]['args'] == {'directory': 'C:\\Output', 'recursive': False}
    expect(page.locator('#batchStatus')).to_contain_text('略过 1 个重复项')
    page.locator('#batchIncludeSubfolders').check()
    page.locator('#batchSelectFolder').click()
    expect(page.locator('#batchCountTotal')).to_have_text('3')
    assert calls(page, 'collect_file_batch_sources')[-1]['args']['recursive'] is True
    assert files(page)[-1] == 'C:\\Output\\nested\\deep.txt'

    batch.seed(page, [f'C:\\existing\\item-{index:03}.txt' for index in range(490)])
    page.evaluate("window.__improveCollectResult={sources:Array.from({length:20},(_,i)=>`C:\\\\new\\\\item-${i}.txt`),skipped:2,truncated:true,warnings:['部分目录无读取权限']}")
    page.locator('#batchSelectFolder').click()
    expect(page.locator('#batchCountTotal')).to_have_text('500')
    expect(page.locator('#batchStatus')).to_contain_text('文件夹已添加 10 项')
    expect(page.locator('#batchStatus')).to_contain_text('清单仅包含部分文件')
    expect(page.locator('#batchStatus')).to_contain_text('跳过 2 项')
    expect(page.locator('#batchStatus')).to_contain_text('部分目录无读取权限')
    expect(page.locator('#batchExecute')).to_be_disabled()

    original = ['C:\\keep\\original.txt']
    batch.seed(page, original)
    page.evaluate("window.__improveCollectResult={sources:['C:\\\\late\\\\ignored.txt'],skipped:0,truncated:false,warnings:[]};window.__improveHoldCollect=true")
    page.locator('#batchSelectFolder').click()
    page.wait_for_function('()=>window.__improvePendingCollect.length===1')
    expect(page.locator('#batchPreview')).to_be_disabled()
    page.evaluate('window.__DTKIT_TOOL_PAGE__.setSuspended(true)')
    page.evaluate('window.__improvePendingCollect.shift()()')
    page.evaluate('window.__DTKIT_TOOL_PAGE__.setSuspended(false)')
    expect(page.locator('#batchSelectFolder')).to_be_enabled()
    assert files(page) == original, 'A hidden page accepted its abandoned directory response'
    page.locator('#batchSelectFolder').click()
    page.wait_for_function('()=>window.__improvePendingCollect.length===1')
    batch.seed(page, ['C:\\keep\\restored.txt'])
    page.evaluate('window.__improvePendingCollect.shift()()')
    expect(page.locator('#batchSelectFolder')).to_be_enabled()
    assert files(page) == ['C:\\keep\\restored.txt'], 'A restored draft accepted an obsolete directory response'
    page.evaluate('window.__improveHoldCollect=false')
    print('PASS improvements: folder scope, recursive import, deduplication, limits and abandoned async imports', flush=True)


def rule_checks(page):
    sources = ['C:\\Trips\\  😀旧x🧩  .tXt', '\\\\server\\share\\资料{n}\\\u00a0😀旧x🧩\u00a0.TXT']
    batch.seed(page, sources)
    page.locator('#batchNamePattern').fill('{folder}_{name}_{n}{dotext}')
    page.locator('#batchStartIndex').fill('7')
    page.locator('#batchNumberPadding').select_option('3')
    page.locator('.batch-advanced > summary').click()
    page.locator('#batchTrimWhitespace').check()
    page.locator('#batchRemoveStart').fill('1')
    page.locator('#batchRemoveEnd').fill('1')
    page.locator('#batchFind').fill('旧x')
    page.locator('#batchReplace').fill('Straße{n}')
    page.locator('#batchCaseMode').select_option('upper')
    page.locator('#batchExtensionCase').select_option('lower')
    page.locator('#batchNumberStep').fill('2')
    expected = ['Trips_STRASSE{N}_007.txt', '资料{n}_STRASSE{N}_009.txt']
    assert page.locator('.batch-file-target strong').all_text_contents() == expected
    expect(page.locator('#batchCheckState')).to_have_text('本地草稿')
    expect(page.locator('#batchReadyLabel')).to_have_text('预计处理')
    page.locator('#batchPreview').click()
    expect(page.locator('#batchExecute')).to_be_enabled()
    assert page.locator('.batch-file-target strong').all_text_contents() == expected
    native = page.evaluate('window.__improveNativePreview.items.map(item=>item.target.split(/[\\\\/]/).at(-1))')
    assert native == expected
    expect(page.locator('#batchCheckState')).to_have_text('已检查')
    expect(page.locator('#batchReadyLabel')).to_have_text('可执行')
    request = calls(page, 'preview_file_batch')[-1]['args']['request']
    assert {key: request['renameOptions'][key] for key in ['trimWhitespace', 'removeStart', 'removeEnd', 'extensionCase']} == {
        'trimWhitespace': True, 'removeStart': 1, 'removeEnd': 1, 'extensionCase': 'lower'}
    page.locator('#batchRemoveEnd').fill('2')
    expect(page.locator('#batchExecute')).to_be_disabled()
    expect(page.locator('#batchCheckState')).to_have_text('本地草稿')
    page.locator('#batchPreview').click()
    expect(page.locator('#batchExecute')).to_be_enabled()
    page.evaluate("window.__improvePreviewError='无法重新读取文件'")
    page.locator('#batchPreview').click()
    expect(page.locator('#batchStatus')).to_contain_text('无法重新读取文件')
    expect(page.locator('#batchExecute')).to_be_disabled()
    expect(page.locator('.batch-row-status[data-state="ready"]')).to_have_count(0)
    expect(page.locator('.batch-row-status[data-state="draft"]')).to_have_count(2)
    expect(page.locator('#batchCheckState')).to_have_text('本地草稿')
    page.evaluate("window.__improvePreviewError=''")

    page.locator('#batchRenamePreset').select_option('parent')
    expect(page.locator('#batchNamePattern')).to_have_value('{folder}_{n}{dotext}')
    page.locator('#batchNamePattern').fill('{name}{dotext}')
    expect(page.locator('#batchRenamePreset')).to_have_value('original')
    page.locator('#batchNamePattern').evaluate('node=>node.setSelectionRange(0,0)')
    page.locator('[data-batch-token="{folder}"]').click()
    expect(page.locator('#batchNamePattern')).to_have_value('{folder}{name}{dotext}')
    expect(page.locator('#batchRenamePreset')).to_have_value('custom')
    page.evaluate('window.__improveSaved=window.__DTKIT_TOOL_PAGE__.snapshot()')
    page.locator('#batchRenamePreset').select_option('sequence')
    page.evaluate('window.__DTKIT_TOOL_PAGE__.restore(window.__improveSaved)')
    expect(page.locator('#batchRenamePreset')).to_have_value('custom')
    expect(page.locator('#batchNamePattern')).to_have_value('{folder}{name}{dotext}')
    expect(page.locator('#batchTrimWhitespace')).to_be_checked()
    expect(page.locator('#batchRemoveStart')).to_have_value('1')
    expect(page.locator('#batchRemoveEnd')).to_have_value('2')
    expect(page.locator('#batchExtensionCase')).to_have_value('lower')
    expect(page.locator('#batchExecute')).to_be_disabled()
    page.locator('#batchNamePattern').fill('{folder}_{n}{dotext}')
    expect(page.locator('#batchRenamePreset')).to_have_value('parent')
    print('PASS improvements: Unicode cleanup, independent preview, invalidation, failed rechecks and preset restoration', flush=True)


def bulk_checks(page):
    sources = [f'C:\\bulk\\item-{index:03}.txt' for index in range(135)]
    batch.seed(page, sources)
    page.evaluate('sources=>window.__improveConflictSources=sources', sources[:100])
    page.locator('#batchPreview').click()
    expect(page.locator('#batchCountConflict')).to_have_text('100')
    expect(page.locator('.batch-preview-row')).to_have_count(60)
    page.locator('#batchRemoveConflicts').click()
    expect(page.locator('#batchCountTotal')).to_have_text('35')
    assert files(page) == sources[100:]
    expect(page.locator('#batchExecute')).to_be_disabled()
    expect(page.locator('#batchStatus')).to_contain_text('100')
    page.evaluate('window.__improveConflictSources=[]')

    dropped = [f'C:\\bulk\\drop-{index:03}.txt' for index in range(90)]
    kept = [f'C:\\bulk\\keep-{index:03}.txt' for index in range(50)]
    batch.seed(page, dropped + kept)
    expect(page.locator('#batchRemoveVisible')).to_be_disabled()
    page.locator('#batchSearch').fill('drop-')
    expect(page.locator('.batch-preview-row')).to_have_count(60)
    expect(page.locator('#batchListCount')).to_contain_text('60 / 90')
    page.locator('#batchRemoveVisible').click()
    assert files(page) == kept, 'Bulk removal stopped at the first rendered page'
    expect(page.locator('#batchCountTotal')).to_have_text('50')
    page.locator('#batchSearch').fill('')
    expect(page.locator('.batch-preview-row')).to_have_count(50)
    assert calls(page, 'start_file_batch') == [], 'Removing list entries must not change files on disk'
    print('PASS improvements: bulk conflict and search removal cover files beyond the rendered 60 rows', flush=True)


def result_checks(page):
    sources = ['C:\\results\\zero.txt', 'C:\\results\\second.txt', 'C:\\results\\third.txt']
    batch.seed(page, sources)
    page.evaluate('source=>window.__improveSizes[source]=0', sources[0])
    batch.operation(page, 'delete')
    page.locator('#batchPreview').click()
    page.locator('#batchExecute').click()
    expect(page.locator('#batchProgressLabel')).to_have_text('处理完成')
    assert files(page) == []
    expect(page.locator('#batchTotalLabel')).to_have_text('本批文件')
    expect(page.locator('#batchReadyLabel')).to_have_text('已完成')
    expect(page.locator('#batchCountReady')).to_have_text('3')
    rows = export_rows(page, 'delete-completed')
    assert [row['检查或执行状态'] for row in rows] == ['已完成'] * 3
    assert rows[0]['大小（字节）'] == '0'
    assert all(row['操作'] == '删除' for row in rows)

    page.evaluate('window.__improveHoldRestore=true')
    page.locator('#batchRestore').click()
    page.wait_for_function('()=>window.__improvePendingRestore.length===1')
    for selector in ['#batchPreview', '#batchExecute', '#batchSelectFiles', '#batchSelectFolder', '#batchNamePattern', '#batchResetRules', '#batchRestore', 'input[name="batchOperation"][value="copy"]']:
        expect(page.locator(selector)).to_be_disabled()
    expect(page.locator('.batch-tool-shell')).to_have_attribute('data-stage', 'restoring')
    before = {command: len(calls(page, command)) for command in ['preview_file_batch', 'start_file_batch']}
    page.keyboard.press('Control+Enter')
    page.evaluate("()=>{window.__DTKIT_TOOL_PAGE__.runPageAction('check');document.querySelector('#batchExecute').click();document.querySelector('#batchResetRules').click();document.querySelector('input[value=copy]').click()}")
    assert {command: len(calls(page, command)) for command in before} == before
    assert page.locator('input[name="batchOperation"][value="delete"]').is_checked()
    page.evaluate('window.__improvePendingRestore.shift()()')
    expect(page.locator('#batchSelectFiles')).to_be_enabled()
    expect(page.locator('#batchStatus')).to_contain_text('已恢复 3 个文件')
    assert files(page) == sources
    expect(page.locator('#batchExecute')).to_be_disabled()

    batch.operation(page, 'copy')
    page.locator('#batchSelectDestination').click()
    page.evaluate("window.__improveFinish={status:'failed',processed:1,error:'目标文件已存在'}")
    page.locator('#batchPreview').click()
    page.locator('#batchExecute').click()
    expect(page.locator('#batchProgressLabel')).to_have_text('处理失败')
    rows = export_rows(page, 'copy-failed')
    assert [row['检查或执行状态'] for row in rows] == ['已完成', '未处理', '未处理']
    assert [row['任务提示'] for row in rows] == ['目标文件已存在'] * 3

    batch.seed(page, sources)
    page.evaluate('window.__batchAutoFinish=false')
    page.locator('#batchPreview').click()
    page.locator('#batchExecute').click()
    expect(page.locator('#batchCancel')).to_be_visible()
    rows = export_rows(page, 'copy-running')
    assert [row['检查或执行状态'] for row in rows] == ['等待'] * 3
    page.locator('#batchCancel').click()
    expect(page.locator('#batchProgressLabel')).to_have_text('任务已取消')
    rows = export_rows(page, 'copy-cancelled')
    assert [row['检查或执行状态'] for row in rows] == ['已完成', '未处理', '未处理']
    print('PASS improvements: deleted-file export, partial failure/cancellation, running status and restore locking', flush=True)


def restore_rebuild_checks(page):
    sources = ['C:\\rebuild\\one.txt', 'C:\\rebuild\\two.txt', 'C:\\rebuild\\three.txt']
    batch.seed(page, sources)
    batch.operation(page, 'delete')
    page.evaluate('window.__improveHoldRestore=true')

    def start_delayed_restore():
        page.locator('#batchPreview').click()
        page.locator('#batchExecute').click()
        expect(page.locator('#batchProgressLabel')).to_have_text('处理完成')
        assert files(page) == []
        page.locator('#batchRestore').click()
        page.wait_for_function('()=>window.__improvePendingRestore.length===1')
        return {command: len(calls(page, command)) for command in ['preview_file_batch', 'start_file_batch']}

    def rebuild(same_session):
        page.evaluate('''async sameSession=>{
            const runtime=window.__DTKIT_TOOL_PAGE__,tool=window.__improveTool,saved=runtime.snapshot();
            const oldRoot=document.querySelector('.batch-tool-shell'),container=oldRoot.parentElement;
            if(!sameSession){
                saved.state.sessionId=crypto.randomUUID();saved.state.files=['C:\\\\other-session\\\\independent.txt'];
                saved.state.recordId=null;saved.state.resultRecord=null;saved.state.appliedJobId=null;saved.state.history=[];
            }
            tool.destroy();container.innerHTML=tool.template();await tool.init();await runtime.restore(saved);
            window.__improveRebuiltRoot=oldRoot!==document.querySelector('.batch-tool-shell')&&!oldRoot.isConnected;
        }''', same_session)
        assert page.evaluate('window.__improveRebuiltRoot'), 'The regression must create a new view, not only restore fields'
        expect(page.locator('#batchPreview')).to_be_disabled()

    before = start_delayed_restore()
    old_session = page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state.sessionId')
    rebuild(True)
    assert page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state.sessionId') == old_session
    page.evaluate('window.__improvePendingRestore.shift()()')
    expect(page.locator('#batchSelectFiles')).to_be_enabled()
    expect(page.locator('#batchStatus')).to_contain_text('已恢复 3 个文件')
    assert files(page) == sources, 'Restore completion was lost when the original view was destroyed'
    assert {command: len(calls(page, command)) for command in before} == before

    before = start_delayed_restore()
    rebuild(False)
    assert page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state.sessionId') != old_session
    page.evaluate('window.__improvePendingRestore.shift()()')
    expect(page.locator('#batchSelectFiles')).to_be_enabled()
    assert files(page) == ['C:\\other-session\\independent.txt'], 'An earlier session polluted a new draft after restore completion'
    assert {command: len(calls(page, command)) for command in before} == before
    print('PASS improvements: delayed recovery survives same-session view rebuilding and leaves different sessions intact', flush=True)


def screenshot_checks(browser, base):
    context, page, errors = open_page(browser, base, reduced=True)
    try:
        sources = ['C:\\Photos\\Trips\\IMG_002.JPG', 'C:\\Photos\\Trips\\IMG_010.JPG', 'C:\\Work\\报告初稿.docx', 'C:\\Downloads\\readme.txt']
        for width, height in [(1366, 900), (680, 844), (390, 844)]:
            page.set_viewport_size({'width': width, 'height': height})
            for theme in ['light', 'dark']:
                page.goto(base + '/quick.html?kind=tool&toolId=file-batch', wait_until='networkidle')
                page.evaluate('theme=>document.documentElement.dataset.theme=theme', theme)
                batch.seed(page, sources)
                page.locator('#batchRenamePreset').select_option('parent')
                page.locator('#batchNumberPadding').select_option('3')
                page.locator('#batchIncludeSubfolders').check()
                page.evaluate("()=>{document.activeElement?.blur();document.querySelector('.quick-content').scrollTop=0;window.scrollTo(0,0)}")
                page.wait_for_function('()=>!document.querySelector(".batch-tool-shell").getAnimations({subtree:true}).length')
                assert page.evaluate('()=>document.documentElement.scrollWidth<=innerWidth+1')
                page.screenshot(path=str(OUT / f'{theme}-{width}-workspace.png'), full_page=False)

                page.locator('.batch-advanced > summary').click()
                page.locator('#batchTrimWhitespace').check()
                page.locator('#batchRemoveStart').fill('1')
                page.locator('#batchRemoveEnd').fill('2')
                page.locator('#batchExtensionCase').select_option('lower')
                page.evaluate("""()=>{
                    document.activeElement?.blur();const viewport=document.querySelector('.quick-content');viewport.scrollTop=0;
                    const advanced=document.querySelector('.batch-advanced').getBoundingClientRect();
                    viewport.scrollTop=Math.max(0,advanced.top-viewport.getBoundingClientRect().top-125);window.scrollTo(0,0);
                }""")
                page.wait_for_function('()=>!document.querySelector(".batch-tool-shell").getAnimations({subtree:true}).length')
                assert page.evaluate('()=>document.documentElement.scrollWidth<=innerWidth+1')
                page.screenshot(path=str(OUT / f'{theme}-{width}-advanced-rules.png'), full_page=False)
        assert not errors, errors
        print('PASS improvements: viewport screenshots in light/dark at 1366, 680 and 390 pixels; workspace and advanced rules are separate', flush=True)
    finally:
        context.close()


def run(browser, base):
    for check in [import_checks, rule_checks, bulk_checks, result_checks, restore_rebuild_checks]:
        context, page, errors = open_page(browser, base)
        try:
            check(page)
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(OUT / (check.__name__ + '-failure.png')), full_page=False)
            raise
        finally:
            context.close()
    screenshot_checks(browser, base)


if __name__ == '__main__':
    with batch.multi.production_url() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            run(browser, base)
        finally:
            browser.close()
