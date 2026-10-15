"""Verify the packaged puzzle editor in isolated native WebView2 windows.

Build with tests/native-webview.config.json. Never targets the installed app.
"""
import importlib.util
import base64
import json
import tempfile
import time
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_smoke', ROOT / 'tests/native-webview-ui-smoke.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
clip_spec=importlib.util.spec_from_file_location('clipboard_fixture',ROOT/'tests/windows-clipboard-fixture.py')
clip_module=importlib.util.module_from_spec(clip_spec);clip_spec.loader.exec_module(clip_module)
ART = ROOT / 'tests/artifacts/clipboard-puzzle'
ART.mkdir(parents=True, exist_ok=True)


def snapshot(page):
    return page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state')


def task(page):
    return page.evaluate('window.__TAURI__.core.invoke("puzzle_get", {taskId: window.__DTKIT_TOOL_PAGE__.snapshot().state.taskId})')


def check_quick(page, context, process):
    expect(page.locator('#puzzleTool')).to_be_visible()
    native.wait_until(lambda: page.evaluate('Boolean(window.__DTKIT_TOOL_PAGE__?.ready)'))
    page.locator('[data-action=tasks]').click()
    page.locator('[data-action=new]').click()
    native.wait_until(lambda: task(page)['meta']['count'] == 0)
    page.locator('[data-action=more]').click()
    page.locator('#puzzleMenu [data-action=insert-text]').click()
    page.locator('#puzzleEditText').fill('灵感从一个片段开始\n这是独立窗口的真实保存测试。')
    page.locator('[data-action=confirm-content]').click()
    expect(page.locator('.puzzle-node[data-type=text]')).to_have_count(1)
    expect(page.locator('#puzzleModal')).to_be_hidden()
    before = task(page)
    page.locator('[data-action=save]').first.click()
    native.wait_until(lambda: task(page)['meta']['saved'])
    page.screenshot(path=str(ART / 'floating.png'))
    geometry = page.evaluate('({w:innerWidth,h:innerHeight,scroll:document.documentElement.scrollWidth,tool:document.getElementById("puzzleTool").getBoundingClientRect().toJSON()})')
    assert geometry['scroll'] <= geometry['w'], geometry
    assert geometry['w'] > geometry['h'], geometry
    assert geometry['tool']['bottom'] <= geometry['h'] + 1, geometry
    assert geometry['tool']['height'] > geometry['h'] - 70, geometry
    page.locator('#quickPin').click()
    expect(page.locator('#quickPin')).to_have_attribute('aria-pressed', 'true')
    initial_size = page.evaluate('[innerWidth,innerHeight]')
    page.locator('#quickMaximize').click()
    native.wait_until(lambda: page.evaluate('[innerWidth,innerHeight]') != initial_size)
    page.locator('#quickMaximize').click()
    native.wait_until(lambda: page.evaluate('[innerWidth,innerHeight]') == initial_size)
    # Create another real native window, then drive its HTML drop handler. The
    # repository validates the source revision and assigns independent object IDs.
    page.evaluate('window.__TAURI__.core.invoke("open_quick_host",{target:{kind:"tool",toolId:"clipboard-puzzle"}})')
    native.wait_until(lambda: (page.wait_for_timeout(50) or len(context.pages) == 2))
    second = next(p for p in context.pages if p != page)
    expect(second.locator('#puzzleTool')).to_be_visible()
    native.wait_until(lambda: second.evaluate('Boolean(window.__DTKIT_TOOL_PAGE__?.ready)'))
    second.locator('[data-action=tasks]').click()
    second.locator('[data-action=new]').click()
    native.wait_until(lambda: task(second)['meta']['count'] == 0)
    expect(second.locator('.puzzle-sidebar')).to_be_hidden()
    assert snapshot(page)['taskId'] != snapshot(second)['taskId']
    node = before['nodes'][0]
    payload = {'version':1, 'sourceTaskId':before['meta']['id'], 'sourceRevision':task(page)['meta']['revision'], 'ids':[node['id']], 'grab':{'x':0,'y':0}}
    second.evaluate('''payload => {const dt=new DataTransfer();dt.setData('application/x-dtkit-puzzle',JSON.stringify(payload));const s=document.getElementById('puzzleStage'),r=s.getBoundingClientRect();s.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+80,clientY:r.top+100}));}''',payload)
    expect(second.locator('.puzzle-node[data-type=text]')).to_have_count(1)
    copied = task(second)['nodes'][0]
    assert copied['id'] != node['id'] and copied['body'] == node['body']
    second.locator('.puzzle-node[data-type=text]').dblclick()
    second.locator('#puzzleEditText').fill('另一份副本，独立修改')
    second.locator('[data-action=confirm-content]').click()
    native.wait_until(lambda: task(second)['nodes'][0]['body'] == '另一份副本，独立修改')
    assert task(page)['nodes'][0]['body'] == node['body']
    second.locator('[data-action=export]').first.click()
    expect(second.locator('#puzzleExportPreview img')).to_be_visible()
    second.screenshot(path=str(ART / 'export.png'))
    second.locator('[data-action=export-file]').click()
    expect(second.locator('#puzzleModal')).to_be_hidden()
    assert '已保存' in second.locator('#puzzleStatus').inner_text()
    second.locator('#quickClose').click()
    page.locator('#quickClose').click()
    native.wait_until(lambda: process.poll() is not None)
    assert process.returncode == 0


