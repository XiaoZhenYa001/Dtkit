"""Production screenshot editor regression using real image pixels and isolated IPC.

Uses a temporary localhost server and a fresh Chromium profile. Native capture,
clipboard writes, saving and OCR are fixtures; no user screen or clipboard is read.
"""
import argparse
import base64
import importlib.util
import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi_page', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
SCREENSHOTS = multi.ROOT / '.tmp' / 'screenshot-review'

INSTRUMENTATION = r"""
(() => {
  const fixture=window.__captureFixture={calls:[],textCopies:[],failCopy:false,failSave:false,failOcr:false,pendingListen:[],unlistened:0};
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
    const target=window.top.__captureFixture;if(target.failCopy)throw new Error('Clipboard fixture rejected');target.textCopies.push(text);
  }}});
  if(window!==window.top)return;
  fixture.image=()=>{const c=document.createElement('canvas');c.width=640;c.height=400;const x=c.getContext('2d');
    x.fillStyle='#f4f4f6';x.fillRect(0,0,640,400);x.fillStyle='#0a84ff';x.fillRect(0,0,320,200);x.fillStyle='#30d158';x.fillRect(320,0,320,200);
    x.fillStyle='#ff9f0a';x.fillRect(0,200,320,200);x.fillStyle='#bf5af2';x.fillRect(320,200,320,200);return c.toDataURL('image/png');};
  fixture.emit=payload=>{for(const callback of window.__multiListeners['screen-region-captured']||[])callback({payload});};
  const invoke=window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke=async(command,args={})=>{
    if(['start_screen_region_capture','cancel_screen_region_capture','copy_screenshot_to_clipboard','save_annotated_screenshot','recognize_screenshot_text'].includes(command)){
      if(command==='start_screen_region_capture'&&(!args.requestId||!Object.hasOwn(args,'instanceId')))throw new Error('Capture request identity missing');
      fixture.calls.push({command,args:structuredClone(args)});
      if(command==='copy_screenshot_to_clipboard'&&fixture.failCopy)throw new Error('Clipboard fixture rejected');
      if(command==='save_annotated_screenshot'){if(fixture.failSave)throw new Error('Save fixture rejected');return 'D:/DtKit/Screenshots/'+args.filename;}
      if(command==='recognize_screenshot_text'){if(fixture.failOcr)throw new Error('OCR language fixture unavailable');return {text:'DtKit 本地文字识别\n第二行内容'};}
      return null;
    }
    return invoke(command,args);
  };
  const listen=window.__TAURI__.event.listen;
  window.__TAURI__.event.listen=async(name,callback,...args)=>{
    const stop=await listen(name,callback,...args),unlisten=()=>{fixture.unlistened++;stop();};
    if(name==='screen-region-captured'&&new URL(location.href).searchParams.has('deferCaptureListen'))return new Promise(resolve=>fixture.pendingListen.push(()=>resolve(unlisten)));
    return unlisten;
  };
})();
"""


def errors_for(page, errors):
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)


def ready(frame):
    expect(frame.locator('.capture-shell')).to_be_visible()
    frame.wait_for_function('window.__DTKIT_TOOL_PAGE__?.ready === true')


def snapshot(frame):
    return frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')


def state(frame):
    return snapshot(frame)['state']


def document(frame):
    return state(frame)['document']


def flush(frame):
    return frame.evaluate('async()=>await window.__DTKIT_TOOL_PAGE__.flush()')


def image_fixture():
    image=Image.new('RGBA',(640,400));pixels=image.load()
    for y in range(400):
        for x in range(640):pixels[x,y]=((x*17+y*3)%256,(y*19+x*5)%256,(x*11+y*7)%256,255)
    output=io.BytesIO();image.save(output,format='PNG');return output.getvalue()


def upload(frame, data, name='pixel-pattern.png', mime='image/png', *, valid=True):
    frame.locator('#captureFile').set_input_files({'name':name,'mimeType':mime,'buffer':data})
    expect(frame.locator('.capture-shell')).to_have_attribute('data-busy','false')
    if mime.startswith('image/') and valid:
        expect(frame.locator('#captureCanvas')).to_be_visible()
        expect(frame.locator('#captureStatus')).to_contain_text(name)
        flush(frame)


