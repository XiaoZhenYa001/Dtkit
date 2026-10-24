"""Production-CSP batch workflow checks; all filesystem IPC is mocked."""
import importlib.util
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
OUT = multi.ROOT / '.tmp' / 'file-batch-ui'
OUT.mkdir(parents=True, exist_ok=True)
MOCK = r"""(() => {
 window.__batchFiles=['C:\\Pictures\\photo 2.png','C:\\Pictures\\photo 10.png','C:\\Documents\\readme.txt'];
 window.__batchDialogCancelled=false; window.__batchHold=false; window.__batchPending=[];
 window.__batchConflict=false; window.__batchAutoFinish=true; window.__batchJobs={}; window.__batchRestores=0;
 window.__TAURI__.dialog.open=async options=>window.__batchDialogCancelled?null:options.directory?'C:\\Output':[...window.__batchFiles];
 const original=window.__TAURI__.core.invoke;
 const emit=payload=>{window.__batchJobs[payload.jobId]=payload;for(const listener of window.__multiListeners['file-batch-progress']||[])listener({payload})};
 window.__batchEmit=emit;
 const preview=request=>{
  let index=request.startIndex;const options=request.renameOptions||{},extensions=request.extensions||[];
  const items=request.sources.filter(path=>!extensions.length||extensions.includes(path.split('.').at(-1).toLowerCase())).map((source,i)=>{
   const name=source.split(/[\\/]/).at(-1),dot=name.lastIndexOf('.'),ext=dot>0?name.slice(dot+1):'';
   let stem=dot>0?name.slice(0,dot):name;
   if(options.find)stem=stem.split(options.find).join(options.replace||'');
   if(options.caseMode==='upper')stem=stem.toUpperCase();if(options.caseMode==='lower')stem=stem.toLowerCase();
   const tokens={name:stem,ext,dotext:ext?'.'+ext:'',n:String(index).padStart(options.numberPadding||1,'0')};
   const renamed=request.namePattern.replace(/\{(name|ext|dotext|n)\}/g,(_,key)=>tokens[key]);index+=options.numberStep||1;
   return {source,name,size:1024,target:request.operation==='delete'?null:request.operation==='rename'?source.slice(0,-name.length)+renamed:request.destination+'\\'+name,conflict:window.__batchConflict&&i===0?'目标文件已存在，不会覆盖':null};
  });
  return {operation:request.operation,items,skipped:request.sources.length-items.length,totalBytes:items.length*1024,hasConflicts:items.some(item=>item.conflict),permanent:request.permanent};
 };
 window.__TAURI__.core.invoke=async(command,args={})=>{
  if(!['preview_file_batch','start_file_batch','restore_file_batch','cancel_job','get_file_batch_status'].includes(command))return original(command,args);
  window.__multiCalls.push({command,args:structuredClone(args)});
  if(command==='preview_file_batch'){
   const value=preview(args.request);
   if(window.__batchHold)return new Promise(resolve=>window.__batchPending.push(()=>resolve(value)));
   return value;
  }
  if(command==='start_file_batch'){
   const jobId='job-'+window.__multiCalls.length,value=preview(args.request);
   emit({jobId,status:'running',progress:0.25,result:null,error:null});
   if(window.__batchAutoFinish)emit({jobId,status:'completed',progress:1,result:{processed:value.items.length,total:value.items.length,recoveryBatchId:args.request.operation==='delete'&&!args.request.permanent?'file-batch-ui-test':null},error:null});
   return {jobId,fileCount:value.items.length,totalBytes:value.totalBytes};
  }
  if(command==='cancel_job'){emit({jobId:args.jobId,status:'cancelled',progress:0.25,result:{processed:1,total:3},error:null});return true;}
  if(command==='restore_file_batch'){window.__batchRestores++;return {restored:window.__batchRestores===1?1:2,skipped:window.__batchRestores===1?2:0};}
  if(command==='get_file_batch_status')return window.__batchJobs[args.jobId]||null;
 };
})();
"""


def setup(browser, base, reduced=False):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce' if reduced else 'no-preference', accept_downloads=True)
    context.add_init_script(multi.MOCK)
    context.add_init_script(MOCK)
    def csp(route):
        response = route.fetch()
        headers = dict(response.headers)
        if 'text/html' in headers.get('content-type', ''):
            headers['content-security-policy'] = multi.CSP
        route.fulfill(response=response, headers=headers)
    context.route(base + '/**', csp)
    return context


def operation(page, name):
    page.locator(f'input[name="batchOperation"][value="{name}"]').locator('..').click()


