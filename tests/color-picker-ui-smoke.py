"""Production color workbench regression with real canvas, workers and IndexedDB.

Native screen capture is mocked; no desktop capture or native setting is changed.
Build first, or set DTKIT_TEST_BASE_URL to a production preview server.
"""
import base64
import importlib.util
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi_page', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
SCREENSHOTS = multi.ROOT / '.tmp' / 'color-review'

INSTRUMENTATION = r"""
(() => {
  const fixture=window.__colorFixture={copies:[],failCopy:false,calls:[],workers:[],pendingDecode:[],deferDecode:false,pendingListen:[],unlistened:0,eyeCalls:0,eyeAborted:0};
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker {
    constructor(...args){super(...args);const record={url:String(args[0]),terminated:false,messages:0};fixture.workers.push(record);
      this.addEventListener('message',()=>record.messages++);const terminate=this.terminate.bind(this);
      this.terminate=()=>{record.terminated=true;return terminate();};}
  };
  const decode=HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode=function(...args){const promise=decode.apply(this,args);return fixture.deferDecode
    ?promise.then(()=>new Promise(resolve=>fixture.pendingDecode.push(resolve))):promise;};
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
    if(fixture.failCopy)throw new Error('Clipboard fixture rejected');fixture.copies.push(text);
  }}});
  if(window!==window.top)return;
  fixture.emit=payload=>{for(const listener of window.__multiListeners['screen-color-picked']||[])listener({payload});};
  const invoke=window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke=async(command,args={})=>{
    if(['start_screen_color_pick','cancel_screen_color_pick'].includes(command)){
      if(typeof args.requestId!=='string'||!args.requestId||!Object.hasOwn(args,'instanceId'))throw new Error('Invalid screen pick contract');
      fixture.calls.push({command,args:structuredClone(args)});return null;
    }
    return invoke(command,args);
  };
  const listen=window.__TAURI__.event.listen;
  window.__TAURI__.event.listen=async(name,callback,...args)=>{
    const stop=await listen(name,callback,...args);
    const unlisten=()=>{fixture.unlistened++;stop();};
    if(name==='screen-color-picked'&&new URL(location.href).searchParams.has('deferColorListen'))return new Promise(resolve=>fixture.pendingListen.push(()=>resolve(unlisten)));
    return unlisten;
  };
})();
"""


def errors_for(page, errors):
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)


def ready(frame):
    expect(frame.locator('#hexInput')).to_be_visible()
    frame.wait_for_function('window.__DTKIT_TOOL_PAGE__?.ready === true')


def snapshot(frame):
    return frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')


def set_color(frame, value, field='hexInput'):
    frame.locator('#'+field).fill(value)
    frame.locator('#'+field).press('Enter')


def set_input(frame, selector, value):
    frame.locator(selector).evaluate('(node,value)=>{node.value=value;node.dispatchEvent(new Event("input",{bubbles:true}));node.dispatchEvent(new Event("change",{bubbles:true}));}', value)


def wait_motion(frame):
    frame.evaluate('async()=>{await Promise.all(document.querySelector(".color-picker-view").getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);}')


def source_tab(frame, mode):
    frame.locator(f'[data-color-tab="{mode}"]').click()
    wait_motion(frame)


def library_tab(frame, mode):
    frame.locator(f'[data-color-library="{mode}"]').click()
    wait_motion(frame)


def assert_segments(frame):
    frame.wait_for_function('''()=>[...document.querySelectorAll('.color-segmented')].every(group=>{
      const chosen=group.querySelector('button[aria-selected="true"]'),indicator=group.querySelector('.tool-segment-indicator');
      if(!chosen||!indicator)return false;const a=chosen.getBoundingClientRect(),b=indicator.getBoundingClientRect();
      return Math.abs(a.left-b.left)<1.5&&Math.abs(a.top-b.top)<1.5&&Math.abs(a.width-b.width)<1.5&&Math.abs(a.height-b.height)<1.5;
    })''')