def set_input(frame, selector, value):
    frame.locator(selector).evaluate('(node,value)=>{node.value=value;node.dispatchEvent(new Event("input",{bubbles:true}));node.dispatchEvent(new Event("change",{bubbles:true}));}',value)


def mode(frame, value):
    frame.locator(f'[data-capture-mode="{value}"]').click()
    expect(frame.locator(f'[data-capture-mode="{value}"]')).to_have_attribute('aria-pressed','true')


def source_point(frame,x,y):
    bounds=frame.locator('#captureOverlay').bounding_box()
    dimensions=frame.locator('#captureOverlay').evaluate('c=>[c.width,c.height]')
    current=state(frame);crop=current['document']['crop'] if current['mode']!='crop' else {'x':0,'y':0}
    return bounds['x']+(x-crop['x'])*bounds['width']/dimensions[0],bounds['y']+(y-crop['y'])*bounds['height']/dimensions[1]


def click_source(page,frame,x,y,*,double=False):
    point=source_point(frame,x,y)
    if double:page.mouse.dblclick(*point)
    else:page.mouse.click(*point)


def drag_source(page,frame,start,end,*,shift=False):
    first=source_point(frame,*start);last=source_point(frame,*end)
    if shift:page.keyboard.down('Shift')
    page.mouse.move(*first);page.mouse.down();page.mouse.move(*last,steps=6);page.mouse.up()
    if shift:page.keyboard.up('Shift')


def last_call(page,command):
    return page.evaluate('command=>window.__captureFixture.calls.findLast(call=>call.command===command)',command)


def exported_image(page,frame,*,copy=True):
    command='copy_screenshot_to_clipboard' if copy else 'save_annotated_screenshot'
    before=page.evaluate('command=>window.__captureFixture.calls.filter(c=>c.command===command).length',command)
    frame.locator('#captureCopy' if copy else '#captureSave').click()
    page.wait_for_function('({command,before})=>window.__captureFixture.calls.filter(c=>c.command===command).length>before',arg={'command':command,'before':before})
    expect(frame.locator('#captureStatus')).to_have_attribute('data-tone','success')
    data=last_call(page,command)['args']['dataUrl']
    return Image.open(io.BytesIO(base64.b64decode(data.split(',')[1]))).convert('RGBA')


def main_editor(context,base_url,errors):
    page=context.new_page();errors_for(page,errors);page.goto(base_url,wait_until='networkidle')
    page.locator('[data-tool-id="screenshot-annotator"] .tool-card__title').click()
    frame=multi.active_tool_frame(page,'.capture-shell');ready(frame)
    return page,frame


