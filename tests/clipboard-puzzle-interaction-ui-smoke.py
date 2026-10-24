"""Real pointer gestures in the puzzle editor, with an isolated in-memory IPC store."""
import functools
import http.server
import re
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MOCK = r"""
window.__puzzleAssets = {};
window.__puzzleCalls = [];
window.__puzzleFailImport = false;
window.__puzzleTask = {meta:{id:'fixture-task',name:'绘图回归',revision:1,saved:false,count:0},
    frame:{x:0,y:0,w:640,h:420},background:'dots',nodes:[]};
window.__TAURI__ = {core:{invoke:async (command,args={})=>{
    window.__puzzleCalls.push({command,args:structuredClone(args)});
    const task=window.__puzzleTask;
    if(command==='get_tool_module_settings'||command==='get_shortcut_bindings') return [];
    if(command==='get_resource_policy') return {minimizeMode:'efficient'};
    if(command==='puzzle_open'||command==='puzzle_get') return structuredClone(task);
    if(command==='puzzle_overview') return {tasks:[{...task.meta}],retentionHours:24,collection:{taskId:null}};
    if(command==='puzzle_asset') return window.__puzzleAssets[args.assetId];
    if(command==='puzzle_import_image') {
        if(window.__puzzleFailImport) throw new Error('fixture image import failed');
        const assetId=crypto.randomUUID();window.__puzzleAssets[assetId]=args.dataUrl;return {assetId};
    }
    if(command==='puzzle_edit') {
        if(args.expectedRevision!=null && task.meta.revision!==args.expectedRevision) throw new Error('拼图已在其他窗口更新，请重新框选区域');
        for(const op of args.operations) {
            if(op.type==='remove') task.nodes=task.nodes.filter(n=>!op.ids.includes(n.id));
            if(op.type==='upsert') for(const node of op.nodes) {
                const at=task.nodes.findIndex(n=>n.id===node.id);
                if(at<0) task.nodes.push(structuredClone(node));else task.nodes[at]=structuredClone(node);
            }
            if(op.type==='configure') Object.assign(task,op);
        }
        task.meta.revision++;task.meta.count=task.nodes.length;return structuredClone(task);
    }
    return null;
}},event:{listen:async()=>()=>{}},window:{getCurrentWindow:()=>({label:'fixture',startDragging:async()=>{}})}};
"""


def launch(browser, url, *, width=1000, height=760, setup=''):
    page = browser.new_page(viewport={'width': width, 'height': height})
    page.add_init_script(MOCK + '\n' + setup)
    page.goto(url + '/tool-page.html?instanceId=puzzle-fixture&toolId=clipboard-puzzle', wait_until='networkidle')
    expect(page.locator('#puzzleTool')).to_be_visible()
    page.wait_for_function('Boolean(window.__DTKIT_TOOL_PAGE__?.ready)')
    return page


def live_pen(page):
    page.locator('button[data-tool=pen]').click()
    stage = page.locator('#puzzleStage').bounding_box()
    x, y = stage['x'] + 120, stage['y'] + 140
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 60, y + 40, steps=8)
    expect(page.locator('#puzzleInkPreview')).to_be_visible()
    expect(page.locator('#puzzleSelection')).to_be_hidden()
    assert page.evaluate('window.__puzzleTask.nodes.length') == 0, 'Preview must stay out of persisted objects'
    ink = page.locator('#puzzleInkPreview polyline').get_attribute('points')
    assert len(ink.split()) >= 3, ink
    page.mouse.move(x + 110, y + 20, steps=6)
    assert page.locator('#puzzleInkPreview polyline').get_attribute('points') != ink
    page.mouse.up()
    expect(page.locator('.puzzle-node[data-type=pen].selected')).to_have_count(1)
    expect(page.locator('#puzzleInkPreview')).to_be_hidden()
    assert page.evaluate('window.__puzzleTask.nodes.length') == 1
    # A closed stroke must survive even though its last point returns to its start.
    page.locator('button[data-tool=pen]').click()
    page.mouse.move(x + 150, y)
    page.mouse.down()
    for dx, dy in [(210, 0), (210, 60), (150, 60), (150, 0)]:
        page.mouse.move(x + dx, y + dy, steps=5)
    page.mouse.up()
    expect(page.locator('.puzzle-node[data-type=pen]')).to_have_count(2)
    page.locator('button[data-tool=pen]').click()
    page.mouse.move(x, y + 140)
    page.mouse.down()
    page.mouse.move(x + 60, y + 160, steps=5)
    expect(page.locator('#puzzleInkPreview')).to_be_visible()
    page.keyboard.press('Escape')
    page.mouse.up()
    expect(page.locator('#puzzleInkPreview')).to_be_hidden()
    assert page.evaluate('window.__puzzleTask.nodes.length') == 2
    print('PASS live ink, post-release selection, closed stroke and cancellation')


