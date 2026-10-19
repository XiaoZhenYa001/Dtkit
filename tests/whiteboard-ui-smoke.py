"""Production whiteboard UI regression: real canvas/KaTeX with strict native fixtures.

No native files are changed. Native boards, recovery drafts, thumbnails and
editing leases live only in each fresh browser context. Build first, or set
DTKIT_TEST_BASE_URL to a production preview.
"""
import importlib.util
import re
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi_page', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
PNG_SIGNATURE = bytes((137, 80, 78, 71, 13, 10, 26, 10))
SCREENSHOTS = multi.ROOT / '.tmp' / 'whiteboard-review'

INSTRUMENTATION = r"""
(() => {
  if (window !== window.top) return;
  const fixture = window.__whiteboardFixture = {
    calls:[],drafts:[],saves:[],pendingSaves:[],pendingLoads:[],pendingDiscards:[],
    deferSave:false,deferSaveAfterCommit:false,deferLoad:false,deferDiscard:false,failDraft:false,dismisses:0
  };
  const read = () => JSON.parse(localStorage.getItem('__whiteboardNativeFixture') || '{"boards":{},"drafts":{},"owners":{}}');
  const write = value => localStorage.setItem('__whiteboardNativeFixture',JSON.stringify(value));
  fixture.read=read; fixture.write=write;
  fixture.emit=(name,payload) => {for(const listener of window.__multiListeners[name] || []) listener({payload});};
  const uuid=value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
  const keys=(value,expected) => {
    const actual=Object.keys(value).filter(key => key !== 'instanceId').sort();
    if(JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('Unexpected whiteboard IPC fields: '+actual.join(','));
  };
  const requireDocument=value => {
    if(!value || value.version !== 2 || value.infinite !== true || !Array.isArray(value.elements)
      || typeof value.background !== 'string' || !['x','y','zoom'].every(key => Number.isFinite(value.camera?.[key])))
      throw new Error('Invalid whiteboard document contract');
  };
  const acquire=(store,id,owner) => {
    if(store.owners[id] && store.owners[id] !== owner) return false;
    store.owners[id]=owner; return true;
  };
  const original=window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke=async(command,args={}) => {
    if(command === 'dismiss_quick_host') {fixture.dismisses++;return null;}
    if(!['list_whiteboards','load_whiteboard','save_whiteboard','save_whiteboard_draft','discard_whiteboard_draft',
      'get_whiteboard_thumbnail','take_over_whiteboard_edit','release_whiteboard_edit'].includes(command)) return original(command,args);
    fixture.calls.push({command,args:structuredClone(args)});
    const owner=args.instanceId || 'legacy-page';
    let store=read();
    if(command === 'list_whiteboards') {
      keys(args,[]);
      const items=Object.values(store.boards).map(board => ({...board.meta,hasDraft:!!store.drafts[board.meta.id]}));
      for(const [id,draft] of Object.entries(store.drafts)) if(!store.boards[id])
        items.push({id,name:draft.name,createdAt:draft.savedAt,updatedAt:draft.savedAt,hasDraft:true});
      return items.sort((a,b) => b.updatedAt-a.updatedAt);
    }
    if(command === 'save_whiteboard' || command === 'save_whiteboard_draft') {
      keys(args,['request']);
      const request=structuredClone(args.request);
      const formal=command === 'save_whiteboard';
      keys(request,formal ? ['id','name','document','thumbnailDataUrl'] : ['id','name','document']);
      if((!formal || request.id !== null) && !uuid(request.id)) throw new Error('Invalid board UUID');
      if(typeof request.name !== 'string') throw new Error('Missing board name');
      requireDocument(request.document);
      if(formal && !request.thumbnailDataUrl?.startsWith('data:image/png;base64,')) throw new Error('Missing real PNG thumbnail');
      if(!formal && fixture.failDraft) throw new Error('Fixture recovery disk unavailable');
      const complete=() => {
        store=read();const id=request.id || crypto.randomUUID();
        if(!acquire(store,id,owner)) throw new Error('Board has another editing owner');
        if(!formal) {
          store.drafts[id]={name:request.name,document:request.document,savedAt:Date.now()};
          fixture.drafts.push(request);write(store);return null;
        }
        const meta={id,name:request.name.trim() || '未命名白板',createdAt:store.boards[id]?.meta.createdAt || Date.now(),updatedAt:Date.now(),hasDraft:false};
        store.boards[id]={meta,document:request.document,thumbnail:request.thumbnailDataUrl};
        delete store.drafts[id];fixture.saves.push({...request,id});write(store);return meta;
      };
      if(formal && fixture.deferSave) {
        // A native response can arrive late even after its atomic disk commit.
        const result=fixture.deferSaveAfterCommit ? complete() : null;
        return new Promise((resolve,reject) => fixture.pendingSaves.push({request,complete:() => {
          try{resolve(fixture.deferSaveAfterCommit ? result : complete());}catch(error){reject(error);}
        }}));
      }
      return complete();
    }
    keys(args,['id']);if(!uuid(args.id)) throw new Error('Invalid board ID argument');
    if(command === 'get_whiteboard_thumbnail') return store.boards[args.id]?.thumbnail || null;
    if(command === 'load_whiteboard') {
      const board=store.boards[args.id];const draft=store.drafts[args.id];
      if(!board && !draft) throw new Error('Board does not exist');
      const editable=acquire(store,args.id,owner);write(store);
      const result={meta:board?.meta || {id:args.id,name:draft.name,createdAt:0,updatedAt:draft.savedAt,hasDraft:true},
        document:board?.document || draft.document,draft:draft || null,editable,isFormal:!!board};
      return fixture.deferLoad ? new Promise(resolve => fixture.pendingLoads.push({result,complete:() => resolve(structuredClone(result))})) : structuredClone(result);
    }
    if(command === 'take_over_whiteboard_edit') {
      const previous=store.owners[args.id];store.owners[args.id]=owner;write(store);
      if(previous && previous !== owner) fixture.emit('whiteboard-edit-revoked',{id:args.id,instanceId:previous});
      return null;
    }
    if(command === 'release_whiteboard_edit') {
      if(store.owners[args.id] === owner) delete store.owners[args.id];write(store);return null;
    }
    const discard=() => {
      store=read();
      if(!acquire(store,args.id,owner)) throw new Error('Cannot discard another owner draft');
      delete store.drafts[args.id];write(store);return null;
    };
    return fixture.deferDiscard ? new Promise((resolve,reject) => fixture.pendingDiscards.push({complete:() => {
      try{resolve(discard());}catch(error){reject(error);}
    }})) : discard();
  };
})();
"""