def test_workbench(context,base_url,errors):
    page,frame=main_editor(context,base_url,errors)
    assert not last_call(page,'start_screen_region_capture'),'Main editor should wait for an explicit capture'
    expect(frame.locator('#captureAgainLabel')).to_have_text('开始截图')
    original=image_fixture();upload(frame,original)
    first_asset=state(frame)['assetId'];assert first_asset
    upload(frame,b'not an image','invalid.txt','text/plain')
    expect(frame.locator('#captureStatus')).to_have_attribute('data-tone','error')
    assert state(frame)['assetId']==first_asset
    upload(frame,b'not a PNG','corrupt.png',valid=False)
    expect(frame.locator('#captureStatus')).to_have_attribute('data-tone','error')
    assert state(frame)['assetId']==first_asset
    upload(frame,original)

    mode(frame,'pen');drag_source(page,frame,(25,30),(110,45))
    assert document(frame)['objects'][-1]['type']=='pen'
    expect(frame.locator('#captureUndo')).to_be_enabled()
    click_source(page,frame,130,35)
    assert len(document(frame)['objects'][-1]['points'])==1

    frame.locator('#captureShapeOptionsTrigger').click();frame.locator('[data-shape-style="fill"]').click()
    mode(frame,'rect');drag_source(page,frame,(40,85),(130,140))
    shape=document(frame)['objects'][-1];assert shape['type']=='rect' and shape['fill']
    mode(frame,'select');drag_source(page,frame,(80,110),(110,125))
    moved=document(frame)['objects'][-1]
    assert abs(moved['x']-70)<1 and abs(moved['y']-100)<1,moved
    frame.locator('#captureUndo').click();assert abs(document(frame)['objects'][-1]['x']-40)<1
    frame.locator('#captureRedo').click();assert abs(document(frame)['objects'][-1]['x']-70)<1
    click_source(page,frame,100,120)
    drag_source(page,frame,(160,155),(190,175))
    resized=document(frame)['objects'][-1];assert resized['width']>115 and resized['height']>70,resized
    frame.locator('#captureDuplicate').click();assert len(document(frame)['objects'])==4
    frame.locator('#captureDelete').click();assert len(document(frame)['objects'])==3
    frame.locator('#captureUndo').click();assert len(document(frame)['objects'])==4
    frame.locator('#captureRedo').click();assert len(document(frame)['objects'])==3

    mode(frame,'text');click_source(page,frame,220,55)
    frame.locator('#captureInlineText').fill('重点说明\n第二行')
    expect(frame.locator('#captureInlineText')).to_have_value('重点说明\n第二行')
    assert frame.locator('#captureInlineText').evaluate('n=>parseFloat(getComputedStyle(n).lineHeight)')>0
    expect(frame.locator('#captureInlineText')).to_have_attribute('wrap','off')
    frame.locator('#captureInlineText').press_sequentially('!');expect(frame.locator('#captureInlineText')).to_have_value('重点说明\n第二行!')
    frame.locator('#captureInlineText').press('Backspace')
    draft=snapshot(frame)['state'];expect(frame.locator('#captureInlineText')).to_be_visible()
    assert len(draft['document']['objects'])==3,'Background autosnapshots must preserve inline text editing'
    assert draft['textEdit']['text']=='重点说明\n第二行',draft['textEdit']
    frame.locator('#captureInlineText').press('Enter')
    text=document(frame)['objects'][-1];assert text['text']=='重点说明\n第二行'
    mode(frame,'select');click_source(page,frame,230,65,double=True)
    expect(frame.locator('#captureInlineText')).to_be_visible()
    frame.locator('#captureInlineText').fill('修改后的文字');frame.locator('#captureInlineText').press('Enter')
    assert document(frame)['objects'][-1]['text']=='修改后的文字'
    click_source(page,frame,230,65,double=True);frame.locator('#captureInlineText').fill('取消此修改');frame.locator('#captureInlineText').press('Escape')
    assert document(frame)['objects'][-1]['text']=='修改后的文字'
    click_source(page,frame,230,65)
    text=document(frame)['objects'][-1]
    corner=(text['x']+text['width'],text['y']+text['height'])
    drag_source(page,frame,corner,(corner[0]+text['width']*.5,corner[1]+text['height']*.5))
    resized_text=document(frame)['objects'][-1]
    assert resized_text['fontSize']>text['fontSize'] and resized_text['width']>text['width'],'Text handles should resize the rendered glyphs and their bounds together'

    mode(frame,'highlight');drag_source(page,frame,(220,150),(360,180))
    mode(frame,'step');click_source(page,frame,420,75);click_source(page,frame,470,75)
    assert [o['number'] for o in document(frame)['objects'] if o['type']=='step']==[1,2]
    mode(frame,'mosaic');drag_source(page,frame,(360,210),(520,300))
    mode(frame,'select');click_source(page,frame,400,250);set_input(frame,'#captureSize','8')
    mosaic=document(frame)['objects'][-1];assert mosaic['type']=='mosaic' and mosaic['pixelSize']==24
    mode(frame,'redact');set_input(frame,'#captureColor','#1c1c1e');drag_source(page,frame,(40,245),(180,310))
    mode(frame,'select');click_source(page,frame,90,275)
    before=document(frame)
    exported=exported_image(page,frame)
    assert exported.size==(640,400)
    assert exported.getpixel((90,275))==(28,28,30,255),'Opaque redaction must replace source pixels'
    # The privacy mask is rasterized into the output; the selectable editor outline is separate.
    base=frame.locator('#captureCanvas').evaluate('c=>c.toDataURL("image/png")')
    base_image=Image.open(io.BytesIO(base64.b64decode(base.split(',')[1]))).convert('RGBA')
    assert exported.tobytes()==base_image.tobytes(),'Selection handles leaked into exported PNG'
    original_image=Image.open(io.BytesIO(original)).convert('RGBA')
    assert exported.getpixel((370,220))!=original_image.getpixel((370,220))
    assert exported.getpixel((370,220))==exported.getpixel((371,220)),'Mosaic should contain actual low-resolution blocks'
    assert document(frame)==before,'Export must retain editable selection and annotations'
    saved=exported_image(page,frame,copy=False);assert saved.tobytes()==exported.tobytes()

    page.evaluate('window.__captureFixture.failCopy=true');frame.locator('#captureCopy').click()
    expect(frame.locator('#captureStatus')).to_have_attribute('data-tone','error');expect(frame.locator('#captureCopy')).to_be_enabled()
    page.evaluate('window.__captureFixture.failCopy=false;window.__captureFixture.failSave=true');frame.locator('#captureSave').click()
    expect(frame.locator('#captureStatus')).to_have_attribute('data-tone','error');expect(frame.locator('#captureSave')).to_be_enabled()
    page.evaluate('window.__captureFixture.failSave=false')
    frame.locator('#captureOcr').click();expect(frame.locator('#captureOcrText')).to_have_value('DtKit 本地文字识别\n第二行内容')
    frame.locator('#captureOcrText').fill('可编辑的识别结果');frame.locator('#captureOcrCopy').click()
    page.wait_for_function('window.__captureFixture.textCopies.at(-1)==="可编辑的识别结果"')
    frame.locator('#captureOcrClose').click();page.evaluate('window.__captureFixture.failOcr=true');frame.locator('#captureOcr').click()
    expect(frame.locator('#captureStatus')).to_have_attribute('data-tone','error');expect(frame.locator('#captureOcr')).to_be_enabled()
    expect(frame.locator('#captureOcrPanel')).to_be_hidden();page.evaluate('window.__captureFixture.failOcr=false')

    mode(frame,'crop');expect(frame.locator('#captureCopy')).to_be_disabled();expect(frame.locator('#captureOcr')).to_be_disabled()
    copies=page.evaluate('window.__captureFixture.calls.filter(c=>c.command==="copy_screenshot_to_clipboard").length')
    frame.locator('#captureStage').focus();page.keyboard.press('Control+c')
    assert page.evaluate('window.__captureFixture.calls.filter(c=>c.command==="copy_screenshot_to_clipboard").length')==copies
    drag_source(page,frame,(120,60),(520,340));frame.locator('#captureCropApply').click()
    assert document(frame)['crop']=={'x':120,'y':60,'width':400,'height':280}
    expect(frame.locator('#captureCanvas')).to_have_attribute('width','400')
    frame.locator('#captureUndo').click();assert document(frame)['crop']['width']==640
    frame.locator('#captureRedo').click();assert document(frame)['crop']['width']==400
    crop_one=exported_image(page,frame)
    assert crop_one.size==(400,280)
    assert crop_one.getpixel((10,210))==(28,28,30,255),'Cropped redaction must remain aligned to the original source'
    assert crop_one.getpixel((100,100))==exported.getpixel((220,160)),'Crop pixel origin must match the selected source rectangle'
    frame.locator('#captureCanvasTrigger').click();set_input(frame,'#captureCornerRadius','28');frame.locator('#captureExportScale').select_option('2')
    frame.locator('#captureCanvasTrigger').click()
    cropped=exported_image(page,frame);assert cropped.size==(800,560);assert cropped.getpixel((0,0))[3]==0;assert cropped.getpixel((400,280))[3]==255
    frame.locator('#captureStage').focus();page.keyboard.press('o');expect(frame.locator('[data-capture-mode="ellipse"]')).to_have_attribute('aria-pressed','true')
    mode(frame,'arrow');drag_source(page,frame,(200,220),(280,255),shift=True)
    arrow=document(frame)['objects'][-1];assert abs(abs(arrow['x2']-arrow['x'])-abs(arrow['y2']-arrow['y']))<1 or abs(arrow['y2']-arrow['y'])<1
    page.screenshot(path=str(SCREENSHOTS/'screenshot-desktop.png'),full_page=True)

    for _ in range(5):frame.locator('#captureZoomIn').click()
    frame.wait_for_timeout(220)
    initial=frame.locator('#captureStage').evaluate('n=>({left:n.scrollLeft,top:n.scrollTop})')
    stage=frame.locator('#captureStage').bounding_box();frame.locator('#captureStage').focus();page.keyboard.down('Space')
    page.mouse.move(stage['x']+stage['width']/2,stage['y']+stage['height']/2);page.mouse.down();page.mouse.move(stage['x']+stage['width']/2-75,stage['y']+stage['height']/2-40,steps=5);page.mouse.up();page.keyboard.up('Space')
    after=frame.locator('#captureStage').evaluate('n=>({left:n.scrollLeft,top:n.scrollTop})')
    assert after!=initial,{'before':initial,'after':after}
    zoom=frame.locator('#captureZoomValue').inner_text();page.keyboard.down('Control');page.mouse.wheel(0,-150);page.keyboard.up('Control')
    expect(frame.locator('#captureZoomValue')).not_to_have_text(zoom)
    frame.locator('#captureZoomFit').click()
    for width in [680,390]:
        page.set_viewport_size({'width':page.evaluate('innerWidth')+width-frame.evaluate('innerWidth'),'height':1000})
        frame.wait_for_function('width=>innerWidth===width',arg=width)
        frame.evaluate('async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);}')
        metrics=frame.evaluate('()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,tool:document.querySelector(".capture-shell").scrollWidth,width:document.querySelector(".capture-shell").clientWidth})')
        assert metrics['document']<=metrics['viewport']+1 and metrics['tool']<=metrics['width']+1,metrics
        page.screenshot(path=str(SCREENSHOTS/f'screenshot-embedded-{width}.png'),full_page=True)
    page.close()