def region_menu(page):
    trigger = page.locator('button[data-tool=scissors]')
    trigger.hover()
    menu = page.locator('#puzzleRegionModes')
    expect(menu).to_be_visible()
    page.screenshot(path=str(Path(tempfile.gettempdir())/'dtkit-puzzle-region-menu.png'))
    assert menu.bounding_box()['y'] + menu.bounding_box()['height'] <= trigger.bounding_box()['y'] + 1
    page.locator('[data-action=region-cut]').click()
    expect(page.locator('[data-action=region-cut]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#puzzleModeHint')).to_contain_text('剪切')
    trigger.hover()
    page.locator('[data-action=region-copy]').click()
    expect(page.locator('#puzzleModeHint')).to_contain_text('原件保留')
    # Keyboard focus exposes the same controls without requiring hover.
    trigger.focus()
    expect(menu).to_be_visible()
    print('PASS region toolbar hover and keyboard mode selection')


SCENE = r"""
const node=(id,x,y,w,h,type='image')=>({id,type,x,y,w,h,name:id,body:'可编辑原文',originalBody:'可编辑原文',
    url:'',assetId:type==='image'?id:null,groupId:null,points:[],color:'#cf6c43',fontSize:18,rotation:0,collectedAt:1});
for(const [id,color] of [['bottom','#ee3300'],['top','#0033ee']]) {
    const c=document.createElement('canvas');c.width=240;c.height=160;const ctx=c.getContext('2d');
    ctx.fillStyle=color;ctx.fillRect(0,0,240,160);window.__puzzleAssets[id]=c.toDataURL();
}
window.__puzzleTask.nodes=[node('bottom',80,100,240,160),node('top',100,120,140,100),node('untouched',430,100,130,120,'note')];
window.__puzzleTask.meta.count=3;
window.__beforeRegion=structuredClone(window.__puzzleTask.nodes);
"""


def crop(page, mode):
    page.locator('button[data-tool=scissors]').hover()
    page.locator(f'[data-action=region-{mode}]').click()
    # Derive the camera from the actual original image dimensions after auto-fit.
    box=page.locator('[data-node-id=bottom]').bounding_box()
    z=box['width']/240
    x,y=box['x']+40*z,box['y']+30*z
    page.mouse.move(x,y)
    page.mouse.down()
    page.mouse.move(x+80*z,y+60*z,steps=8)
    page.mouse.up()


def region_cut(page):
    crop(page,'cut')
    page.wait_for_function('window.__puzzleTask.nodes.length===4')
    nodes=page.evaluate('window.__puzzleTask.nodes')
    before=page.evaluate('window.__beforeRegion')
    assert next(n for n in nodes if n['id']=='untouched')==before[2], 'An unrelated editable note must remain untouched'
    assert [n['id'] for n in nodes[:3]]==[n['id'] for n in before], 'Preserve stacking and object IDs'
    clipped=nodes[-1]
    assert clipped['name']=='剪切区域'
    assert abs(clipped['x']-224)<.001 and abs(clipped['y']-130)<.001, clipped
    # Inspect actual encoded PNG pixels rather than trusting replacement node labels.
    pixels=page.evaluate('''async()=>{
        const sample=async(node,x,y)=>{const img=new Image();img.src=window.__puzzleAssets[node.assetId];await img.decode();
            const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
            return [...ctx.getImageData(x-node.x,y-node.y,1,1).data];};
        const nodes=window.__puzzleTask.nodes;
        return {holes:await Promise.all(nodes.slice(0,2).map(n=>sample(n,150,150))),
            retained:await sample(nodes[0],90,110),clip:await sample(nodes.at(-1),250,150)};
    }''')
    assert all(p[3]==0 for p in pixels['holes']), pixels
    assert pixels['retained']==[238,51,0,255], pixels
    assert pixels['clip']==[0,51,238,255], pixels
    for element in page.locator('.puzzle-node[data-type=image]').all():
        expect(element.locator('img')).to_have_attribute('src', re.compile('^data:image/png'))
        assert element.evaluate('el=>getComputedStyle(el).backgroundColor')=='rgba(0, 0, 0, 0)'
        assert element.locator('.puzzle-node-content').evaluate('el=>getComputedStyle(el).backgroundColor')=='rgba(0, 0, 0, 0)'
    assert page.evaluate('window.__puzzleCalls.filter(c=>c.command==="puzzle_edit").length')==1
    assert '原区域留空' in page.locator('#puzzleStatus').inner_text()
    page.screenshot(path=str(Path(tempfile.gettempdir())/'dtkit-puzzle-region-cut.png'))
    page.locator('[data-action=export]').first.click()
    page.locator('#puzzleExportScope').select_option('all')
    page.locator('#puzzleExportTransparent').check()
    expect(page.locator('#puzzleExportPreview img')).to_be_visible()
    exported=page.evaluate('''async()=>{
        const img=document.querySelector('#puzzleExportPreview img');await img.decode();
        const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
        const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
        return {hole:[...ctx.getImageData(150-64,150-84,1,1).data],retained:[...ctx.getImageData(90-64,110-84,1,1).data]};
    }''')
    assert exported['hole'][3]==0 and exported['retained']==[238,51,0,255], exported
    page.locator('[data-action=close-modal]').first.click()
    page.keyboard.press('Control+z')
    page.wait_for_function('window.__puzzleTask.nodes.length===3')
    assert page.evaluate('window.__puzzleTask.nodes')==before, 'One undo must restore all original editable content'
    page.keyboard.press('Control+y')
    page.wait_for_function('window.__puzzleTask.nodes.length===4')
    assert page.evaluate('window.__puzzleTask.nodes')==nodes
    print('PASS cut removes only region pixels from each layer, preserves unrelated nodes and supports one-step undo/redo')