def record_errors(page, errors):
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.on('console',lambda message:errors.append(message.text) if message.type == 'error' else None)
    page.on('dialog',lambda dialog:dialog.accept())

def ready(frame):
    expect(frame.locator('#whiteboardCanvas')).to_be_visible()
    frame.wait_for_function('() => window.__DTKIT_TOOL_PAGE__?.ready === true')
    frame.wait_for_function('() => document.getElementById("whiteboardCanvas").width > 200')

def count(frame):
    return int(re.search(r'\d+',frame.locator('#whiteboardObjectCount').inner_text()).group())

def expect_count(frame,value):
    expect(frame.locator('#whiteboardObjectCount')).to_have_text(re.compile(rf'^\s*{value}\s'))

def snapshot(frame):
    return frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state')

def wait_camera_settled(frame):
    frame.evaluate('() => {window.__whiteboardCameraSettled={value:null,frames:0};}')
    frame.wait_for_function('''() => {
      const camera=JSON.stringify(window.__DTKIT_TOOL_PAGE__.snapshot().state.ui.camera);
      const probe=window.__whiteboardCameraSettled;
      if(probe.value !== camera) {probe.value=camera;probe.frames=0;}
      return ++probe.frames>4;
    }''',polling='raf')

def open_panel(frame,name):
    trigger=frame.locator(f'[data-board-panel="{name}"]')
    if trigger.get_attribute('aria-expanded') != 'true':trigger.click()
    expect(trigger).to_have_attribute('aria-expanded','true')
    expect(frame.locator(f'[data-board-panel-content="{name}"]')).to_be_visible()

def set_mode(frame,mode):
    button=frame.locator(f'[data-board-mode="{mode}"]')
    if not button.is_visible():open_panel(frame,'shape' if mode in {'line','arrow','rect','ellipse'} else 'content')
    button.click()
    expect(button).to_have_attribute('aria-pressed','true')

def draw(page,frame,start=(.19,.38),end=(.35,.47),steps=12):
    box=frame.locator('#whiteboardCanvas').bounding_box()
    assert box and box['width']>200 and box['height']>200,box
    first=(box['x']+box['width']*start[0],box['y']+box['height']*start[1])
    last=(box['x']+box['width']*end[0],box['y']+box['height']*end[1])
    page.mouse.move(*first);page.mouse.down();page.mouse.move(*last,steps=steps);page.mouse.up()
    return box

def save(page,frame,name):
    before=page.evaluate('window.__whiteboardFixture.saves.length')
    frame.locator('#whiteboardName').fill(name)
    open_panel(frame,'file');frame.locator('#whiteboardSave').click()
    page.wait_for_function('before => window.__whiteboardFixture.saves.length === before+1',arg=before)
    frame.wait_for_function('() => window.__DTKIT_TOOL_PAGE__.snapshot().state.dirty === false')
    return snapshot(frame)['boardId']

def exercise_drawing(page,frame):
    expect(frame.locator('[data-board-panel]')).to_have_count(5)
    for mode in ('select','pan','pen','highlighter','eraser'):
        expect(frame.locator(f'[data-board-mode="{mode}"]')).to_have_count(1)
        expect(frame.locator(f'[data-board-mode="{mode}"]')).to_be_visible()
    initial=count(frame)
    set_mode(frame,'pen');draw(page,frame);expect_count(frame,initial+1)
    frame.locator('#whiteboardUndo').click();expect_count(frame,initial)
    frame.locator('#whiteboardRedo').click();expect_count(frame,initial+1)
    set_mode(frame,'highlighter');draw(page,frame,(.22,.51),(.36,.56));expect_count(frame,initial+2)
    set_mode(frame,'rect');draw(page,frame,(.46,.39),(.62,.58),5);expect_count(frame,initial+3)
    set_mode(frame,'formula')
    box=frame.locator('#whiteboardCanvas').bounding_box()
    page.mouse.click(box['x']+box['width']*.73,box['y']+box['height']*.57)
    expect(frame.locator('#whiteboardObjectDialog')).to_be_visible()
    frame.locator('#whiteboardObjectInput').fill(r'\frac{1}{2}+\sqrt{x}')
    expect(frame.locator('#whiteboardFormulaPreview .katex')).to_be_visible()
    frame.locator('#whiteboardDialogConfirm').click();expect_count(frame,initial+4)
    expect(frame.locator('#whiteboardFormulaLayer .katex')).to_be_visible()
    # Escape cancels and moves focus out of the hidden modal.
    set_mode(frame,'note')
    page.mouse.click(box['x']+box['width']*.55,box['y']+box['height']*.73)
    expect(frame.locator('#whiteboardObjectInput')).to_be_focused()
    frame.locator('#whiteboardObjectInput').fill('cancelled note')
    frame.locator('#whiteboardObjectInput').press('Shift+Tab')
    assert frame.evaluate('document.getElementById("whiteboardObjectDialog").contains(document.activeElement)')
    page.keyboard.press('Escape')
    expect(frame.locator('#whiteboardObjectDialog')).to_be_hidden();expect_count(frame,initial+4)
    assert not frame.evaluate('document.getElementById("whiteboardObjectDialog").contains(document.activeElement)')