def emit_capture(page,request,*,cancelled=False,**extra):
    payload={**request,'cancelled':cancelled,**extra}
    page.evaluate('payload=>window.__captureFixture.emit({...payload,...(!payload.cancelled?{capture:{dataUrl:window.__captureFixture.image(),width:640,height:400}}:{})})',payload)


def test_capture(context,base_url,errors):
    page=context.new_page();errors_for(page,errors);page.goto(base_url+'/quick.html?kind=tool&toolId=screenshot-annotator',wait_until='networkidle');ready(page)
    request=last_call(page,'start_screen_region_capture')['args']
    assert request['requestId'] and 'instanceId' in request
    assert request.get('keepHidden') is True, 'Screenshot capture must leave DtKit windows hidden until the user returns'
    expect(page.locator('#captureAgain')).to_be_disabled()
    emit_capture(page,request,requestId='stale-request');emit_capture(page,request,instanceId='other-page')
    expect(page.locator('#captureAgain')).to_be_disabled();expect(page.locator('#captureViewport')).to_be_hidden()
    emit_capture(page,request);expect(page.locator('#captureCanvas')).to_be_visible();expect(page.locator('#captureAgain')).to_be_enabled()
    assert document(page)['crop']['width']==640
    before=state(page)['assetId']
    page.locator('#captureAgain').click();request=last_call(page,'start_screen_region_capture')['args']
    page.locator('#captureStage').focus();page.keyboard.press('Escape');expect(page.locator('#captureAgain')).to_be_enabled()
    assert last_call(page,'cancel_screen_region_capture')['args']['requestId']==request['requestId']
    assert state(page)['assetId']==before
    page.locator('#captureOptionsTrigger').click();page.locator('#captureDelay').select_option('5');page.locator('#captureOptionsTrigger').click()
    page.locator('#captureAgain').click();request=last_call(page,'start_screen_region_capture')['args'];assert request['delayMs']==5000
    emit_capture(page,request,cancelled=True);expect(page.locator('#captureStatus')).to_contain_text('取消')
    page.locator('#captureOptionsTrigger').click();page.locator('#captureLong').click();page.locator('[data-long-direction="horizontal"]').click();page.locator('#captureLongSegments').fill('5');page.locator('#captureLongStart').click()
    request=last_call(page,'start_screen_region_capture')['args'];assert request['longDirection']=='horizontal' and request['maxSegments']==5
    assert request['longMode']=='manual', 'The default long capture must let the user scroll'
    emit_capture(page,request);expect(page.locator('#captureStatus')).to_contain_text('长截图.png')
    page.locator('#captureOptionsTrigger').click();page.locator('#captureLong').click()
    page.locator('#captureLongMode').select_option('automatic')
    expect(page.locator('#captureLongNote')).to_contain_text('自动滚动')
    page.locator('#captureLongStart').click();request=last_call(page,'start_screen_region_capture')['args']
    assert request['longMode']=='automatic' and request['keepHidden'] is True
    emit_capture(page,request,cancelled=True)
    page.set_viewport_size({'width':390,'height':850});page.screenshot(path=str(SCREENSHOTS/'screenshot-quick-390.png'),full_page=True)
    page.locator('#captureAgain').click();request=last_call(page,'start_screen_region_capture')['args']
    page.evaluate('async()=>await window.__DTKIT_TOOL_PAGE__.dispose()')
    assert last_call(page,'cancel_screen_region_capture')['args']['requestId']==request['requestId']
    assert page.evaluate('window.__multiListeners["screen-region-captured"]?.size||0')==0
    emit_capture(page,request);assert page.locator('#captureCanvas').get_attribute('width')=='1'
    page.close()


