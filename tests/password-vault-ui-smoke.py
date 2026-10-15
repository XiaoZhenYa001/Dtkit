"""Password product flows, isolated IPC fixtures, and production-CSP layout checks."""
import importlib.util
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
OUT = Path(tempfile.gettempdir()) / 'dtkit-password-review'

MOCK = r"""
if (window === window.top) {
 const original = window.__TAURI__.core.invoke;
 window.__passwordCalls = []; window.__passwordDetailGate = false; window.__passwordImportFail = true;
 window.__passwordDeferred = []; window.__passwordSavePath = 'C:\\temp\\passwords.json';
 const entries = Array.from({length:235},(_,index)=>({id:String(index+1), service:index===0?'GitHub':index===1?'校园门户':`Service ${String(index).padStart(3,'0')}`, username:`user-${index}`, note:index===0?'个人账号':'测试条目',category:index===0?'开发':index===1?'学习':'',favorite:index===0,lastUsedAt:index===0?1786000000000:null,deletedAt:null}));
 const detail = id => ({...entries.find(entry=>entry.id===id),phone:'',email:'test@example.com',url:'https://example.com',createdAt:1780000000000,updatedAt:1785000000000,useCount:2,customFields:[{index:0,label:'恢复代码',value:'',sensitive:true,hasValue:true}]});
 window.__TAURI__.dialog.open = async () => 'C:\\temp\\import.csv';
 window.__TAURI__.dialog.save = async () => window.__passwordSavePath;
 window.__TAURI__.core.invoke = async (command,args={}) => {
  if (/password/.test(command)) window.__passwordCalls.push({command,args});
  if(command==='get_password_settings')return {clipboardClearSeconds:30};
  if(command==='set_password_settings')return args.settings;
  if(command==='get_password_overview')return {total:235,favoriteCount:1,recentCount:1,trashCount:0,uncategorizedCount:233,categories:[{name:'开发',count:1},{name:'学习',count:1}]};
  if(command==='list_passwords'){
   let matches=entries.filter(item=>!item.deletedAt);
   if(args.view==='favorites')matches=matches.filter(item=>item.favorite);
   if(args.view==='recent')matches=matches.filter(item=>item.lastUsedAt);
   if(args.view==='category')matches=matches.filter(item=>item.category===args.category);
   if(args.view==='uncategorized')matches=matches.filter(item=>!item.category);
   if(args.view==='trash')matches=[];
   let query=(args.query||'').trim().toLowerCase();if(query.startsWith('#分类 ')){query=query.slice(4);matches=matches.filter(item=>item.category.toLowerCase().includes(query));}
   else if(query)matches=matches.filter(item=>[item.service,item.username,item.note,item.category].some(value=>value.toLowerCase().includes(query)));
   if(args.sort==='name')matches.sort((a,b)=>a.service.localeCompare(b.service));
   const offset=Math.min(args.offset||0,Math.floor(Math.max(0,matches.length-1)/args.limit)*args.limit);
   return {items:matches.slice(offset,offset+args.limit),total:matches.length,truncated:offset+args.limit<matches.length,offset};
  }
  if(command==='get_password_detail'){
   if(window.__passwordDetailGate && args.id==='1')return new Promise(resolve=>window.__passwordDeferred.push(()=>resolve(detail('1'))));
   return detail(args.id);
  }
  if(command==='get_password_entry_for_edit')return {...detail(args.id),password:'editor-only-secret',customFields:[{label:'恢复代码',value:'private-recovery',sensitive:true}]};
  if(command==='save_password_entry')return {id:'1',service:args.entry.service};
  if(command==='preview_password_import')return {token:'import-1',format:'CSV',total:3,ready:2,duplicates:1,invalid:1,warnings:[],items:[{id:'import-good',service:'New Account',username:'me',note:'',category:''},{id:'import-dup',service:'GitHub',username:'user-0',note:'',category:'开发'}],conflicts:[{id:'import-dup',service:'GitHub',username:'user-0',source:'密码库中已有相同名称与用户名'}],issues:[{id:'missing-password',editable:true,source:'第 4 行',service:'Mail',username:'me',email:'me@example.com',note:'',category:'个人',errors:['密码为空']}]};
  if(command==='update_password_import_entry')return {ready:3,duplicates:1,invalid:0,item:{id:'corrected',service:'Mail',username:'me',note:'',category:'个人'},issue:null,conflicts:[{id:'import-dup',service:'GitHub',username:'user-0',source:'密码库中已有相同名称与用户名'}]};
  if(command==='commit_password_import'){if(window.__passwordImportFail){window.__passwordImportFail=false;throw new Error('测试写入失败');}return {imported:3,skipped:0,overwritten:0};}
  if(command==='export_password_entries')return {count:args.view==='all'&&!args.query?235:1,bytes:1234};
  if(command==='copy_password'||command==='copy_password_field'||command==='discard_password_import')return null;
  if(command==='audit_password_security')return {total:235,weak:1,reused:0,stale:0,incomplete:0,issues:[{id:'1',service:'GitHub',kinds:['weak']}]};
  return original(command,args);
 };
}
"""


