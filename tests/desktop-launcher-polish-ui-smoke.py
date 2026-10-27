"""Production DOM regression for native-glass handoff, icons and folder limits."""
import importlib.util
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('launcher_smoke', ROOT/'tests/desktop-launcher-ui-smoke.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
WRAPPER = r'''
const previousInvoke=window.__TAURI__.core.invoke;
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=';
window.__TAURI__.core.invoke=async(command,args)=>{
    const value=await previousInvoke(command,args);
    if(command==='desktop_scan'){
        value.programs=[{name:'Desktop shortcut.lnk',path:'C:\\Users\\demo\\Desktop\\shortcut.lnk',category:'program',is_folder:false,icon:png}];
        value.documents.push(...Array.from({length:240},(_,i)=>({name:'Very long document name shared prefix '+i+'.txt',path:'C:\\Users\\demo\\Desktop\\long-'+i+'.txt',category:'document',is_folder:false,size:1024})));
    }
    if(command==='desktop_list_folder'){value.truncated=true;value.total_count=201;}
    if(command==='desktop_get_app_icon') return new Promise(resolve=>{window.__releaseAppIcon=()=>resolve(png);});
    if(command==='desktop_space_hide' && window.__holdHide) await new Promise(resolve=>{window.__releaseHide=resolve;});
    return value;
};
'''

def plate_styles(plate):
    return plate.evaluate('''node=>{
        const style=getComputedStyle(node),rim=getComputedStyle(node,'::after');
        return {background:style.backgroundImage,shadow:style.boxShadow,
            radius:style.borderRadius,rim:rim.boxShadow,size:node.offsetWidth};
    }''')


def unified_icon_plates(page):
    app=h.card(page,'Demo Tool').locator('.file-art')
    page.wait_for_function('!!window.__releaseAppIcon')
    before=plate_styles(app)
    assert before['background']!='none' and before['shadow']!='none' and before['rim']!='none',before
    page.evaluate('window.__releaseAppIcon()')
    expect(app.locator('.file-icon-real img')).to_be_visible()
    assert plate_styles(app)==before,'Native artwork must keep the fallback backplate'
    for name in ('Desktop shortcut.lnk','Project','Alpha.txt','Photo.png','Archive.bin'):
        assert plate_styles(h.card(page,name).locator('.file-art'))==before,name
    image=app.locator('img')
    assert image.evaluate('node=>({fit:getComputedStyle(node).objectFit,radius:getComputedStyle(node).borderRadius,filter:getComputedStyle(node).filter})')=={'fit':'contain','radius':'0px','filter':'none'}
    assert image.locator('..').evaluate('node=>getComputedStyle(node).filter')=='none'
    for size in ('small','medium','large'):
        page.evaluate('iconSize=>window.__emit("desktop-space-settings-changed",{iconSize})',size)
        side=app.bounding_box()['width'];art=image.bounding_box()['width']
        assert abs(art/side-.65)<.015,(size,side,art)
    page.evaluate('window.__emit("desktop-space-settings-changed",{iconSize:"medium",reducedMotion:true})')
    h.button(page,'Demo Tool').hover()
    assert app.evaluate('node=>getComputedStyle(node).transform')=='none'
    page.mouse.move(0,0)
    page.evaluate('window.__emit("desktop-space-settings-changed",{reducedMotion:false})')
    page.emulate_media(forced_colors='active')
    assert app.evaluate('node=>getComputedStyle(node).outlineStyle')=='solid'
    assert app.evaluate('node=>getComputedStyle(node,"::after").display')=='none'
    page.emulate_media(forced_colors='none')
    print('PASS: native artwork retains unified plate, intact images, all densities, reduced motion and high contrast',flush=True)


def refresh_keeps_surface_motion(page):
    before=page.evaluate('''async()=>{
        const root=document.querySelector('#launcher');
        await window.__emit('desktop-space-closing');
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const exit=root.getAnimations().find(a=>a.effect.target===root);
        exit.pause();exit.currentTime=90;
        await window.__emit('desktop-space-opened');
        const enter=root.getAnimations().find(a=>a.effect.target===root);
        enter.pause();enter.currentTime=66;
        const opacity=Number(getComputedStyle(root).opacity);
        document.querySelector('#refreshSpace').click();
        return opacity;
    }''')
    page.wait_for_function('!document.querySelector("#refreshSpace").disabled')
    after=page.locator('#launcher').evaluate('''node=>({opacity:Number(getComputedStyle(node).opacity),
        retained:node.getAnimations().some(a=>a.effect.target===node&&a.playState==='paused')})''')
    assert 0<before<1 and after['retained'] and abs(after['opacity']-before)<.001,(before,after)
    page.locator('#launcher').evaluate('node=>node.getAnimations().forEach(a=>a.finish())')
    h.idle(page)
    print('PASS: unchanged scan refresh does not finish the whole-window entrance',flush=True)


def main():
    base, close = h.local_test_url()
    output=ROOT/'tests/artifacts/desktop-polish'
    output.mkdir(parents=True,exist_ok=True)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            context=browser.new_context(viewport={'width':1280,'height':700})
            context.add_init_script(h.MOCK_TAURI+WRAPPER)
            page=context.new_page()
            errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(base+'/desktop-organizer/space.html',wait_until='networkidle')
            h.open_panel(page);h.idle(page)
            unified_icon_plates(page)
            refresh_keeps_surface_motion(page)
            icon=h.card(page,'Desktop shortcut.lnk').locator('.file-icon-img')
            expect(icon).to_have_count(1)
            expect(icon).to_be_visible()
            size=icon.bounding_box()
            assert size['width']>=42 and size['height']>=42,size
            assert page.locator('.launcher-material').evaluate('node=>getComputedStyle(node).borderTopWidth')=='0px'
            page.evaluate("window.__emit('desktop-space-opened',{session:50,lightBackground:true})")
            expect(page.locator('html')).to_have_attribute('data-appearance','light')
            ink=page.locator('html').evaluate('node=>getComputedStyle(node).color')
            assert max(map(int,ink.removeprefix('rgb(').removesuffix(')').split(',')))<100,ink
            page.evaluate("window.__emit('desktop-space-opened',{session:49,lightBackground:false})")
            expect(page.locator('html')).to_have_attribute('data-appearance','light')
            page.evaluate("window.__emit('desktop-space-opened',{session:51,lightBackground:false})")
            expect(page.locator('html')).to_have_attribute('data-appearance','dark')
            page.locator('#spaceLists').evaluate('node=>node.scrollTop=node.scrollHeight')
            page.locator('[data-filter="app"]').click();h.idle(page)
            assert page.locator('#spaceLists').evaluate('node=>node.scrollTop')==0
            first=page.locator('#fileGrid .launcher-card').first.bounding_box()
            viewport=page.locator('#spaceLists').bounding_box()
            assert first['y']>=viewport['y']-1,(first,viewport)
            page.locator('[data-filter="all"]').click();h.idle(page)
            assert page.locator('.file-name').first.evaluate('node=>getComputedStyle(node).webkitLineClamp')=='2'
            h.button(page,'Project').dblclick()
            expect(page.locator('#folderSummary')).to_contain_text('201')
            h.button(page,'Notes').click()
            expect(page.locator('#folderSummary')).to_be_visible()
            page.locator('#spaceSearch').fill('no-such-file')
            expect(page.locator('#spaceEmpty')).to_be_visible()
            expect(page.locator('#folderSummary')).to_contain_text('搜索仅覆盖已加载内容')
            page.locator('#spaceSearch').fill('')
            h.button(page,'Notes').dblclick()
            expect(page.locator('#folderTrail button')).to_have_text('Project')
            page.locator('#folderTrail button').click()
            expect(page.locator('#folderName')).to_have_text('Project')
            page.locator('#folderExternal').click()
            assert h.calls(page,'desktop_open_file')[-1]['args']['path'].endswith('Project')
            page.locator('#folderRoot').click();h.idle(page)
            for width,height in [(1280,700),(800,500),(420,320)]:
                page.set_viewport_size({'width':width,'height':height});h.idle(page)
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                page.screenshot(path=str(output/f'launcher-{width}.png'))
            page.evaluate('window.__holdHide=true')
            page.locator('#closeSpace').click()
            page.wait_for_function('!!window.__releaseHide')
            page.wait_for_timeout(100)
            assert page.locator('.launcher-material').evaluate('node=>getComputedStyle(node).opacity')=='1'
            assert 0<float(page.locator('#launcher').evaluate('node=>getComputedStyle(node).opacity'))<1
            page.evaluate("window.__emit('desktop-space-opened',{session:100})")
            page.evaluate('window.__releaseHide()')
            expect(page.locator('#launcher')).to_have_attribute('aria-hidden','false')
            assert not errors,errors
            context.close();browser.close()
    finally: close()
    print('PASS: real icons, two-line names, filter scroll reset, persistent folder limits, breadcrumb navigation, visible native exit handoff')

if __name__=='__main__':main()
