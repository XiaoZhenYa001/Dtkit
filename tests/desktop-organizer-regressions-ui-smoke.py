"""Real DOM coverage for persisted categories, modal input and app moves.

Only mocked IPC and isolated browser storage are used; no desktop files change.
"""
import importlib.util
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('launcher_helpers', ROOT / 'tests/desktop-launcher-ui-smoke.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

MOCK = r"""
(() => {
    const listeners = new Map();
    const file = (name, category, extra = {}) => ({name, path:'C:/Desktop/'+name,
        category, is_folder:false, size:123, extension:'txt', modified_time:1,
        accessed_time:1, icon:null, ...extra});
    const doc = file('Notes.txt','document');
    const app = file('Editor','program',{path:'C:/Apps/Editor.exe',app_id:'app-editor',
        app_category:'program',app_manual:true,extension:'exe'});
    app.app_category=localStorage.getItem('__nativeAppCategory')||'program';
    localStorage.setItem('dtkit_desktop_categories_v2', JSON.stringify({version:2,
        customCategories:[{key:'custom_1',name:'Work',icon:'📁'}],
        fileCategories:window.__assigned ? {[doc.path]:'custom_1'} : {}}));
    window.__calls=[]; window.__failMove=false; window.__scanName='Notes.txt';
    window.__TAURI__={core:{invoke:async(command,args={})=>{
        window.__calls.push({command,args});
        if(command==='desktop_scan') return {documents:[{...doc,name:window.__scanName}],
            recent:[],images:[],videos:[],audios:[],archives:[],programs:[],folders:[],
            others:[],applications:[{...app}],total_count:2};
        if(command==='desktop_set_app_category') {
            if(window.__failMove) throw new Error('CATEGORY_SAVE_FAILED');
            app.app_category=args.category;
            localStorage.setItem('__nativeAppCategory',args.category);
            for(const callback of listeners.get('desktop-app-index-changed')||[]) callback({payload:null});
        }
        if(command==='get_screen_bounds') return {x:0,y:0,width:1400,height:900,virtualWidth:1400,virtualHeight:900};
        return null;
    }},event:{listen:async(name,callback)=>{
        if(!listeners.has(name)) listeners.set(name,new Set());
        listeners.get(name).add(callback);return ()=>listeners.get(name).delete(callback);
    }},window:{getCurrentWindow:()=>({innerSize:async()=>({width:550,height:650}),
        innerPosition:async()=>({x:800,y:0}),setSize:async()=>{},setPosition:async()=>{}})}};
})();
"""

def open_organizer(browser, base, assigned=False):
    context=browser.new_context(viewport={'width':550,'height':650})
    context.add_init_script(f'window.__assigned={str(assigned).lower()};' + MOCK)
    page=context.new_page()
    page.set_default_timeout(7000)
    page.goto(base+'/desktop-organizer/index.html',wait_until='networkidle')
    page.wait_for_function("window.__calls.some(call=>call.command==='desktop_scan')")
    return context,page

def show_blank_menu(page, action):
    page.locator('#dragHandle').click(button='right')
    page.locator(f'#blankContextMenu [data-action="{action}"]').click()

def expand_category(page,key):
    header=page.locator(f'[data-category="{key}"] .category-header')
    if header.get_attribute('aria-expanded')!='true':header.click()


def category_motion(page):
    result=page.evaluate('''() => {
        const item=document.querySelector('[data-category="document"]');
        const header=item.querySelector('.category-header'),files=item.querySelector('.category-files');
        header.click();
        const entering=files.getAnimations()[0];
        if(!entering) throw new Error('Category entrance must animate');
        entering.pause();entering.currentTime=60;
        const partial=files.getBoundingClientRect().height;
        const full=Number.parseFloat(entering.effect.getKeyframes().at(-1).height);
        header.click();
        const exiting=files.getAnimations()[0];
        exiting.pause();exiting.currentTime=0;
        const reverse=Number.parseFloat(exiting.effect.getKeyframes()[0].height);
        const retained=files.querySelectorAll('.file-item').length;
        exiting.currentTime=70;
        const closing=files.getBoundingClientRect().height;
        header.click();
        const reopening=files.getAnimations()[0];
        const reopened=Number.parseFloat(reopening.effect.getKeyframes()[0].height);
        reopening.finish();
        return {partial,full,reverse,retained,closing,reopened};
    }''')
    assert 0<result['partial']<result['full'],result
    assert abs(result['reverse']-result['partial'])<1,result
    assert abs(result['reopened']-result['closing'])<1 and result['retained']==1,result
    page.wait_for_function("document.querySelector('[data-category=\"document\"] .category-files').getAnimations().length===0")
    page.locator('[data-category="document"] [data-name="Notes.txt"]').focus()
    page.evaluate("document.querySelector('[data-category=\"document\"] .category-header').click()")
    expect(page.locator('[data-category="document"] .category-header')).to_be_focused()
    page.wait_for_function("document.querySelector('[data-category=\"document\"] .category-files').childElementCount===0")
    page.emulate_media(reduced_motion='reduce')
    page.locator('[data-category="document"] .category-header').click()
    assert page.locator('[data-category="document"] .category-files').evaluate('node=>node.getAnimations().length')==0
    page.emulate_media(reduced_motion='no-preference')
    page.locator('[data-category="document"] .category-header').click()
    page.wait_for_function("document.querySelector('[data-category=\"document\"] .category-files').childElementCount===0")
    print('PASS: category entrance/exit, continuous reversal, retained files, exit focus and OS reduced motion',flush=True)

def main():
    base,close=h.local_test_url()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            motion_context,motion_page=open_organizer(browser,base)
            category_motion(motion_page)
            motion_context.close()
            context,page=open_organizer(browser,base,assigned=True)
            expect(page.locator('#statusText')).to_contain_text('已同步')
            expand_category(page,'custom_1')
            expect(page.locator('[data-category="custom_1"] [data-name="Notes.txt"]')).to_have_count(1)
            page.evaluate("window.__scanName='Updated.txt'")
            page.locator('#refreshBtn').click()
            expect(page.locator('[data-category="custom_1"] [data-name="Updated.txt"]')).to_have_count(1)
            expect(page.locator('#statusText')).to_contain_text('已同步')
            context.close()
            print('PASS: persisted categories survive initial and later desktop scans')

            context,page=open_organizer(browser,base)
            expand_category(page,'document')
            page.locator('[data-name="Notes.txt"]').first.click()
            show_blank_menu(page,'create-category')
            field=page.locator('#categoryNameInput')
            expect(field).to_be_focused()
            field.press('Slash')
            expect(field).to_be_focused()
            field.fill('Team')
            page.evaluate('window.__calls=[]')
            field.press('Control+c')
            field.press('Enter')
            expect(page.locator('#createCategoryDialog')).to_be_hidden()
            assert not page.evaluate("window.__calls.some(c=>['desktop_copy_path','desktop_copy_to_clipboard','desktop_open_file','desktop_open_app'].includes(c.command))")
            show_blank_menu(page,'manage-categories')
            page.locator('#manageCategoriesCloseBtn').focus()
            page.keyboard.press('Slash')
            expect(page.locator('#searchInput')).not_to_be_focused()
            page.keyboard.press('Escape')
            expect(page.locator('#manageCategoriesDialog')).to_be_hidden()
            context.close()
            print('PASS: create/manage modal input cannot reach underlying shortcuts')

            context,page=open_organizer(browser,base)
            expand_category(page,'program')
            app=page.locator('[data-category="program"] [data-name="Editor"]')
            app.click(button='right')
            page.locator('[data-action="move-to-category"]').hover()
            page.locator('#categorySubmenu [data-category="custom_1"]').click()
            expand_category(page,'custom_1')
            expect(page.locator('[data-category="custom_1"] [data-name="Editor"]')).to_have_count(1)
            assert page.evaluate("window.__calls.some(c=>c.command==='desktop_set_app_category'&&c.args.category==='custom_1')")
            saved=page.evaluate("JSON.parse(localStorage.getItem('dtkit_desktop_categories_v2')||'{}')")
            assert 'C:/Apps/Editor.exe' not in saved.get('fileCategories',{}),saved
            page.reload(wait_until='networkidle')
            expand_category(page,'custom_1')
            expect(page.locator('[data-category="custom_1"] [data-name="Editor"]')).to_have_count(1)
            page.evaluate('window.__failMove=true')
            page.locator('[data-category="custom_1"] [data-name="Editor"]').click(button='right')
            page.locator('[data-action="move-to-category"]').hover()
            page.locator('#categorySubmenu [data-category="null"]').click()
            expect(page.locator('#statusText')).to_contain_text('CATEGORY_SAVE_FAILED')
            expect(page.locator('[data-category="custom_1"] [data-name="Editor"]')).to_have_count(1)
            page.evaluate('window.__failMove=false')
            page.locator('[data-category="custom_1"] [data-name="Editor"]').click(button='right')
            page.locator('[data-action="move-to-category"]').hover()
            page.locator('#categorySubmenu [data-category="null"]').click()
            expect(page.locator('[data-category="custom_1"] [data-name="Editor"]')).to_have_count(0)
            page.reload(wait_until='networkidle')
            expand_category(page,'program')
            expect(page.locator('[data-category="program"] [data-name="Editor"]')).to_have_count(1)
            context.close();browser.close()
            print('PASS: app category uses native persistence, failure retains current category, reset preserves app')
    finally:close()

if __name__=='__main__':main()