def check_main(page, context, process):
    expect(page.locator('#toolLibraryView')).to_be_visible()
    page.screenshot(path=str(ART / 'library.png'))
    sidebar = page.locator('.sidebar')
    assert round(sidebar.bounding_box()['width']) == 64
    choices = page.locator('.sidebar [data-view]').evaluate_all('(nodes)=>nodes.map(n=>n.dataset.view)')
    assert choices == ['toolLibrary','favorites','passwords','settings'], choices
    page.locator('#toolLibraryView [data-tool-id=clipboard-puzzle]').click()
    frame = page.locator('iframe.tool-page-frame:not([hidden])').element_handle().content_frame()
    native.wait_until(lambda: frame.evaluate('Boolean(window.__DTKIT_TOOL_PAGE__?.ready)'))
    expect(frame.locator('#puzzleTool')).to_be_visible()
    page.screenshot(path=str(ART / 'main.png'))
    assert frame.evaluate('document.scrollingElement.scrollWidth <= innerWidth')
    frame.locator('[data-action=more]').click()
    frame.locator('#puzzleMenu [data-action=insert-note]').click()
    frame.locator('#puzzleEditText').fill('主窗口便签测试')
    frame.locator('[data-action=confirm-content]').click()
    expect(frame.locator('.puzzle-node[data-type=note]')).to_have_count(1)
    page.screenshot(path=str(ART / 'main-content.png'))
    first_id=snapshot(frame)['taskId']
    page.locator('[data-tool-page-toggle]').click()
    page.locator('[data-tool-page-new]').click()
    native.wait_until(lambda: page.locator('iframe.tool-page-frame').count() == 2)
    other=page.locator('iframe.tool-page-frame:not([hidden])').element_handle().content_frame()
    native.wait_until(lambda: other.evaluate('Boolean(window.__DTKIT_TOOL_PAGE__?.snapshot().state?.taskId)'))
    assert snapshot(other)['taskId'] != first_id
    assert task(other)['meta']['count'] == 0