def region_copy_and_failure(page):
    crop(page,'copy')
    page.wait_for_function('window.__puzzleTask.nodes.length===4')
    assert page.evaluate('window.__puzzleTask.nodes.slice(0,3)')==page.evaluate('window.__beforeRegion')
    page.keyboard.press('Control+z')
    page.wait_for_function('window.__puzzleTask.nodes.length===3')
    page.evaluate('window.__puzzleFailImport=true')
    crop(page,'cut')
    expect(page.locator('#puzzleStatus')).to_contain_text('fixture image import failed')
    assert page.evaluate('window.__puzzleTask.nodes')==page.evaluate('window.__beforeRegion')
    page.evaluate('''window.__puzzleFailImport=false;
        const original=window.__TAURI__.core.invoke;
        window.__TAURI__.core.invoke=async(cmd,args)=>{
            const result=await original(cmd,args);
            if(cmd==='puzzle_import_image') window.__puzzleTask.meta.revision++;
            return result;
        };''')
    crop(page,'cut')
    expect(page.locator('#puzzleStatus')).to_contain_text('重新框选区域')
    assert page.evaluate('window.__puzzleTask.nodes')==page.evaluate('window.__beforeRegion'), 'Stale capture must not overwrite another view'
    print('PASS copy preserves originals; import failure and changed revision do not partially modify objects')


def region_history_limit(page):
    crop(page,'cut')
    expect(page.locator('#puzzleStatus')).to_contain_text('无法保证撤销')
    assert page.evaluate('window.__puzzleTask.nodes')==page.evaluate('window.__beforeRegion')
    assert page.evaluate('window.__puzzleCalls.filter(c=>c.command==="puzzle_edit").length')==0
    print('PASS oversized editable cut is rejected before editing when one-step undo cannot fit')


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'dist')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = launch(browser, f'http://127.0.0.1:{server.server_port}')
            errors=[]
            page.on('pageerror', lambda error: errors.append(str(error)))
            live_pen(page)
            region_menu(page)
            scene=launch(browser,f'http://127.0.0.1:{server.server_port}',setup=SCENE)
            scene.on('pageerror',lambda error:errors.append(str(error)))
            region_cut(scene)
            failure=launch(browser,f'http://127.0.0.1:{server.server_port}',width=680,height=480,setup=SCENE)
            failure.on('pageerror',lambda error:errors.append(str(error)))
            region_copy_and_failure(failure)
            large=launch(browser,f'http://127.0.0.1:{server.server_port}',setup=SCENE+r'''
                for(const n of window.__puzzleTask.nodes.slice(0,2)) {n.type='text';n.body='字'.repeat(800000);n.originalBody=n.body;}
                window.__beforeRegion=structuredClone(window.__puzzleTask.nodes);
            ''')
            region_history_limit(large)
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