def test_persistence(context,base_url,errors):
    page,first=main_editor(context,base_url,errors);upload(first,image_fixture(),'tab-A.png')
    mode(first,'step');click_source(page,first,100,100);flush(first)
    first_snapshot=snapshot(first);tab_a=multi.active_tab_id(page)
    assert len(str(first_snapshot))<2_000_000
    multi.click_page_action(page,'new');second=multi.active_tool_frame(page,'.capture-shell');ready(second);tab_b=multi.active_tab_id(page)
    assert state(second)['assetId'] is None
    shared={**first_snapshot,'instanceId':snapshot(second)['instanceId']}
    second.evaluate('async value=>await window.__DTKIT_TOOL_PAGE__.restore(value)',shared)
    expect(second.locator('#captureStatus')).to_contain_text('tab-A.png');assert len(document(second)['objects'])==1
    second.locator('#captureCanvasTrigger').click();second.locator('#captureClear').click();upload(second,image_fixture(),'tab-B.png')
    multi.switch_tab(page,tab_a);first=multi.active_tool_frame(page,'.capture-shell')
    assert state(first)['assetId']==first_snapshot['state']['assetId'];assert len(document(first)['objects'])==1
    # Rich image pages keep their live assets while the bounded cache also supports journal reload.
    flush(first);assert page.evaluate('window.__DTKIT_TOOL_WORKSPACE__.persist({prepareSleep:true})') is False
    page.reload(wait_until='networkidle');restored=multi.active_tool_frame(page,'.capture-shell');ready(restored)
    expect(restored.locator('#captureCanvas')).to_be_visible();assert state(restored)['assetId']==first_snapshot['state']['assetId'];assert len(document(restored)['objects'])==1
    multi.switch_tab(page,tab_b);second=multi.active_tool_frame(page,'.capture-shell');expect(second.locator('#captureStatus')).to_contain_text('tab-B.png')
    assert len(document(second)['objects'])==0
    page.close()