def exercise_selection(page,frame):
    set_mode(frame,'select')
    box=frame.locator('#whiteboardCanvas').bounding_box()
    page.mouse.click(box['x']+box['width']*.54,box['y']+box['height']*.48)
    expect(frame.locator('#whiteboardSelectionToolbar')).to_be_visible()
    initial=count(frame)
    frame.locator('#whiteboardDuplicate').click();expect_count(frame,initial+1)
    frame.locator('#whiteboardCanvas').focus()
    page.keyboard.press('ArrowRight');page.keyboard.press('Shift+ArrowDown')
    page.keyboard.press('Control+d');expect_count(frame,initial+2)
    page.keyboard.press('Delete');expect_count(frame,initial+1)
    frame.locator('#whiteboardUndo').click();expect_count(frame,initial+2)
    frame.locator('#whiteboardRedo').click();expect_count(frame,initial+1)
    set_mode(frame,'pen')

def exercise_eraser(page,frame):
    initial=count(frame);set_mode(frame,'eraser')
    # This lies inside the first diagonal's bounding rectangle but well away
    # from its actual path. Erasing empty space must leave that stroke intact.
    draw(page,frame,(.20,.46),(.21,.47),2);expect_count(frame,initial)
    # One continuous eraser gesture crosses two separate strokes. A single
    # undo restores both; pointermove must not create individual undo entries.
    draw(page,frame,(.28,.43),(.28,.55),20);expect_count(frame,initial-2)
    frame.locator('#whiteboardUndo').click();expect_count(frame,initial)
    set_mode(frame,'pen')

def exercise_camera_and_paper(page,frame):
    box=frame.locator('#whiteboardCanvas').bounding_box()
    camera=snapshot(frame)['ui']['camera'];px,py=box['width']*.63,box['height']*.68
    before=((px-box['width']/2)/camera['zoom']+camera['x'],(py-box['height']/2)/camera['zoom']+camera['y'])
    page.mouse.move(box['x']+px,box['y']+py);page.mouse.wheel(0,-350)
    frame.wait_for_function('() => parseInt(document.getElementById("whiteboardZoom").textContent) > 100')
    wait_camera_settled(frame)
    camera=snapshot(frame)['ui']['camera']
    after=((px-box['width']/2)/camera['zoom']+camera['x'],(py-box['height']/2)/camera['zoom']+camera['y'])
    assert max(abs(a-b) for a,b in zip(before,after))<2,(before,after)
    frame.locator('#whiteboardZoomReset').click();expect(frame.locator('#whiteboardZoom')).to_have_text('100%')
    wait_camera_settled(frame)
    frame.locator('#whiteboardZoomIn').click()
    frame.wait_for_function('() => parseInt(document.getElementById("whiteboardZoom").textContent) > 100')
    wait_camera_settled(frame)
    frame.locator('#whiteboardZoomOut').click();wait_camera_settled(frame)
    frame.locator('#whiteboardFit').click();wait_camera_settled(frame)
    for background in ('blank','dots','grid','math','ruled','english'):
        open_panel(frame,'canvas')
        if frame.locator('#whiteboardBackground').get_attribute('aria-expanded') != 'true':frame.locator('#whiteboardBackground').click()
        frame.locator(f'[data-board-background="{background}"]').click()
        frame.evaluate('window.__DTKIT_TOOL_PAGE__.flush()')
        assert page.evaluate('window.__whiteboardFixture.drafts.at(-1).document.background') == background

def exercise_history_and_readonly(page,frame,board_id,expected_count):
    frame.locator('#whiteboardHistoryRail').click()
    expect(frame.locator('#whiteboardHistory')).to_have_attribute('aria-hidden','false')
    expect(frame.locator(f'.whiteboard-history-card[data-board-id="{board_id}"]')).to_be_visible()
    expect(frame.locator('.whiteboard-history-thumb img').first).to_be_visible()
    frame.locator('#whiteboardHistoryRail').click()
    expect(frame.locator('#whiteboardHistory')).to_have_attribute('aria-hidden','true')
    assert frame.locator('#whiteboardHistory').evaluate('node => node.inert') is True
    instance=frame.evaluate('window.__DTKIT_TOOL_PAGE_CONTEXT.instanceId')
    set_mode(frame,'pen')
    page.evaluate('id => window.__whiteboardFixture.emit("whiteboard-edit-revoked",{id,instanceId:"foreign-page"})',board_id)
    expect(frame.locator('#whiteboardReadOnly')).to_be_hidden()
    page.evaluate('({id,instance}) => {const fixture=window.__whiteboardFixture;const store=fixture.read();store.owners[id]="external-owner";fixture.write(store);fixture.emit("whiteboard-edit-revoked",{id,instanceId:instance});}',{'id':board_id,'instance':instance})
    expect(frame.locator('#whiteboardReadOnly')).to_be_visible()
    expect(frame.locator('#whiteboardUndo')).to_be_disabled()
    # Attempt mutations through their DOM events as well as pointer/keyboard.
    draw(page,frame,(.42,.61),(.49,.68));expect_count(frame,expected_count)
    frame.locator('#whiteboardCanvas').focus();page.keyboard.press('Control+z')
    frame.evaluate('document.querySelector("[data-board-background=blank]").click()');expect_count(frame,expected_count)
    frame.locator('#whiteboardTakeOver').click()
    expect(frame.locator('#whiteboardReadOnly')).to_be_hidden()
    set_mode(frame,'pen');draw(page,frame,(.42,.61),(.49,.68));expect_count(frame,expected_count+1)