def png_image(frame, kind='quadrants'):
    value = frame.evaluate('''kind=>{
      const c=document.createElement('canvas');c.width=kind==='large'?1601:80;c.height=kind==='large'?997:80;const ctx=c.getContext('2d');
      if(kind==='quadrants'){
        for(const [x,y,color] of [[0,0,'#FF0000'],[40,0,'#00FF00'],[0,40,'rgba(0,0,255,0.5)'],[40,40,'#FFFFFF']]){ctx.fillStyle=color;ctx.fillRect(x,y,40,40);}
      }else if(kind==='blue'){ctx.fillStyle='#0000FF';ctx.fillRect(0,0,80,80);}
      else if(kind==='red'){ctx.fillStyle='#FF0000';ctx.fillRect(0,0,80,80);}
      else if(kind==='large'){const data=ctx.createImageData(c.width,c.height);for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
        const index=(y*c.width+x)*4;data.data[index]=x%256;data.data[index+1]=y%256;data.data[index+2]=123;data.data[index+3]=255;
      }ctx.putImageData(data,0,0);}
      return c.toDataURL('image/png').split(',')[1];
    }''', kind)
    return base64.b64decode(value)


def upload(frame, data, name='quadrants.png'):
    frame.locator('#colorFileInput').set_input_files({'name':name,'mimeType':'image/png','buffer':data})
    expect(frame.locator('#colorImageName')).to_have_text(name)
    expect(frame.locator('#colorImageStage')).to_have_attribute('aria-busy', 'false')
    expect(frame.locator('#colorImageStatus')).to_have_attribute('data-tone', 'success')
    wait_motion(frame)


def click_pixel(page, frame, x, y, source_dimensions=None):
    rect = frame.locator('#colorImageCanvas').bounding_box()
    dimensions = frame.locator('#colorImageCanvas').evaluate('canvas=>[canvas.width,canvas.height]')
    scale = min(rect['width']/dimensions[0], rect['height']/dimensions[1])
    left = rect['x']+(rect['width']-dimensions[0]*scale)/2
    top = rect['y']+(rect['height']-dimensions[1]*scale)/2
    source_dimensions = source_dimensions or dimensions
    page.mouse.click(left+(x+.5)*dimensions[0]/source_dimensions[0]*scale, top+(y+.5)*dimensions[1]/source_dimensions[1]*scale)