def check_drawing(page, context, process):
    expect(page.locator('#puzzleTool')).to_be_visible()
    native.wait_until(lambda: page.evaluate('Boolean(window.__DTKIT_TOOL_PAGE__?.ready)'))
    page.locator('[data-action=tasks]').click()
    page.locator('[data-action=new]').click()
    native.wait_until(lambda: task(page)['meta']['count'] == 0)
    png = page.evaluate('''(()=>{const c=document.createElement('canvas');c.width=240;c.height=160;const ctx=c.getContext('2d');ctx.fillStyle='#cf6c43';ctx.fillRect(0,0,240,160);ctx.fillStyle='#4a7566';ctx.fillRect(40,30,80,60);return c.toDataURL('image/png');})()''')
    page.locator('#puzzleFileInput').set_input_files({'name':'region.png','mimeType':'image/png','buffer':base64.b64decode(png.split(',')[1])})
    expect(page.locator('.puzzle-node[data-type=image]')).to_have_count(1)
    original = task(page)['nodes'][0]
    image = page.locator('.puzzle-node[data-type=image]').bounding_box()
    page.locator('[data-tool=scissors]').click()
    page.mouse.move(image['x']+40,image['y']+30)
    page.mouse.down();page.mouse.move(image['x']+120,image['y']+90,steps=8);page.mouse.up()
    native.wait_until(lambda: task(page)['meta']['count']==2)
    clipped = next(n for n in task(page)['nodes'] if n['id'] != original['id'])
    assert round(clipped['w'])==80 and round(clipped['h'])==60, clipped
    assert clipped['assetId'] != original['assetId']
    assert next(n for n in task(page)['nodes'] if n['id']==original['id']) == original
    stage=page.locator('#puzzleStage').bounding_box()
    for mode,start,end in [('rect',(210,30),(300,85)),('arrow',(300,100),(440,160)),('pen',(270,200),(400,225))]:
        page.locator(f'[data-tool={mode}]').click()
        page.mouse.move(stage['x']+start[0],stage['y']+start[1]);page.mouse.down()
        page.mouse.move(stage['x']+end[0],stage['y']+end[1],steps=12);page.mouse.up()
        native.wait_until(lambda: any(n['type']==mode for n in task(page)['nodes']))
    assert task(page)['meta']['count']==5
    page.keyboard.press('Control+z')
    native.wait_until(lambda: task(page)['meta']['count']==4)
    page.keyboard.press('Control+y')
    native.wait_until(lambda: task(page)['meta']['count']==5)
    page.evaluate('''png=>{const dt=new DataTransfer();dt.setData('text/plain','外部拖入的混合内容');dt.setData('text/html',`<p>外部拖入的混合内容</p><img src="${png}"><a href="https://example.com">来源</a>`);const s=document.getElementById('puzzleStage'),r=s.getBoundingClientRect();s.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+400,clientY:r.top+90}));}''',png)
    native.wait_until(lambda: task(page)['meta']['count']==8)
    dropped=task(page)['nodes'][-3:]
    assert {n['type'] for n in dropped}=={'text','image','link'}
    assert len({n['groupId'] for n in dropped})==1
    camera=snapshot(page)['camera']
    assert abs(min(n['x'] for n in dropped)-(400-camera['x'])/camera['z'])<1
    assert abs(min(n['y'] for n in dropped)-(90-camera['y'])/camera['z'])<1
    page.keyboard.press('Control+z')
    native.wait_until(lambda: task(page)['meta']['count']==5)
    page.keyboard.press('Control+y')
    native.wait_until(lambda: task(page)['meta']['count']==8)
    page.locator('[data-action=export]').first.click()
    expect(page.locator('#puzzleExportPreview img')).to_be_visible()
    page.locator('#puzzleExportScope').select_option('all')
    page.locator('#puzzleExportScale').select_option('2')
    page.locator('#puzzleExportTransparent').check()
    expect(page.locator('[data-action=export-file]')).to_be_enabled()
    alpha=page.evaluate('''(()=>{const img=document.querySelector('#puzzleExportPreview img'),c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return ctx.getImageData(0,0,1,1).data[3];})()''')
    assert alpha==0
    page.locator('[data-action=close-modal]').first.click()
    page.screenshot(path=str(ART/'drawing.png'))
    page.locator('#quickClose').click()
    native.wait_until(lambda: process.poll() is not None)
    assert process.returncode==0