def test_late_listener(context,base_url,errors):
    page=context.new_page();errors_for(page,errors);page.goto(base_url+'/quick.html?kind=tool&toolId=screenshot-annotator&deferCaptureListen=1',wait_until='networkidle')
    page.wait_for_function('window.__captureFixture.pendingListen.length===1')
    page.evaluate('()=>{window.__captureDisposal=window.__DTKIT_TOOL_PAGE__.dispose();window.__captureFixture.pendingListen.shift()();}')
    page.evaluate('async()=>await window.__captureDisposal')
    assert page.evaluate('window.__multiListeners["screen-region-captured"]?.size||0')==0
    assert page.evaluate('window.__captureFixture.unlistened')>=1
    assert not last_call(page,'start_screen_region_capture')


def test_overlay_long_modes(context,base_url,errors):
    for initial,selected,direction in [('manual','automatic','vertical'),('automatic','manual','horizontal')]:
        page=context.new_page();errors_for(page,errors)
        page.add_init_script(r"""(() => {
          window.__overlayCalls=[];
          window.__TAURI__.core.invoke=async(command,args={})=>{
            window.__overlayCalls.push({command,args});
            if(command==='get_screen_region_capture')return {dataUrl:window.__captureFixture.image(),width:640,height:400,x:0,y:0,
              longMode:new URL(location.href).searchParams.get('fixtureMode')};
            return null;
          };
        })();""")
        page.goto(base_url+'/screen-region.html?fixtureMode='+initial,wait_until='networkidle')
        expect(page.locator('#regionLoading')).to_be_hidden()
        page.mouse.move(100,80);page.mouse.down();page.mouse.move(500,340);page.mouse.up()
        page.locator('#regionLong').click();expect(page.locator('#regionLongMenu')).to_be_visible()
        expect(page.locator('#regionLongMode')).to_have_value(initial)
        page.locator('#regionLongMode').select_option(selected)
        page.locator(f'[data-region-long-direction="{direction}"]').click()
        page.wait_for_function('window.__overlayCalls.some(call=>call.command==="finish_screen_region_capture")')
        args=page.evaluate('window.__overlayCalls.find(call=>call.command==="finish_screen_region_capture").args')
        assert args['longMode']==selected and args['longDirection']==direction and args['dataUrl'] is None,args
        page.close()
    page.close()