def exercise_formats(page, frame):
    set_color(frame, '#F08C')
    expect(frame.locator('#hexInput')).to_have_value('#FF0088CC')
    expect(frame.locator('#rgbaInput')).to_have_value('rgba(255, 0, 136, 0.8)')
    set_color(frame, 'rgb(100% 50% 0% / 25%)', 'rgbInput')
    expect(frame.locator('#hexInput')).to_have_value('#FF800040')
    set_color(frame, 'hsla(.5turn 100% 50% / .5)', 'hslInput')
    expect(frame.locator('#hexInput')).to_have_value('#00FFFF80')
    set_color(frame, 'rgba(10, 20, 30, .125)', 'rgbaInput')
    expect(frame.locator('#hexInput')).to_have_value('#0A141E20')
    before = snapshot(frame)['state']['color']
    frame.locator('#hslInput').fill('hsl(20, unfinished)')
    expect(frame.locator('#hslInput')).to_have_attribute('aria-invalid','true')
    expect(frame.locator('#copyHsl')).to_be_disabled()
    assert snapshot(frame)['state']['color'] == before
    frame.locator('#hslInput').press('Escape')
    expect(frame.locator('#copyHsl')).to_be_enabled()
    assert frame.locator('#hslInput').get_attribute('aria-invalid') is None
    for field, button in [('hexInput','copyHex'),('rgbInput','copyRgb'),('hslInput','copyHsl'),('rgbaInput','copyRgba')]:
        expected = frame.locator('#'+field).input_value()
        frame.locator('#'+button).click()
        expect(frame.locator('#colorStatus')).to_have_attribute('data-tone','success')
        assert page.evaluate('window.__colorFixture.copies.at(-1)') == expected
    page.evaluate('window.__colorFixture.failCopy=true')
    frame.locator('#copyHex').click()
    expect(frame.locator('#colorStatus')).to_have_attribute('data-tone','error')
    expect(frame.locator('#copyHex')).to_be_enabled()
    page.evaluate('window.__colorFixture.failCopy=false')
    set_color(frame, '#FF0000')
    set_input(frame, '#colorHue','360')
    assert snapshot(frame)['state']['hue'] == 360
    expect(frame.locator('#hexInput')).to_have_value('#FF0000')
    frame.locator('#colorSaturation').press('Home')
    expect(frame.locator('#hexInput')).to_have_value('#FFFFFF')
    frame.locator('#colorSaturation').press('End')
    expect(frame.locator('#hexInput')).to_have_value('#FF0000')
    set_input(frame, '#colorAlpha','50')
    expect(frame.locator('#hexInput')).to_have_value('#FF000080')
    expect(frame.locator('#colorPreviewAlpha')).to_have_text('50% 不透明')
    set_color(frame, '#777777')
    expect(frame.locator('#colorContrastValue')).to_have_text('4.48:1')
    expect(frame.locator('#colorContrastText')).to_contain_text('大号')
    set_color(frame, '#000000')
    expect(frame.locator('#colorContrastValue')).to_have_text('21.00:1')
    set_input(frame, '#colorContrastInput','#000000')
    expect(frame.locator('#colorContrastValue')).to_have_text('1.00:1')
    set_input(frame, '#colorContrastInput','#ffffff')
    assert frame.locator('#colorShades button').count() == 9
    frame.locator('#colorShades button').nth(3).click()
    expect(frame.locator('#hexInput')).to_have_value(frame.locator('#colorShades button').nth(3).get_attribute('data-color'))


def exercise_library(page, frame):
    set_color(frame, '#123456')
    frame.locator('#colorSave').click()
    expect(frame.locator('#colorSave')).to_have_attribute('aria-pressed','true')
    library_tab(frame,'saved')
    expect(frame.locator('#savedColors [data-color="#123456"]')).to_be_visible()
    for mode in ['css','json','text']:
        frame.locator('#colorExportFormat').select_option(mode)
        frame.locator('#colorCopyPalette').click()
        expect(frame.locator('#colorStatus')).to_have_attribute('data-tone','success')
        copied = page.evaluate('window.__colorFixture.copies.at(-1)')
        assert '#123456' in copied
        if mode == 'css': assert '--color-' in copied
        if mode == 'json': assert copied.startswith('[')
    library_tab(frame,'presets')
    assert frame.locator('#colorPresets button').count() >= 16
    frame.locator('#colorPresets button').first.click()
    library_tab(frame,'recent')
    assert frame.locator('#recentColors button').count() <= 12
    assert_segments(frame)