def exercise_save_race(page,frame):
    initial=count(frame)
    page.evaluate('window.__whiteboardFixture.deferSave=true')
    open_panel(frame,'file');frame.locator('#whiteboardSave').click()
    page.wait_for_function('() => window.__whiteboardFixture.pendingSaves.length === 1')
    set_mode(frame,'pen');draw(page,frame,(.56,.67),(.65,.73));expect_count(frame,initial+1)
    assert page.evaluate('window.__whiteboardFixture.pendingSaves[0].request.document.elements.length') == initial
    page.evaluate('() => {window.__whiteboardFixture.pendingSaves.shift().complete();window.__whiteboardFixture.deferSave=false;}')
    frame.wait_for_function('() => window.__DTKIT_TOOL_PAGE__.snapshot().state.dirty === true')
    expect_count(frame,initial+1)
    frame.evaluate('window.__DTKIT_TOOL_PAGE__.flush()')
    assert page.evaluate('window.__whiteboardFixture.drafts.at(-1).document.elements.length') == initial+1
    # A failed recovery write blocks destructive board switching.
    page.evaluate('window.__whiteboardFixture.failDraft=true')
    draw(page,frame,(.58,.78),(.66,.81))
    before=snapshot(frame)['boardId']
    frame.locator('#whiteboardHistoryRail').click();frame.locator('#whiteboardNew').click()
    expect(frame.locator('#whiteboardStatus')).to_contain_text(re.compile('草稿|失败|无法'))
    assert snapshot(frame)['boardId'] == before;expect_count(frame,initial+2)
    page.evaluate('window.__whiteboardFixture.failDraft=false')
    frame.evaluate('window.__DTKIT_TOOL_PAGE__.flush()')
    if frame.locator('#whiteboardHistoryRail').get_attribute('aria-expanded') == 'true':frame.locator('#whiteboardHistoryRail').click()

def exercise_export(page,frame):
    with page.expect_download() as event:
        open_panel(frame,'file');frame.locator('#whiteboardExport').click()
    download=event.value
    assert download.failure() is None and download.suggested_filename.endswith('.png')
    data=Path(download.path()).read_bytes()
    assert data.startswith(PNG_SIGNATURE) and len(data)>1000

def exercise_motion(page,frame):
    dismisses=page.evaluate('window.__whiteboardFixture.dismisses')
    # Local Escape belongs to the active whiteboard surface before the quick
    # host's window handler considers dismissing its entire tool window.
    frame.locator('#whiteboardHistoryRail').click();page.keyboard.press('Escape')
    expect(frame.locator('#whiteboardHistory')).to_have_attribute('aria-hidden','true')
    frame.locator('#whiteboardHelp').click();page.keyboard.press('Escape')
    expect(frame.locator('#whiteboardHelpPanel')).to_be_hidden()
    open_panel(frame,'draw');page.keyboard.press('Escape')
    expect(frame.locator('[data-board-panel="draw"]')).to_have_attribute('aria-expanded','false')
    assert page.evaluate('window.__whiteboardFixture.dismisses')==dismisses,'Local Escape dismissed the quick whiteboard host'
    page.emulate_media(reduced_motion='no-preference');open_panel(frame,'shape')
    motion=frame.locator('[data-board-panel-content="shape"]').evaluate('''node => {
      const animations=node.getAnimations({subtree:true}).filter(animation => animation.playState === 'running');
      for(const animation of animations) {animation.pause();animation.currentTime=Number(animation.effect.getTiming().duration)/2;}
      return {count:animations.length,opacity:Number(getComputedStyle(node).opacity),transform:getComputedStyle(node).transform};
    }''')
    assert motion['count']>0,motion
    assert 0<motion['opacity']<1 or motion['transform'] != 'none',motion
    frame.evaluate('''() => {
      for(const name of ['content','shape','file','canvas','shape']) document.querySelector('[data-board-panel="'+name+'"]').click();
    }''')
    expect(frame.locator('[data-board-panel="shape"]')).to_have_attribute('aria-expanded','true')
    for name in ('content','file','canvas'):expect(frame.locator(f'[data-board-panel="{name}"]')).to_have_attribute('aria-expanded','false')
    page.emulate_media(reduced_motion='reduce')
    frame.wait_for_function('() => document.getAnimations().filter(animation => animation.playState === "running").length === 0')
    frame.locator('[data-board-panel="shape"]').click()