def test_import_lifecycle(context,base_url,errors):
    page,frame=main_editor(context,base_url,errors)
    data=base64.b64encode(image_fixture()).decode('ascii')
    for kind,name in [('paste','pasted-image.png'),('drop','dropped-image.png')]:
        frame.evaluate('''({data,kind,name})=>{
          const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0)),file=new File([bytes],name,{type:'image/png'}),transfer=new DataTransfer();transfer.items.add(file);
          if(kind==='paste')document.querySelector('#captureStage').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true}));
          else {const root=document.querySelector('.capture-shell');root.dispatchEvent(new DragEvent('dragover',{dataTransfer:transfer,bubbles:true,cancelable:true}));
            if(!root.classList.contains('is-dragover'))throw new Error('Image drop target did not activate');root.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));}
        }''',{'data':data,'kind':kind,'name':name})
        expect(frame.locator('#captureStatus')).to_contain_text(name);flush(frame)
        assert state(frame)['imageName']==name
        assert not frame.locator('.capture-shell').evaluate('n=>n.classList.contains("is-dragover")')
    old=flush(frame)
    frame.evaluate('''()=>{
      const get=IDBObjectStore.prototype.get;window.__capturePendingReads=[];
      IDBObjectStore.prototype.get=function(...args){const request=get.apply(this,args);if(this.name!=='images')return request;
        let callback=null;Object.defineProperty(request,'onsuccess',{configurable:true,get:()=>callback,set:value=>{
          callback=value;request.addEventListener('success',event=>window.__capturePendingReads.push(()=>value.call(request,event)),{once:true});
        }});return request;};
    }''')
    frame.evaluate('value=>{window.__captureRestoring=window.__DTKIT_TOOL_PAGE__.restore(value);}',old)
    frame.wait_for_function('window.__capturePendingReads.length===1')
    upload(frame,image_fixture(),'fresh-import.png')
    frame.evaluate('async()=>{for(const read of window.__capturePendingReads.splice(0))read();await window.__captureRestoring;}')
    assert state(frame)['imageName']=='fresh-import.png','A slow cache restore must not replace a newly imported image'
    page.close()


def new_context(browser,base_url):
    context=browser.new_context(viewport={'width':1440,'height':1000},reduced_motion='reduce')
    context.add_init_script(multi.MOCK+'\n'+INSTRUMENTATION)
    def csp(route):
        response=route.fetch();headers=dict(response.headers)
        if 'text/html' in headers.get('content-type',''):headers['content-security-policy']=multi.CSP
        route.fulfill(response=response,headers=headers)
    context.route(base_url+'/**',csp)
    return context


def run(base_url, selected=None):
    SCREENSHOTS.mkdir(parents=True,exist_ok=True);errors=[]
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True)
        try:
            for key,label,case in [('workbench','editing, privacy pixels, crop, export, failures, OCR, pan and responsive layout',test_workbench),('capture','native request routing, delay, long capture and cancellation lifecycle',test_capture),('overlay-long','selection toolbar manual and automatic long-capture modes',test_overlay_long_modes),('persistence','independent pages, shared image assets and workspace reload',test_persistence),('late-listener','late native listener is released after disposal',test_late_listener),('imports','image paste/drop and slow cache restore cannot replace fresh imports',test_import_lifecycle)]:
                if selected and key!=selected:continue
                print('Screenshot UI: '+label,flush=True);context=new_context(browser,base_url)
                try:
                    start=len(errors);case(context,base_url,errors);assert not errors[start:],errors[start:]
                except Exception:
                    for index,page in enumerate(context.pages):page.screenshot(path=str(SCREENSHOTS/f'screenshot-failure-{index}.png'),full_page=True)
                    raise
                finally:context.close()
        finally:browser.close()
    assert not errors,errors
    print(f'Screenshot production UI smoke passed; screenshots={SCREENSHOTS}')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--case',choices=['workbench','capture','overlay-long','persistence','late-listener','imports']);args=parser.parse_args()
    with multi.production_url() as base_url:run(base_url,args.case)