def check_clipboard(page,context,process):
    expect(page.locator('#puzzleTool')).to_be_visible()
    native.wait_until(lambda: page.evaluate('Boolean(window.__DTKIT_TOOL_PAGE__?.snapshot().state?.taskId)'))
    page.locator('[data-action=tasks]').click();page.locator('[data-action=new]').click()
    expect(page.locator('.puzzle-sidebar')).to_be_hidden()
    id=snapshot(page)['taskId']
    with clip_module.preserved_clipboard() as clipboard:
        if clipboard is None:
            print('Clipboard integration skipped: existing clipboard cannot be restored losslessly',flush=True)
            page.evaluate('id=>window.__TAURI__.core.invoke("puzzle_collect",{taskId:id})',id)
            page.locator('#quickClose').click()
            time.sleep(.35)
            assert process.poll() is None,'Collector should keep the native process alive without a window'
            process.terminate();process.wait(timeout=10)
            print('Windowless listener lifetime passed without changing the existing clipboard',flush=True)
            return
        page.evaluate('id=>window.__TAURI__.core.invoke("puzzle_collect",{taskId:id})',id)
        clipboard.text('主动重复复制的文字')
        native.wait_until(lambda: task(page)['meta']['count']==1)
        clipboard.text('主动重复复制的文字')
        native.wait_until(lambda: task(page)['meta']['count']==2)
        excluded=clip_module.user.RegisterClipboardFormatW('ExcludeClipboardContentFromMonitorProcessing')
        clipboard.text('排除的敏感内容',[(excluded,b'\0')]);page.wait_for_timeout(250)
        assert task(page)['meta']['count']==2
        page.evaluate('window.__TAURI__.core.invoke("puzzle_copy_text",{text:"工具自己的输出"})')
        clipboard.remember();page.wait_for_timeout(250);assert task(page)['meta']['count']==2
        page.evaluate('id=>window.__TAURI__.core.invoke("puzzle_take_clipboard",{taskId:id})',id)
        assert task(page)['meta']['count']==3
        png=page.evaluate('(()=>{const c=document.createElement("canvas");c.width=12;c.height=8;const ctx=c.getContext("2d");ctx.fillStyle="#cf6c43";ctx.fillRect(0,0,12,8);return c.toDataURL("image/png");})()')
        fmt=clip_module.user.RegisterClipboardFormatW('HTML Format')
        html=f'<p>图片与说明</p><img src="{png}"><a href="https://example.com">来源</a>'.encode('utf-8')+b'\0'
        clipboard.text('图片与说明',[(fmt,html)])
        native.wait_until(lambda: task(page)['meta']['count']==6)
        captured=task(page)['nodes'][-3:]
        assert set(n['type'] for n in captured)=={'text','image','link'}
        assert len(set(n['groupId'] for n in captured))==1
        page.evaluate('args=>window.__TAURI__.core.invoke("puzzle_output",args)',{'dataUrl':png,'copy':True,'name':'test','taskId':id})
        clipboard.remember()
        assert not page.evaluate('window.__TAURI__.core.invoke("puzzle_overview").then(o=>o.collection.taskId)')
        page.wait_for_timeout(250);assert task(page)['meta']['count']==6
        page.evaluate('id=>window.__TAURI__.core.invoke("puzzle_collect",{taskId:id})',id)
        layout=page.evaluate('window.__TAURI__.core.invoke("get_storage_layout")')
        stored=Path(layout['kits'])/'ClipboardPuzzles/Tasks'/id/'task.json'
        page.locator('#quickClose').click()
        time.sleep(.35)
        assert process.poll() is None,'Collector should keep the native process alive without a window'
        clipboard.text('界面关闭后仍然收集')
        native.wait_until(lambda: len(json.loads(stored.read_text(encoding='utf-8'))['nodes'])==7)
        process.terminate();process.wait(timeout=10)
        print('Native collection, repeated copies, exclusion, own-output prevention and windowless capture passed',flush=True)


if __name__ == '__main__':
    executable = ROOT / 'src-tauri/target/debug/DtKit.exe'
    with sync_playwright() as playwright:
        native.run_case(playwright,executable,['--tool','clipboard-puzzle'],check_quick)
        native.run_case(playwright,executable,[],check_main)
        native.run_case(playwright,executable,['--tool','clipboard-puzzle'],check_drawing)
        native.run_case(playwright,executable,['--tool','clipboard-puzzle'],check_clipboard)
    print('Native puzzle editor, independent copies, export, window controls and palette passed',flush=True)