def exercise_layout(page,frame,label):
    for width,height in ((680,740),(390,760),(1280,860)):
        page.set_viewport_size({'width':width,'height':height})
        frame.wait_for_function('''() => {
          const canvas=document.getElementById('whiteboardCanvas'),rect=canvas.getBoundingClientRect();
          const ratio=Math.min(devicePixelRatio || 1,2,Math.sqrt(6000000/(rect.width*rect.height)));
          return canvas.width===Math.floor(rect.width*ratio) && canvas.height===Math.floor(rect.height*ratio);
        }''')
        # Wait for the actual resize redraw, then frame all existing content.
        # A width>200 check can pass on the previous backing canvas and capture
        # a stretched transient frame immediately after the viewport changes.
        frame.locator('#whiteboardFit').click();wait_camera_settled(frame)
        dimensions=frame.evaluate('''() => ({root:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth,
          tool:document.querySelector('.whiteboard-tool').scrollWidth,width:document.querySelector('.whiteboard-tool').clientWidth})''')
        assert dimensions['root']<=dimensions['viewport']+1 and dimensions['tool']<=dimensions['width']+1,dimensions
        for mode in ('select','pan','pen','highlighter','eraser'):expect(frame.locator(f'[data-board-mode="{mode}"]')).to_be_visible()
        page.screenshot(path=str(SCREENSHOTS/f'dtkit-whiteboard-{label}-{width}.png'),full_page=True)
    page.emulate_media(color_scheme='dark');frame.evaluate('document.documentElement.dataset.theme="dark"')
    paper=frame.locator('#whiteboardCommittedCanvas').evaluate('''canvas => {
      const data=canvas.getContext('2d').getImageData(canvas.width-24,canvas.height-24,20,20).data;
      let bright=0;for(let index=0;index<data.length;index+=4) if(Math.min(...data.slice(index,index+3))>=240 && data[index+3]===255) bright++;
      return bright/(data.length/4);
    }''')
    assert paper>.65,paper
    page.screenshot(path=str(SCREENSHOTS/f'dtkit-whiteboard-{label}-dark.png'),full_page=True)
    page.emulate_media(color_scheme='light');frame.evaluate('document.documentElement.dataset.theme="light"')