def exercise_motion(page, frame):
    page.emulate_media(reduced_motion='no-preference')
    result = frame.evaluate('''()=>{
      document.querySelector('[data-color-tab="image"]').click();
      const incoming=document.querySelector('#colorImagePanel'),outgoing=document.querySelector('#colorStudioPanel');
      const running=document.querySelector('#colorSourcePanels').getAnimations({subtree:true});
      for(const animation of running)animation.currentTime=70;
      return {count:running.length,opacity:Number(getComputedStyle(incoming).opacity),outgoingVisible:!outgoing.hidden,outgoingInert:outgoing.inert,incomingInert:incoming.inert};
    }''')
    assert result['count'] >= 2 and 0 < result['opacity'] < 1, result
    assert result['outgoingVisible'] and result['outgoingInert'] and not result['incomingInert'], result
    frame.evaluate('''()=>{for(const key of ['studio','image','studio','image','studio'])document.querySelector('[data-color-tab="'+key+'"]').click();}''')
    wait_motion(frame)
    expect(frame.locator('#colorStudioPanel')).to_be_visible()
    expect(frame.locator('#colorImagePanel')).to_be_hidden()
    assert_segments(frame)
    result = frame.evaluate('''()=>{
      document.querySelector('[data-color-library="presets"]').click();
      const animations=document.querySelector('#colorLibraryPanels').getAnimations({subtree:true});
      for(const animation of animations)animation.currentTime=70;
      return {count:animations.length,opacity:Number(getComputedStyle(document.querySelector('#colorPresetsPanel')).opacity)};
    }''')
    assert result['count'] >= 2 and 0 < result['opacity'] < 1, result
    page.emulate_media(reduced_motion='reduce')
    wait_motion(frame)
    assert frame.locator('#colorRecentPanel').evaluate('node=>node.hidden&&node.inert')
    library_tab(frame,'saved')
    assert frame.evaluate('document.querySelector("#colorLibraryPanels").getAnimations({subtree:true}).length') == 0
    assert_segments(frame)


def exercise_image(page, frame):
    image = png_image(frame)
    upload(frame,image)
    palette = frame.locator('#colorImagePalette button').evaluate_all('nodes=>nodes.map(node=>({color:node.dataset.color,title:node.title}))')
    assert {item['color'] for item in palette} == {'#FF0000','#00FF00','#0000FF','#FFFFFF'}, palette
    weights = {item['color']:int(item['title'].split(' · ')[1][:-1]) for item in palette}
    assert weights['#0000FF'] in (14,15) and weights['#FF0000'] in (28,29), weights
    assert frame.evaluate('window.__colorFixture.workers.some(worker=>worker.messages>0&&worker.terminated)')
    for x,y,value in [(10,10,'#FF0000'),(60,10,'#00FF00'),(10,60,'#0000FF80'),(60,60,'#FFFFFF')]:
        click_pixel(page,frame,x,y)
        expect(frame.locator('#hexInput')).to_have_value(value)
        expect(frame.locator('#colorImageMarker')).to_be_visible()
    expect(frame.locator('#colorImageLoupe')).to_be_visible()
    frame.locator('#colorImageCanvas').press('ArrowLeft')
    frame.locator('#colorImageCanvas').press('Enter')
    state = frame.evaluate('async()=>{await window.__DTKIT_TOOL_PAGE__.flush();return window.__DTKIT_TOOL_PAGE__.snapshot();}')
    assert state['state']['image']['assetId'] and state['state']['image']['point'] == {'x':59,'y':60}, state['state']['image']
    # The canvas includes object-fit letterboxing. Empty space must not reuse
    # a previously hovered pixel or replace the last committed selection.
    rect = frame.locator('#colorImageCanvas').bounding_box()
    scale = min(rect['width']/80,rect['height']/80)
    content_left = rect['x']+(rect['width']-80*scale)/2
    content_top = rect['y']+(rect['height']-80*scale)/2
    assert content_left-rect['x'] > 4,rect
    previous_color = frame.locator('#hexInput').input_value()
    page.mouse.move(content_left+10.5*scale,content_top+10.5*scale)
    expect(frame.locator('#colorLoupeValue')).to_have_text('#FF0000')
    page.mouse.click(rect['x']+2,rect['y']+rect['height']/2)
    expect(frame.locator('#hexInput')).to_have_value(previous_color)
    assert snapshot(frame)['state']['image']['point'] == {'x':59,'y':60}
    frame.locator('#colorFileInput').set_input_files({'name':'broken.png','mimeType':'image/png','buffer':b'not a PNG'})
    expect(frame.locator('#colorImageStatus')).to_have_attribute('data-tone','error')
    expect(frame.locator('#colorImageName')).to_have_text('quadrants.png')
    click_pixel(page,frame,10,60)
    expect(frame.locator('#hexInput')).to_have_value('#0000FF80')
    frame.locator('#colorFileInput').set_input_files({'name':'script.txt','mimeType':'text/plain','buffer':b'not image'})
    expect(frame.locator('#colorImageStatus')).to_have_attribute('data-tone','error')
    expect(frame.locator('#colorImageName')).to_have_text('quadrants.png')
    # A slow first decode cannot overwrite a newer successfully decoded image.
    red = png_image(frame,'red'); blue = png_image(frame,'blue')
    frame.evaluate('window.__colorFixture.deferDecode=true')
    frame.locator('#colorFileInput').set_input_files({'name':'old-red.png','mimeType':'image/png','buffer':red})
    frame.wait_for_function('window.__colorFixture.pendingDecode.length===1')
    frame.evaluate('window.__colorFixture.deferDecode=false')
    upload(frame,blue,'new-blue.png')
    frame.evaluate('()=>{for(const resolve of window.__colorFixture.pendingDecode.splice(0))resolve();}')
    expect(frame.locator('#colorImageName')).to_have_text('new-blue.png')
    click_pixel(page,frame,10,10)
    expect(frame.locator('#hexInput')).to_have_value('#0000FF')
    upload(frame,png_image(frame,'transparent'),'transparent.png')
    assert frame.locator('#colorImagePalette button').count() == 0
    expect(frame.locator('#colorImageStatus')).to_contain_text('透明')
    click_pixel(page,frame,10,10)
    expect(frame.locator('#hexInput')).to_have_value('#00000000')
    frame.locator('#colorImageClear').click()
    expect(frame.locator('#colorImageStage')).to_be_hidden()
    expect(frame.locator('#colorDropZone')).to_be_visible()
    assert snapshot(frame)['state']['image'] is None
    upload(frame,png_image(frame,'large'),'large-pixel-map.png')
    assert frame.locator('#colorImageCanvas').evaluate('canvas=>canvas.width') == 1400
    for x,y,value in [(800,498,'#20F27B'),(1600,996,'#40E47B'),(0,0,'#00007B')]:
        click_pixel(page,frame,x,y,(1601,997))
        expect(frame.locator('#hexInput')).to_have_value(value)
        assert snapshot(frame)['state']['image']['point'] == {'x':x,'y':y}
    upload(frame,image,'persisted.png')
    click_pixel(page,frame,10,60)
    frame.evaluate('async()=>{await window.__DTKIT_TOOL_PAGE__.flush();}')
    return image