def seed(page, files):
    page.evaluate('''files=>{const snapshot=window.__DTKIT_TOOL_PAGE__.snapshot();Object.assign(snapshot.state,{files,recordId:null,resultRecord:null,onlyConflicts:false,query:''});window.__DTKIT_TOOL_PAGE__.restore(snapshot)}''', files)


def checks(browser, base, reduced=False):
    context = setup(browser, base, reduced)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    try:
        page.goto(base + '/quick.html?kind=tool&toolId=file-batch', wait_until='networkidle')
        expect(page.locator('#batchSelectFiles')).to_be_visible()
        page.screenshot(path=str(OUT / ('empty-reduced.png' if reduced else 'empty.png')), full_page=True)
        page.locator('#batchSelectFiles').click()
        expect(page.locator('#batchSelectionSummary')).to_contain_text('已选择 3 个文件')
        expect(page.locator('.batch-preview-row')).to_have_count(3)
        page.locator('#batchSelectFiles').click()
        expect(page.locator('#batchCountTotal')).to_have_text('3')
        page.evaluate('window.__batchDialogCancelled=true')
        page.locator('#batchSelectFiles').click()
        expect(page.locator('#batchCountTotal')).to_have_text('3')
        page.evaluate('window.__batchDialogCancelled=false')

        page.locator('#batchNamePattern').fill('相册_{name}_{n}{dotext}')
        page.locator('#batchStartIndex').fill('7')
        page.locator('#batchNumberPadding').select_option('3')
        page.locator('.batch-advanced > summary').click()
        page.locator('#batchFind').fill('photo')
        page.locator('#batchReplace').fill('Holiday')
        page.locator('#batchCaseMode').select_option('upper')
        page.locator('#batchNumberStep').fill('2')
        expect(page.locator('.batch-file-target strong').first).to_have_text('相册_HOLIDAY 2_007.png')
        page.locator('#batchExtensions').fill('png')
        page.locator('#batchSort').select_option('name-desc')
        page.locator('#batchPreview').click()
        expect(page.locator('#batchExecute')).to_be_enabled()
        request = page.evaluate("window.__multiCalls.filter(call=>call.command==='preview_file_batch').at(-1).args.request")
        assert request['sources'][0].endswith('readme.txt')
        assert request['renameOptions']['numberStep'] == 2 and request['renameOptions']['numberPadding'] == 3
        expect(page.locator('.batch-preview-row.is-excluded')).to_have_count(1)
        page.screenshot(path=str(OUT / ('rules-reduced.png' if reduced else 'rules.png')), full_page=True)

        # A stale native read cannot enable execution for a different set of rules.
        page.locator('#batchNamePattern').fill('new_{n}{dotext}')
        expect(page.locator('#batchExecute')).to_be_disabled()
        page.evaluate('window.__batchHold=true')
        page.locator('#batchPreview').click()
        page.wait_for_function('()=>window.__batchPending.length===1')
        page.locator('#batchNamePattern').fill('final_{n}{dotext}')
        page.evaluate('window.__batchPending.shift()();window.__batchHold=false')
        expect(page.locator('#batchExecute')).to_be_disabled()
        page.locator('#batchPreview').click()
        expect(page.locator('#batchExecute')).to_be_enabled()
        with page.expect_download() as download:
            page.locator('#batchExport').click()
        exported = OUT / ('manifest-reduced.csv' if reduced else 'manifest.csv')
        download.value.save_as(exported)
        assert 'final_007.png' in exported.read_text(encoding='utf-8-sig')
        page.locator('#batchExecute').click()
        expect(page.locator('#batchProgressLabel')).to_have_text('处理完成')
        expect(page.locator('#batchProgressValue')).to_have_text('100%')
        assert all('final_' in path for path in page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state.files') if path.endswith('.png'))

        # Rapid operation reversal settles at one live panel, with one set of IDs.
        page.evaluate("()=>{for(let i=0;i<16;i++){const radio=document.querySelector(`input[name=batchOperation][value=${['copy','move','delete','rename'][i%4]}]`);radio.checked=true;radio.dispatchEvent(new Event('change',{bubbles:true}))}}")
        page.wait_for_function("()=>document.querySelector('#batchOptions').getAnimations({subtree:true}).length===0")
        assert page.locator('#batchOptions [data-batch-snapshot]').count() == 0
        assert page.evaluate("()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return ids.length===new Set(ids).size}")
        expect(page.locator('#batchRenameOptions')).to_be_visible()
        operation(page, 'copy')
        expect(page.locator('#batchSelectDestination')).to_be_enabled()
        page.locator('#batchSelectDestination').click()
        expect(page.locator('#batchDestinationPath')).to_have_text('C:\\Output')
        # An invalid hidden rename rule does not block copying.
        page.evaluate("()=>{const input=document.querySelector('#batchNumberStep');input.value='0'}")
        page.locator('#batchPreview').click()
        expect(page.locator('#batchExecute')).to_be_enabled()

        page.locator('#batchResetRules').click()
        seed(page, ['C:\\test\\one.txt', 'C:\\test\\two.txt', 'C:\\test\\three.txt'])
        page.evaluate('window.__batchConflict=true')
        page.locator('#batchPreview').click()
        expect(page.locator('#batchExecute')).to_be_disabled()
        page.locator('#batchOnlyConflicts').check()
        expect(page.locator('.batch-preview-row')).to_have_count(1)
        page.locator('.batch-row-remove').click()
        expect(page.locator('#batchCountTotal')).to_have_text('2')
        page.locator('#batchOnlyConflicts').uncheck()
        page.evaluate('window.__batchConflict=false')
        page.locator('#batchSearch').fill('one')
        expect(page.locator('.batch-preview-row')).to_have_count(1)
        page.locator('#batchSearch').fill('')

        operation(page, 'delete')
        page.locator('#batchPreview').click()
        page.locator('#batchExecute').click()
        expect(page.locator('#batchRestore')).to_be_visible()
        page.locator('#batchRestore').click()
        expect(page.locator('#batchStatus')).to_contain_text('暂未恢复')
        expect(page.locator('#batchRestore')).to_be_visible()
        page.locator('#batchRestore').click()
        expect(page.locator('#batchRestore')).not_to_be_visible()
        expect(page.locator('#batchStatus')).to_contain_text('已恢复 2 个文件')

        seed(page, ['C:\\test\\disposable.txt'])
        page.locator('#batchPermanent').check()
        page.locator('#batchPreview').click()
        page.locator('#batchExecute').click()
        expect(page.locator('#batchDangerDialog')).to_be_visible()
        page.get_by_role('button', name='返回检查', exact=True).click()
        expect(page.locator('#batchDangerDialog')).not_to_be_visible()
        assert not page.evaluate("window.__multiCalls.some(call=>call.command==='start_file_batch'&&call.args.request.permanent)")
        page.locator('#batchExecute').click()
        page.evaluate("()=>{document.querySelector('#batchConfirmPermanent').click();document.querySelector('#batchConfirmPermanent').click()}")
        expect(page.locator('#batchProgressLabel')).to_have_text('处理完成')
        assert page.evaluate("window.__multiCalls.filter(call=>call.command==='start_file_batch'&&call.args.request.permanent).length") == 1

        # Cancel works for a fresh task after an earlier completed task.
        seed(page, ['C:\\test\\a.txt', 'C:\\test\\b.txt', 'C:\\test\\c.txt'])
        operation(page, 'copy')
        page.evaluate('window.__batchAutoFinish=false')
        page.locator('#batchPreview').click()
        page.locator('#batchExecute').click()
        expect(page.locator('#batchCancel')).to_be_visible()
        expect(page.locator('#batchSelectFiles')).to_be_disabled()
        page.locator('#batchCancel').click()
        expect(page.locator('#batchProgressLabel')).to_have_text('任务已取消')
        expect(page.locator('#batchSelectFiles')).to_be_enabled()

        # Every selected file remains reachable beyond the first page.
        seed(page, [f'C:\\bulk\\photo-{i:03}.png' for i in range(135)])
        expect(page.locator('.batch-preview-row')).to_have_count(60)
        page.locator('#batchShowMore').click()
        expect(page.locator('.batch-preview-row')).to_have_count(120)
        page.locator('#batchShowMore').click()
        expect(page.locator('.batch-preview-row')).to_have_count(135)
        page.locator('#batchSearch').fill('photo-134')
        expect(page.locator('.batch-preview-row')).to_have_count(1)
        page.locator('#batchSearch').fill('')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.evaluate("document.documentElement.dataset.theme='dark'")
        page.screenshot(path=str(OUT / ('narrow-dark-reduced.png' if reduced else 'narrow-dark.png')), full_page=True)
        assert page.evaluate('()=>document.documentElement.scrollWidth<=innerWidth+1')
        page.locator('#batchHelp').click()
        expect(page.locator('#batchHelpDialog')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('#batchHelpDialog')).not_to_be_visible()
        assert not errors, errors
        print(f'PASS batch UI {"reduced" if reduced else "normal"}: additive selection, live rules, stale preflight, export, conflicts, restore, delete confirmation, cancellation and responsive motion', flush=True)
    except Exception:
        page.screenshot(path=str(OUT / 'failure.png'), full_page=True)
        raise
    finally:
        context.close()


def workspace_checks(browser, base):
    context = setup(browser, base)
    page = context.new_page()
    try:
        page.goto(base, wait_until='networkidle')
        page.locator('[data-tool-id="file-batch"] .tool-card__title').click()
        frame = multi.active_tool_frame(page, '.batch-tool-shell')
        frame.locator('#batchSelectFiles').click()
        frame.locator('#batchNamePattern').fill('Saved_{n}{dotext}')
        frame.locator('#batchSearch').fill('photo')
        frame.locator('#batchSort').select_option('name-asc')
        frame.locator('.batch-advanced > summary').click()
        frame.locator('#batchFind').fill('photo')
        frame.locator('#batchReplace').fill('旅途')
        frame.locator('#batchPreview').click()
        expect(frame.locator('#batchExecute')).to_be_enabled()
        frame.locator('#batchReplace').evaluate('node=>{node.focus();node.setSelectionRange(1,2)}')
        page.evaluate('()=>window.__DTKIT_TOOL_WORKSPACE__.persist()')
        page.reload(wait_until='networkidle')
        frame = multi.active_tool_frame(page, '.batch-tool-shell')
        expect(frame.locator('#batchSelectionSummary')).to_contain_text('3 个文件')
        expect(frame.locator('#batchNamePattern')).to_have_value('Saved_{n}{dotext}')
        expect(frame.locator('#batchSearch')).to_have_value('photo')
        expect(frame.locator('#batchReplace')).to_have_value('旅途')
        assert frame.locator('#batchReplace').evaluate('node=>node===document.activeElement && node.selectionStart===1 && node.selectionEnd===2')
        assert frame.locator('.batch-advanced').evaluate('node=>node.open')
        assert not frame.locator('#batchFind').evaluate('node=>node.closest("[inert]")!==null')
        expect(frame.locator('#batchExecute')).to_be_disabled()
        print('PASS batch workspace: files, rules, search, sort and disclosure restore; a restored draft requires a fresh native check', flush=True)
    finally:
        context.close()


def layout_checks(browser, base, reduced=False):
    context = setup(browser, base, reduced)
    page = context.new_page()
    try:
        for width, height in [(1366, 768), (680, 844), (390, 844)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.goto(base + '/quick.html?kind=tool&toolId=file-batch', wait_until='networkidle')
            page.locator('#batchSelectFiles').click()
            expect(page.locator('.batch-preview-row')).to_have_count(3)
            page.wait_for_function('()=>!document.querySelector(".batch-tool-shell").getAnimations({subtree:true}).length')
            # The compact file strip keeps its add button in flow, including narrow layouts.
            assert page.evaluate('''()=>{
                const strip=document.querySelector('.batch-source-section').getBoundingClientRect();
                const button=document.querySelector('#batchSelectFiles').getBoundingClientRect();
                return strip.height<42&&button.top>=strip.top&&button.bottom<=strip.bottom+1&&button.left>=strip.left&&button.right<=strip.right+1;
            }''')
            page.locator('.batch-advanced > summary').click()
            page.wait_for_function('()=>!document.querySelector(".batch-advanced").getAnimations({subtree:true}).length')
            page.locator('#batchFind').fill('photo')
            page.locator('#batchReplace').fill('holiday')
            page.locator('#batchExtensions').fill('png')
            # Quick keyboard focus changes must not leave the input clipped behind the shell footer.
            page.wait_for_function('''()=>{
                const field=document.querySelector('#batchExtensions'), bounds=field.getBoundingClientRect();
                const bar=document.querySelector('.batch-config-footer').getBoundingClientRect();
                const viewport=document.querySelector('.quick-content').getBoundingClientRect();
                return bounds.top>=bar.bottom+4&&bounds.bottom<=viewport.bottom&&document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2)===field;
            }''')
            assert page.evaluate('''()=>{
                const button=document.querySelector('#batchPreview'), bounds=button.getBoundingClientRect();
                const viewport=document.querySelector('.quick-content').getBoundingClientRect();
                const hit=document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
                return bounds.top>=viewport.top&&bounds.bottom<=viewport.bottom&&button.contains(hit);
            }''')
            assert page.evaluate('()=>document.documentElement.scrollWidth<=innerWidth+1')
        print(f'PASS batch layout {"reduced" if reduced else "normal"}: compact file strip, sticky actions and unclipped focused fields at 1366, 680 and 390 pixels', flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    with multi.production_url() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            checks(browser, base)
            checks(browser, base, True)
            workspace_checks(browser, base)
            layout_checks(browser, base)
            layout_checks(browser, base, True)
        finally:
            browser.close()