def no_overflow(frame, selector):
    size = frame.locator(selector).evaluate('node=>({client:node.clientWidth,scroll:node.scrollWidth})')
    assert size['scroll'] <= size['client'] + 1, (selector, size)


def run(base):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width':1440,'height':900})
        context.add_init_script(multi.MOCK)
        context.add_init_script(MOCK)
        errors = []
        context.on('page',lambda page:page.on('pageerror',lambda error:errors.append(str(error))))
        def csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if 'text/html' in headers.get('content-type',''):
                headers['content-security-policy'] = multi.CSP
            route.fulfill(response=response,headers=headers)
        context.route(base+'/**',csp)
        page=context.new_page()
        OUT.mkdir(parents=True,exist_ok=True)
        try:
            page.goto(base,wait_until='networkidle')
            page.locator('[data-view="passwords"]').click()
            frame=multi.active_tool_frame(page,'.password-shell')
            expect(frame.locator('.password-result')).to_have_count(100)
            expect(frame.locator('#passwordPageLabel')).to_have_text('1 / 3 页')
            frame.locator('#passwordPageNext').click()
            expect(frame.locator('#passwordPageLabel')).to_have_text('2 / 3 页')
            frame.locator('#passwordPageNext').click()
            expect(frame.locator('.password-result')).to_have_count(35)
            frame.locator('#passwordPagePrev').click()
            frame.locator('#passwordSearch').fill('GitHub')
            expect(frame.locator('.password-result')).to_have_count(1)
            expect(frame.locator('#passwordPagination')).to_be_hidden()
            frame.locator('#passwordSearch').fill('')
            expect(frame.locator('.password-result')).to_have_count(100)

            # A delayed response for an older selection must not replace the new detail.
            page.evaluate('__passwordDetailGate=true')
            frame.locator('[data-password-id="1"]').click()
            frame.locator('[data-password-id="2"]').click()
            expect(frame.locator('.password-detail__header h3')).to_have_text('校园门户')
            page.evaluate('__passwordDeferred.splice(0).forEach(resolve=>resolve())')
            page.wait_for_timeout(50)
            expect(frame.locator('.password-detail__header h3')).to_have_text('校园门户')
            page.evaluate('__passwordDetailGate=false')
            frame.locator('[data-password-id="1"]').click()
            expect(frame.locator('.password-detail__header h3')).to_have_text('GitHub')
            frame.locator('#passwordSearch').focus()
            frame.locator('#passwordSearch').press('Enter')
            assert page.evaluate('__passwordCalls.some(call=>call.command==="copy_password"&&call.args.id==="1")')

            frame.locator('#passwordAdd').click()
            editor=frame.locator('#passwordEditor')
            expect(editor).to_be_visible()
            before=editor.bounding_box()
            owner=page.locator('iframe.tool-page-frame:not([hidden])').bounding_box()
            assert abs(before['x']+before['width']/2-(owner['x']+owner['width']/2))<3
            handle=editor.locator('.password-dialog__header').bounding_box()
            page.mouse.move(handle['x']+70,handle['y']+25)
            page.mouse.down();page.mouse.move(handle['x']+110,handle['y']+55,steps=4);page.mouse.up()
            assert editor.bounding_box()['x']>before['x']+15
            editor.locator('.password-dialog__close').click()
            expect(editor).to_be_hidden()
            frame.locator('[data-detail-action="edit"]').click()
            expect(frame.locator('#passwordValue')).to_have_value('editor-only-secret')
            frame.locator('#passwordEditor .password-dialog__close').click()
            expect(frame.locator('#passwordValue')).to_have_value('')

            frame.locator('#passwordImport').click()
            expect(frame.locator('#passwordImportDialog')).to_be_visible()
            assert frame.locator('#passwordImportDialog form form').count()==0
            frame.locator('[data-import-issue-edit="missing-password"]').click()
            correction=frame.locator('[data-import-issue-form="missing-password"]')
            correction.locator('input[name="password"]').fill('only-input-secret')
            correction.get_by_role('button',name='保存修正').click()
            expect(frame.locator('#passwordImportReadyCount')).to_have_text('3 条')
            assert 'only-input-secret' not in frame.locator('#passwordImportDialog').inner_text()
            frame.locator('#passwordImportConflicts summary').click()
            frame.locator('[data-import-decision="import-dup"]').select_option('keep')
            frame.locator('#passwordImportCommit').click()
            expect(frame.locator('#passwordImportStatus')).to_contain_text('可以重试')
            expect(frame.locator('#passwordImportCommit')).to_be_enabled()
            page.screenshot(path=str(OUT/'import-review.png'))
            frame.locator('#passwordImportCommit').click()
            expect(frame.locator('#passwordImportDialog')).to_be_hidden()
            assert page.evaluate('__passwordCalls.filter(call=>call.command==="commit_password_import").every(call=>call.args.token==="import-1"&&call.args.decisions[0].strategy==="keep")')

            frame.locator('#passwordExport').click()
            expect(frame.locator('#passwordExportCommit')).to_be_disabled()
            frame.locator('#passwordExportConfirmed').check()
            page.evaluate('__passwordSavePath=null')
            frame.locator('#passwordExportCommit').click()
            expect(frame.locator('#passwordExportCommit')).to_be_enabled()
            assert page.evaluate('__passwordCalls.filter(call=>call.command==="export_password_entries").length')==0
            page.evaluate('__passwordSavePath="C:\\\\temp\\\\passwords.json"')
            frame.locator('#passwordExportCommit').click()
            expect(frame.locator('#passwordExportDialog')).to_be_hidden()
            expect(frame.locator('#passwordStatus')).to_contain_text('235 条')
            frame.locator('#passwordExport').click()
            frame.locator('[name="passwordExportFormat"][value="csv"]').check()
            frame.locator('#passwordExportConfirmed').check()
            page.screenshot(path=str(OUT/'export.png'))
            frame.locator('#passwordExportDialog .password-dialog__close').click()
            frame.locator('[data-password-view="favorites"]').click()
            expect(frame.locator('.password-result')).to_have_count(1)
            no_overflow(frame,'.password-shell')
            page.screenshot(path=str(OUT/'desktop.png'))

            page.set_viewport_size({'width':780,'height':760})
            frame.locator('[data-password-id="1"]').click()
            expect(frame.locator('#passwordDetail')).to_have_class('password-detail is-open')
            expect(frame.locator('.password-detail__header h3')).to_have_text('GitHub')
            no_overflow(frame,'.password-shell')
            page.screenshot(path=str(OUT/'narrow-detail.png'))
            frame.locator('[data-close-detail]').click()
            expect(frame.locator('#passwordDetail')).to_be_hidden()

            quick=context.new_page()
            quick.goto(base+'/quick.html?kind=tool&toolId=password-vault',wait_until='networkidle')
            expect(quick.locator('.password-results--quick .password-result')).to_have_count(50)
            assert quick.locator('#passwordExport').count()==0
            quick.locator('#passwordSearch').fill('GitHub')
            expect(quick.locator('.password-result')).to_have_count(1)
            assert 'user-0' not in quick.locator('.password-result').inner_text()
            quick.locator('#passwordSearch').press('Enter')
            no_overflow(quick,'.password-quick')
            quick.screenshot(path=str(OUT/'quick.png'))
            assert not errors,errors
            quick.close()
        finally:
            context.close();browser.close()


if __name__=='__main__':
    with multi.production_url() as base:
        run(base)
    print('PASS: password pagination, selection races, editor cleanup, import retry, per-item conflicts, export confirmation/cancel, narrow drawer, quick search')