def exercise_layout(page, frame, label):
    source_tab(frame,'studio')
    for width in [680,390]:
        page.set_viewport_size({'width':page.evaluate('innerWidth')+width-frame.evaluate('innerWidth'),'height':1000})
        frame.wait_for_function('width=>innerWidth===width',arg=width)
        metrics = frame.evaluate('''()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,
          tool:document.querySelector('.color-picker-container').scrollWidth,width:document.querySelector('.color-picker-container').clientWidth})''')
        assert metrics['document'] <= metrics['viewport']+1 and metrics['tool'] <= metrics['width']+1, metrics
        assert_segments(frame)
        page.screenshot(path=str(SCREENSHOTS/f'color-{label}-{width}.png'),full_page=True)
    page.emulate_media(color_scheme='dark',reduced_motion='reduce')
    expect(frame.locator('.color-picker-view')).to_have_css('color-scheme','dark')
    expect(frame.locator('#colorSave')).to_have_css('transition-duration','0s')
    page.screenshot(path=str(SCREENSHOTS/f'color-{label}-dark.png'),full_page=True)


def test_quick(context, base_url, errors):
    page=context.new_page();errors_for(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=color-picker',wait_until='networkidle');ready(page)
    assert page.locator('.sidebar,#tabBar,iframe.tool-page-frame').count() == 0
    exercise_formats(page,page);exercise_library(page,page);exercise_motion(page,page);exercise_image(page,page)
    page.set_viewport_size({'width':1440,'height':1080})
    page.screenshot(path=str(SCREENSHOTS/'color-image-desktop.png'),full_page=True)
    source_tab(page,'studio');page.screenshot(path=str(SCREENSHOTS/'color-desktop.png'),full_page=True)
    exercise_layout(page,page,'quick');page.close()


def test_embedded(context, base_url, errors):
    page=context.new_page();errors_for(page,errors)
    page.goto(base_url,wait_until='networkidle');page.locator('[data-tool-id="color-picker"] .tool-card__title').click()
    first=multi.active_tool_frame(page,'.color-picker-container');ready(first)
    exercise_formats(page,first);exercise_library(page,first)
    image=png_image(first);upload(first,image,'tab-A.png');click_pixel(page,first,10,60)
    first.evaluate('async()=>{await window.__DTKIT_TOOL_PAGE__.flush();}')
    tab_a=multi.active_tab_id(page);image_a=snapshot(first)['state']['image']
    first.locator('#hslInput').fill('incomplete hsl draft')
    multi.click_page_action(page,'new');second=multi.active_tool_frame(page,'.color-picker-container');ready(second)
    tab_b=multi.active_tab_id(page)
    # Two restored pages may share one cached image identity. Clearing the copy
    # must not delete an asset still referenced by the sleeping original page.
    shared=snapshot(first);shared['instanceId']=snapshot(second)['instanceId']
    second.evaluate('async value=>{await window.__DTKIT_TOOL_PAGE__.restore(value);}',shared)
    expect(second.locator('#colorImageName')).to_have_text('tab-A.png')
    second.locator('#colorImageClear').click()
    set_color(second,'#ABCDEF');library_tab(second,'saved')
    expect(second.locator('#savedColors [data-color="#123456"]')).to_be_visible()
    upload(second,png_image(second,'red'),'tab-B.png');click_pixel(page,second,10,10)
    multi.switch_tab(page,tab_a)
    expect(first.locator('#colorImageName')).to_have_text('tab-A.png')
    expect(first.locator('#hexInput')).to_have_value('#0000FF80')
    expect(first.locator('#hslInput')).to_have_value('incomplete hsl draft')
    assert page.evaluate('window.__DTKIT_TOOL_WORKSPACE__.persist({prepareSleep:true})') is True
    page.reload(wait_until='networkidle')
    restored=multi.active_tool_frame(page,'.color-picker-container');ready(restored)
    expect(restored.locator('#colorImageName')).to_have_text('tab-A.png')
    expect(restored.locator('#hexInput')).to_have_value('#0000FF80')
    expect(restored.locator('#hslInput')).to_have_value('incomplete hsl draft')
    assert snapshot(restored)['state']['image']['assetId'] == image_a['assetId']
    expect(restored.locator('#colorImageMarker')).to_be_visible()
    click_pixel(page,restored,60,10);expect(restored.locator('#hexInput')).to_have_value('#00FF00')
    multi.switch_tab(page,tab_b);second=multi.active_tool_frame(page,'.color-picker-container')
    expect(second.locator('#colorImageName')).to_have_text('tab-B.png')
    expect(second.locator('#hexInput')).to_have_value('#FF0000')
    multi.switch_tab(page,tab_a);restored=multi.active_tool_frame(page,'.color-picker-container')
    exercise_layout(page,restored,'embedded');page.close()


def test_screen(context, base_url, errors):
    page=context.new_page();errors_for(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=color-picker',wait_until='networkidle');ready(page)
    set_color(page,'#123456');page.locator('#screenColorPicker').click()
    page.wait_for_function('window.__colorFixture.calls.some(c=>c.command==="start_screen_color_pick")')
    request=page.evaluate('window.__colorFixture.calls.at(-1).args')
    expect(page.locator('#screenColorPicker')).to_be_disabled()
    page.evaluate('r=>window.__colorFixture.emit({...r,requestId:"stale",color:"#FF0000"})',request)
    page.evaluate('r=>window.__colorFixture.emit({...r,instanceId:"other-page",color:"#FF0000"})',request)
    expect(page.locator('#hexInput')).to_have_value('#123456')
    expect(page.locator('#screenColorPicker')).to_be_disabled()
    page.evaluate('r=>window.__colorFixture.emit({...r,color:"#AABBCC"})',request)
    expect(page.locator('#hexInput')).to_have_value('#AABBCC')
    expect(page.locator('#screenColorPicker')).to_be_enabled()
    page.locator('#screenColorPicker').click()
    request=page.evaluate('window.__colorFixture.calls.at(-1).args')
    page.evaluate('r=>window.__colorFixture.emit({...r,cancelled:true})',request)
    expect(page.locator('#colorStatus')).to_contain_text('取消')
    page.locator('#screenColorPicker').click()
    request=page.evaluate('window.__colorFixture.calls.at(-1).args')
    page.evaluate('async()=>{await window.__DTKIT_TOOL_PAGE__.dispose();}')
    assert page.evaluate('window.__colorFixture.calls.at(-1).command') == 'cancel_screen_color_pick'
    assert page.evaluate('window.__colorFixture.calls.at(-1).args.requestId') == request['requestId']
    assert page.evaluate('window.__multiListeners["screen-color-picked"]?.size||0') == 0
    before=page.locator('#hexInput').input_value()
    page.evaluate('r=>window.__colorFixture.emit({...r,color:"#FF0000"})',request)
    expect(page.locator('#hexInput')).to_have_value(before);page.close()


def test_late_listener(context, base_url, errors):
    page=context.new_page();errors_for(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=color-picker&deferColorListen=1',wait_until='networkidle')
    page.wait_for_function('window.__colorFixture.pendingListen.length===1')
    page.evaluate('()=>{window.__colorDisposal=window.__DTKIT_TOOL_PAGE__.dispose();window.__colorFixture.pendingListen.shift()();}')
    page.evaluate('async()=>{await window.__colorDisposal;}')
    assert page.evaluate('window.__multiListeners["screen-color-picked"]?.size||0') == 0
    assert page.evaluate('window.__colorFixture.unlistened') >= 1
    page.close()


def test_browser_eye(context, base_url, errors):
    page=context.new_page();errors_for(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=color-picker',wait_until='networkidle');ready(page)
    page.locator('#screenColorPicker').click()
    expect(page.locator('#hexInput')).to_have_value('#22AA66')
    assert page.evaluate('window.__colorFixture.eyeCalls') == 1
    page.evaluate('window.__colorFixture.deferEye=true')
    page.locator('#screenColorPicker').click()
    expect(page.locator('#screenColorPicker')).to_be_disabled()
    page.evaluate('async()=>{await window.__DTKIT_TOOL_PAGE__.dispose();}')
    assert page.evaluate('window.__colorFixture.eyeAborted') == 1
    page.close()


def test_dispose_image(context, base_url, errors):
    page=context.new_page();errors_for(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=color-picker',wait_until='networkidle');ready(page)
    image=png_image(page);upload(page,image)
    page.evaluate('async()=>{await window.__DTKIT_TOOL_PAGE__.flush();}')
    page.evaluate('window.__colorFixture.deferDecode=true')
    page.locator('#colorFileInput').set_input_files({'name':'late.png','mimeType':'image/png','buffer':png_image(page,'blue')})
    page.wait_for_function('window.__colorFixture.pendingDecode.length===1')
    page.evaluate('async()=>{await window.__DTKIT_TOOL_PAGE__.dispose();for(const resolve of window.__colorFixture.pendingDecode.splice(0))resolve();await Promise.resolve();}')
    expect(page.locator('#colorImageName')).to_have_text('quadrants.png')
    assert page.evaluate('window.__colorFixture.workers.every(worker=>worker.terminated)')
    assert page.evaluate('document.querySelector(".color-picker-view").getAnimations({subtree:true}).length') == 0
    page.close()


def test_restore_upload_race(context, base_url, errors):
    page=context.new_page();errors_for(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=color-picker',wait_until='networkidle');ready(page)
    upload(page,png_image(page),'old-cache.png')
    original=page.evaluate('async()=>{return await window.__DTKIT_TOOL_PAGE__.flush();}')
    page.evaluate('''()=>{
      const get=IDBObjectStore.prototype.get;window.__colorPendingReads=[];
      IDBObjectStore.prototype.get=function(...args){const request=get.apply(this,args);if(this.name!=='images')return request;
        let callback=null;Object.defineProperty(request,'onsuccess',{configurable:true,get:()=>callback,set:value=>{
          callback=value;request.addEventListener('success',event=>window.__colorPendingReads.push(()=>value.call(request,event)),{once:true});
        }});return request;
      };
    }''')
    page.evaluate('value=>{window.__colorRestoring=window.__DTKIT_TOOL_PAGE__.restore(value);}',original)
    page.wait_for_function('window.__colorPendingReads.length===1')
    upload(page,png_image(page,'blue'),'new-upload.png')
    page.evaluate('async()=>{for(const read of window.__colorPendingReads.splice(0))read();await window.__colorRestoring;}')
    expect(page.locator('#colorImageName')).to_have_text('new-upload.png')
    click_pixel(page,page,10,10);expect(page.locator('#hexInput')).to_have_value('#0000FF')
    page.close()


def new_context(browser,base_url,*,native=True):
    context=browser.new_context(viewport={'width':1440,'height':1080},reduced_motion='reduce')
    extra = '' if native else r'''
delete window.__TAURI__;
window.EyeDropper=class {open({signal}){const f=window.__colorFixture;f.eyeCalls++;if(!f.deferEye)return Promise.resolve({sRGBHex:'#22AA66'});
  return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{f.eyeAborted++;reject(new DOMException('Cancelled','AbortError'));},{once:true}));}};
'''
    context.add_init_script(multi.MOCK+'\n'+INSTRUMENTATION+extra)
    def csp(route):
        response=route.fetch();headers=dict(response.headers)
        if 'text/html' in headers.get('content-type',''):headers['content-security-policy']=multi.CSP
        route.fulfill(response=response,headers=headers)
    context.route(base_url+'/**',csp)
    return context


def run(base_url):
    SCREENSHOTS.mkdir(parents=True,exist_ok=True);errors=[]
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True)
        try:
            for label,case,native in [
                ('quick formats, libraries, motion, exact pixels, worker palette and layout',test_quick,True),
                ('embedded independent colors, images, IndexedDB and workspace journal reload',test_embedded,True),
                ('native request identity, cancellation and late events after disposal',test_screen,True),
                ('late event listener registration is released after disposal',test_late_listener,True),
                ('browser EyeDropper fallback and abort lifecycle',test_browser_eye,False),
                ('late image decode and worker cleanup on disposal',test_dispose_image,True),
                ('slow IndexedDB restore cannot replace a new image upload',test_restore_upload_race,True),
            ]:
                print('Color picker UI: '+label,flush=True);context=new_context(browser,base_url,native=native)
                try:
                    start=len(errors);case(context,base_url,errors);assert not errors[start:],errors[start:]
                except Exception:
                    for index,page in enumerate(context.pages):page.screenshot(path=str(SCREENSHOTS/f'color-failure-{index}.png'),full_page=True)
                    raise
                finally:context.close()
        finally:browser.close()
    assert not errors,errors
    print(f'Color picker production UI smoke passed; screenshots={SCREENSHOTS}')


if __name__ == '__main__':
    with multi.production_url() as base_url:run(base_url)