def test_quick(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
    expect(page.locator('html.quick-tool--whiteboard')).to_have_count(1)
    expect(page.locator('.tool-shortcut-slot')).to_have_count(0)
    expect(page.locator('.whiteboard-hero')).to_be_hidden();expect(page.locator('.quick-footer')).to_be_hidden()
    box=page.locator('#whiteboardCanvas').bounding_box()
    assert box['width']>=1270 and box['height']>=850,box
    exercise_drawing(page,page);exercise_selection(page,page);exercise_eraser(page,page);exercise_camera_and_paper(page,page)
    board_id=save(page,page,'函数讲解 · 白板 UI 回归')
    exercise_history_and_readonly(page,page,board_id,count(page))
    exercise_save_race(page,page);exercise_export(page,page);exercise_motion(page,page);exercise_layout(page,page,'quick')
    page.locator('#quickClose').click();page.wait_for_function('() => window.__whiteboardFixture.dismisses === 1');page.close()

def test_embedded(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url,wait_until='networkidle');page.locator('[data-tool-id="whiteboard"] .tool-card__title').click()
    first=multi.active_tool_frame(page,'#whiteboardCanvas');ready(first)
    set_mode(first,'pen');draw(page,first);first.locator('#whiteboardName').fill('独立白板 A')
    first.evaluate('window.__DTKIT_TOOL_PAGE__.flush()')
    first_id=snapshot(first)['boardId'];tab_a=multi.active_tab_id(page)
    multi.click_page_action(page,'new')
    second=multi.active_tool_frame(page,'#whiteboardCanvas');ready(second);tab_b=multi.active_tab_id(page)
    expect_count(second,0);assert snapshot(second)['boardId'] != first_id
    set_mode(second,'pen');draw(page,second,(.38,.48),(.54,.58));second.locator('#whiteboardName').fill('独立白板 B')
    second.evaluate('window.__DTKIT_TOOL_PAGE__.flush()')
    multi.switch_tab(page,tab_a);expect_count(first,1);expect(first.locator('#whiteboardName')).to_have_value('独立白板 A')
    page.evaluate('window.__DTKIT_TOOL_WORKSPACE__.persist({prepareSleep:true})')
    page.reload(wait_until='networkidle')
    restored=multi.active_tool_frame(page,'#whiteboardCanvas');ready(restored)
    expect_count(restored,1);expect(restored.locator('#whiteboardName')).to_have_value('独立白板 A')
    assert snapshot(restored)['boardId'] == first_id
    multi.switch_tab(page,tab_b);second=multi.active_tool_frame(page,'#whiteboardCanvas');ready(second)
    expect_count(second,1);expect(second.locator('#whiteboardName')).to_have_value('独立白板 B')
    multi.switch_tab(page,tab_a);restored=multi.active_tool_frame(page,'#whiteboardCanvas')
    exercise_layout(page,restored,'embedded');page.close()

def test_performance(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
    strokes=[{'id':f'perf-{index}','tool':'pen','color':'#242937','width':3,
        'points':[[.05+(index%30)/34+point/9000,.08+(index//30)/24+point/12000,.5] for point in range(12)]} for index in range(600)]
    page.evaluate('strokes => localStorage.setItem("dtkit_whiteboard_v1",JSON.stringify({strokes,gridEnabled:true}))',strokes)
    page.reload(wait_until='networkidle');ready(page);expect_count(page,600);set_mode(page,'pen')
    page.evaluate('''() => {
      window.__whiteboardClearCalls={committed:0,all:0};
      const original=CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect=function(...args) {
        window.__whiteboardClearCalls.all++;
        if(this.canvas.id === 'whiteboardCommittedCanvas') window.__whiteboardClearCalls.committed++;
        return original.apply(this,args);
      };
    }''')
    box=page.locator('#whiteboardCanvas').bounding_box()
    page.mouse.move(box['x']+150,box['y']+250);page.mouse.down();page.mouse.move(box['x']+650,box['y']+390,steps=120)
    assert page.evaluate('window.__whiteboardClearCalls.committed') == 0,'Pointer moves repainted historical strokes'
    expect(page.locator('#whiteboardStrokeTail')).to_be_visible()
    assert page.locator('#whiteboardStrokeTailPath').get_attribute('d'),'Incremental stroke lost its responsive tip'
    page.mouse.up();expect_count(page,601)
    calls=page.evaluate('window.__whiteboardClearCalls')
    assert calls['committed']<=1 and calls['all']<=6,calls
    page.close()

def test_browser_storage(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
    set_mode(page,'pen');draw(page,page);page.locator('#whiteboardName').fill('浏览器持久化白板')
    open_panel(page,'file');page.locator('#whiteboardSave').click()
    page.wait_for_function('() => window.__DTKIT_TOOL_PAGE__.snapshot().state.isFormal === true')
    board_id=snapshot(page)['boardId']
    page.reload(wait_until='networkidle');ready(page);page.locator('#whiteboardHistoryRail').click()
    page.locator(f'[data-board-id="{board_id}"]').click()
    expect_count(page,1);expect(page.locator('#whiteboardName')).to_have_value('浏览器持久化白板')
    exercise_export(page,page);page.close()

def test_late_open_dispose(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
    set_mode(page,'pen');draw(page,page);save(page,page,'延迟打开 A')
    saved=page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    page.locator('#whiteboardHistoryRail').click();page.locator('#whiteboardNew').click()
    expect_count(page,0)
    page.locator('#whiteboardName').fill('当前白板 B')
    page.evaluate('window.__whiteboardFixture.deferLoad=true')
    page.evaluate('saved => {window.__whiteboardRestore=window.__DTKIT_TOOL_PAGE__.restore(saved);}',saved)
    page.wait_for_function('() => window.__whiteboardFixture.pendingLoads.length === 1')
    page.evaluate('() => {window.__whiteboardDispose=window.__DTKIT_TOOL_PAGE__.dispose();}')
    name=page.locator('#whiteboardName').input_value()
    page.evaluate('''async () => {
      window.__whiteboardFixture.pendingLoads.shift().complete();
      await Promise.all([window.__whiteboardRestore,window.__whiteboardDispose]);
    }''')
    expect(page.locator('#whiteboardName')).to_have_value(name)
    expect_count(page,0)
    assert page.evaluate('window.__multiListeners["whiteboard-edit-revoked"].size') == 0
    assert page.evaluate('document.getAnimations().filter(animation => animation.playState === "running").length') == 0
    assert page.evaluate('Object.keys(window.__whiteboardFixture.read().owners).length') == 0,'Disposed late load leaked an editing lease'
    page.close()

def test_revocation_recovery(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
    set_mode(page,'pen');draw(page,page)
    board_id=save(page,page,'接管与恢复回归')
    draw(page,page,(.35,.45),(.43,.53));expect_count(page,2)
    page.evaluate('window.__whiteboardFixture.deferSave=true;window.__whiteboardFixture.deferSaveAfterCommit=true')
    page.locator('#whiteboardSave').click()
    page.wait_for_function('() => window.__whiteboardFixture.pendingSaves.length === 1')
    draw(page,page,(.56,.61),(.65,.67));expect_count(page,3)
    instance=page.evaluate('window.__DTKIT_TOOL_PAGE_CONTEXT.instanceId')
    page.evaluate('''({id,instance}) => {
      const fixture=window.__whiteboardFixture,store=fixture.read(),board=store.boards[id];
      // Another owner has already written newer content before its event reaches
      // this page. Takeover must reload it instead of just dismissing the banner.
      board.meta.name='来自另一页的新版本';board.meta.updatedAt=Date.now();
      board.document.elements.push({id:'external-1',type:'text',x:10,y:10,size:24,color:'#242937',text:'外部更新一'},
        {id:'external-2',type:'text',x:10,y:60,size:24,color:'#242937',text:'外部更新二'});
      delete store.drafts[id];store.owners[id]='external-owner';fixture.write(store);
      fixture.emit('whiteboard-edit-revoked',{id,instanceId:instance});
    }''',{'id':board_id,'instance':instance})
    expect(page.locator('#whiteboardReadOnly')).to_be_visible()
    expect_count(page,3)
    page.evaluate('''() => {
      const fixture=window.__whiteboardFixture;
      fixture.deferSave=false;fixture.pendingSaves.shift().complete();fixture.deferSaveAfterCommit=false;
    }''')
    page.wait_for_function('() => window.__whiteboardFixture.saves.some(request => request.name.includes("接管前恢复"))')
    expect(page.locator('#whiteboardReadOnly')).to_be_visible()
    expect(page.locator('#whiteboardUndo')).to_be_disabled()
    expect(page.locator('#whiteboardSave')).to_be_disabled()
    recovery=page.evaluate('window.__whiteboardFixture.saves.find(request => request.name.includes("接管前恢复"))')
    assert recovery['id'] != board_id and len(recovery['document']['elements']) == 3
    page.locator('#whiteboardTakeOver').click()
    expect(page.locator('#whiteboardReadOnly')).to_be_hidden()
    expect_count(page,4)
    expect(page.locator('#whiteboardName')).to_have_value('来自另一页的新版本')
    page.locator('#whiteboardHistoryRail').click()
    page.locator(f'[data-board-id="{recovery["id"]}"]').click()
    expect_count(page,3)
    expect(page.locator('#whiteboardName')).to_have_value(re.compile('接管前恢复'))
    page.close()

def test_touch_pinch(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
    set_mode(page,'pen')
    result=page.evaluate('''() => {
      const canvas=document.getElementById('whiteboardCanvas'),rect=canvas.getBoundingClientRect();
      const camera={...window.__DTKIT_TOOL_PAGE__.snapshot().state.ui.camera};
      const pointer=(type,id,x,y) => canvas.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,
        pointerId:id,pointerType:'touch',button:0,buttons:type==='pointerup'?0:1,pressure:.5,
        clientX:rect.x+x,clientY:rect.y+y}));
      pointer('pointerdown',101,300,300);pointer('pointermove',101,320,320);
      pointer('pointerdown',102,500,320);
      pointer('pointermove',101,280,320);pointer('pointermove',102,540,320);
      pointer('pointerup',101,280,320);pointer('pointerup',102,540,320);
      return {before:camera,after:{...window.__DTKIT_TOOL_PAGE__.snapshot().state.ui.camera},width:rect.width,height:rect.height};
    }''')
    expect_count(page,0)
    assert abs(result['after']['zoom']/result['before']['zoom']-260/180)<.001,result
    def anchor(camera):
        return ((410-result['width']/2)/camera['zoom']+camera['x'],(320-result['height']/2)/camera['zoom']+camera['y'])
    assert max(abs(a-b) for a,b in zip(anchor(result['before']),anchor(result['after'])))<1,result
    draw(page,page,(.3,.45),(.42,.53));expect_count(page,1)
    page.close()

def test_draft_history(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
    set_mode(page,'pen');draw(page,page);page.locator('#whiteboardName').fill('从未手动保存的恢复草稿')
    board_id=snapshot(page)['boardId']
    page.locator('#whiteboardHistoryRail').click();page.locator('#whiteboardNew').click();expect_count(page,0)
    page.locator('#whiteboardHistoryRail').click()
    card=page.locator(f'.whiteboard-history-card[data-board-id="{board_id}"]')
    expect(card).to_be_visible();expect(card).to_contain_text('未保存草稿');card.click()
    expect_count(page,1);expect(page.locator('#whiteboardName')).to_have_value('从未手动保存的恢复草稿')
    assert snapshot(page)['isFormal'] is False
    page.close()


def insert_formula(page,frame,latex):
    set_mode(frame,'formula');box=frame.locator('#whiteboardCanvas').bounding_box()
    page.mouse.click(box['x']+box['width']*.63,box['y']+box['height']*.57)
    frame.locator('#whiteboardObjectInput').fill(latex)
    expect(frame.locator('#whiteboardFormulaPreview')).not_to_be_empty()
    frame.locator('#whiteboardDialogConfirm').click()
    expect(frame.locator('#whiteboardObjectDialog')).to_be_hidden()


def test_incomplete_formula(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
    insert_formula(page,page,r'\frac{');expect_count(page,1)
    expect(page.locator('#whiteboardFormulaLayer .katex-error')).to_be_visible()
    board_id=save(page,page,'未完成公式也能恢复')
    exercise_export(page,page)
    page.locator('#whiteboardHistoryRail').click();page.locator('#whiteboardNew').click();expect_count(page,0)
    page.locator('#whiteboardHistoryRail').click();page.locator(f'[data-board-id="{board_id}"]').click()
    expect_count(page,1);expect(page.locator('#whiteboardFormulaLayer .katex-error')).to_be_visible()
    page.evaluate('window.__DTKIT_TOOL_PAGE__.flush()')
    exercise_export(page,page);page.close()


def test_save_thumbnail_draft_dispose(context,base_url,errors):
    for as_new in (False,True):
        page=context.new_page();record_errors(page,errors)
        page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
        set_mode(page,'pen');draw(page,page);old_id=save(page,page,'缩略图异步保存回归'+('副本' if as_new else '原件'))
        insert_formula(page,page,r'\frac{1}{2}');expect_count(page,2)
        # Pause only export's font readiness after its DOM formula has rendered.
        # A newer revision can be confirmed as a draft before the older formal
        # snapshot enters its disk queue, then disposal must preserve that draft.
        page.evaluate('''() => {
          const fixture=window.__whiteboardFixture;
          fixture.deferSave=true;
          window.__whiteboardThumbnailGate=new Promise(resolve => window.__whiteboardResumeThumbnail=resolve);
          Object.defineProperty(document.fonts,'ready',{configurable:true,get:() => window.__whiteboardThumbnailGate});
        }''')
        if as_new:open_panel(page,'file')
        page.locator('#whiteboardSaveAs' if as_new else '#whiteboardSave').click()
        page.wait_for_function('() => !!document.querySelector(".whiteboard-export-measure")')
        set_mode(page,'pen');draw(page,page,(.41,.67),(.53,.74));expect_count(page,3)
        page.evaluate('window.__DTKIT_TOOL_PAGE__.flush()')
        assert page.evaluate('id => window.__whiteboardFixture.read().drafts[id].document.elements.length',old_id)==3
        page.evaluate('() => {delete document.fonts.ready;window.__whiteboardResumeThumbnail();}')
        page.wait_for_function('() => window.__whiteboardFixture.pendingSaves.length === 1')
        page.evaluate('''async () => {
          const fixture=window.__whiteboardFixture;
          fixture.pendingSaves.shift().complete();fixture.deferSave=false;
          await window.__DTKIT_TOOL_PAGE__.dispose();
        }''')
        store=page.evaluate('window.__whiteboardFixture.read()')
        saved=page.evaluate('window.__whiteboardFixture.saves.at(-1)')
        assert len(store['boards'][saved['id']]['document']['elements'])==2
        assert len(store['drafts'][saved['id']]['document']['elements'])==3,'Older formal save deleted a confirmed newer recovery draft'
        assert bool(saved['id']!=old_id) is as_new
        assert not store['owners'],'Disposing a delayed formal save leaked an editing lease'
        page.close()


def test_saveas_cleanup_draft_dispose(context,base_url,errors):
    page=context.new_page();record_errors(page,errors)
    page.goto(base_url+'/quick.html?kind=tool&toolId=whiteboard',wait_until='networkidle');ready(page)
    set_mode(page,'pen');draw(page,page);old_id=save(page,page,'另存副本清理期间继续编辑')
    draw(page,page,(.4,.46),(.55,.53));expect_count(page,2)
    page.evaluate('window.__whiteboardFixture.deferDiscard=true')
    open_panel(page,'file');page.locator('#whiteboardSaveAs').click()
    page.wait_for_function('() => window.__whiteboardFixture.pendingDiscards.length === 1')
    new_id=snapshot(page)['boardId']
    assert new_id!=old_id,'Save As must adopt its successfully written board before old-draft cleanup waits'
    draw(page,page,(.51,.68),(.65,.74));expect_count(page,3)
    # The page runtime waits for all IPC, including our deliberately paused
    # cleanup. Confirm the draft's actual write before releasing that cleanup.
    page.evaluate('() => {window.__whiteboardPendingFlush=window.__DTKIT_TOOL_PAGE__.flush();}')
    page.wait_for_function('id => window.__whiteboardFixture.read().drafts[id]?.document.elements.length === 3',arg=new_id)
    assert page.evaluate('id => window.__whiteboardFixture.read().drafts[id].document.elements.length',new_id)==3
    page.evaluate('''async () => {
      const disposal=window.__DTKIT_TOOL_PAGE__.dispose(),fixture=window.__whiteboardFixture;
      fixture.pendingDiscards.shift().complete();fixture.deferDiscard=false;
      await Promise.all([disposal,window.__whiteboardPendingFlush]);
    }''')
    store=page.evaluate('window.__whiteboardFixture.read()')
    assert len(store['drafts'][new_id]['document']['elements'])==3
    assert len(store['boards'][old_id]['document']['elements'])==1
    assert not store['owners'],'Disposing Save As cleanup leaked an editing lease'
    page.close()


def new_context(browser,base_url,*,native=True):
    context=browser.new_context(viewport={'width':1280,'height':860},reduced_motion='reduce')
    context.add_init_script(multi.MOCK+'\n'+INSTRUMENTATION+('' if native else '\n delete window.__TAURI__;'))
    def apply_csp(route):
        response=route.fetch();headers=dict(response.headers)
        if 'text/html' in headers.get('content-type',''):headers['content-security-policy']=multi.CSP
        route.fulfill(response=response,headers=headers)
    context.route(base_url+'/**',apply_csp)
    return context

def run(base_url):
    errors=[]
    SCREENSHOTS.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True)
        cases=[('quick drawing, selection, save races, leases, paper, motion and PNG',test_quick,True),
               ('embedded independent pages, native draft reload and responsive layout',test_embedded,True),
               ('late native open cannot mutate a disposed page',test_late_open_dispose,True),
               ('revocation preserves local work and takeover loads external updates',test_revocation_recovery,True),
               ('two-finger pinch cancels provisional ink and keeps its world anchor',test_touch_pinch,True),
               ('old formal thumbnail cannot delete newer confirmed draft on dispose, including Save As',test_save_thumbnail_draft_dispose,True),
               ('Save As adopts the new board before delayed old-draft cleanup and disposal',test_saveas_cleanup_draft_dispose,True),
               ('native never-formally-saved recovery drafts remain discoverable',test_draft_history,True),
               ('browser never-formally-saved recovery drafts remain discoverable',test_draft_history,False),
               ('incomplete LaTeX survives formal save, reload and PNG export',test_incomplete_formula,True),
               ('600 historical strokes with 120 incremental pointer moves',test_performance,True),
               ('real browser local persistence and PNG download',test_browser_storage,False)]
        try:
            for label,test,native in cases:
                print('Whiteboard UI: '+label,flush=True)
                context=new_context(browser,base_url,native=native)
                error_count=len(errors)
                try:
                    test(context,base_url,errors)
                    assert not errors[error_count:],{'case':label,'errors':errors[error_count:]}
                except Exception:
                    for index,page in enumerate(context.pages):
                        page.screenshot(path=str(SCREENSHOTS/f'dtkit-whiteboard-failure-{index}.png'),full_page=True)
                    raise
                finally:context.close()
            assert not errors,errors
        finally:browser.close()
    print(f'Whiteboard production UI smoke passed; screenshots={SCREENSHOTS}')

if __name__ == '__main__':
    with multi.production_url() as base_url:run(base_url)
