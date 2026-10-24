"""Production sticky-note library regression with isolated native IPC fixtures.

No desktop windows or user notes are touched. Exercises the actual built page
under its production CSP, with normal motion enabled for continuity checks.
"""
import argparse
import ast
import importlib.util
import json
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.tmp' / 'sticky-notes-library-review'
spec = importlib.util.spec_from_file_location('multi_page', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)

# Reuse the editor's deterministic native fixture without executing its suite.
module = ast.parse(Path(__file__).with_name('sticky-notes-ui-smoke.py').read_text(encoding='utf-8-sig'))
MOCK = next(ast.literal_eval(item.value) for item in module.body if isinstance(item, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'MOCK' for target in item.targets))

EXTRA = r"""
(() => {
  window.__noteTextCopies=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
    if(top.__noteCopyFailure)throw new Error('复制测试失败');top.__noteTextCopies.push(text);
  }}});
  const base=window.__TAURI__.core.invoke;
  window.__TAURI__.core.invoke=async(command,args={})=>{
    if(command==='import_sticky_notes'){
      window.__noteCalls.push({command,args:structuredClone(args)});
      if(window.__noteFailure[command])throw window.__noteFailure[command];
      const notes=args.notes.map(seed=>window.__note({...seed,id:'bbbbbbbb-bbbb-4bbb-8bbb-'+String(window.__nextNoteNumber++).padStart(12,'0')}));
      window.__noteItems.push(...notes);window.__notesEmit(notes[0]?.id);return structuredClone(notes);
    }
    const result=await base(command,args);
    if(command==='create_sticky_note'&&args.seed){window.__notesUpdate(result.id,args.seed);return {...result,...args.seed};}
    return result;
  };
  window.__noteItems=[
    window.__note({id:'11111111-1111-4111-8111-111111111111',title:'工作清单',content:'- [ ] 设计审查\n- [x] 同步记录\n\n#工作 #灵感',color:'yellow',pinned:true}),
    window.__note({id:'22222222-2222-4222-8222-222222222222',title:'绿色的灵感',content:'把设计拆小一点。\n\n#灵感',color:'green',pinned:false}),
    window.__note({id:'33333333-3333-4333-8333-333333333333',title:'会议记录',content:'讨论便签的连续性\n\n#工作',color:'blue',pinned:false,opened:true}),
    window.__note({id:'44444444-4444-4444-8444-444444444444',title:'周末的小计划',content:'去书店，然后散步。\n\n#生活',color:'pink',pinned:false}),
    window.__note({id:'55555555-5555-4555-8555-555555555555',title:'摘录',content:'记录让思绪有处停留。',color:'purple',pinned:false}),
    window.__note({id:'66666666-6666-4666-8666-666666666666',title:'旧便签',content:'回收站中保留的内容',color:'gray',pinned:false,trashedAt:Date.now()-1000})
  ];
})();
"""
ONE = '11111111-1111-4111-8111-111111111111'
TWO = '22222222-2222-4222-8222-222222222222'
THREE = '33333333-3333-4333-8333-333333333333'
SIX = '66666666-6666-4666-8666-666666666666'


def new_context(browser, base_url):
    context = browser.new_context(viewport={'width': 1320, 'height': 940}, reduced_motion='no-preference', accept_downloads=True)
    context.add_init_script(MOCK + '\n' + EXTRA)
    def csp(route):
        response = route.fetch()
        headers = dict(response.headers)
        if 'text/html' in headers.get('content-type', ''):
            headers['content-security-policy'] = multi.CSP
        route.fulfill(response=response, headers=headers)
    context.route(base_url + '/**', csp)
    return context


def open_library(context, base_url, errors, quick=False):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    page.goto(base_url + ('/quick.html?kind=tool&toolId=sticky-notes' if quick else ''), wait_until='networkidle')
    if quick:
        frame = page
    else:
        page.locator('[data-tool-id="sticky-notes"] .tool-card__title').click()
        frame = multi.active_tool_frame(page, '.notes-shell')
    expect(frame.locator('.notes-shell')).to_be_visible()
    frame.wait_for_function('window.__DTKIT_TOOL_PAGE__?.ready === true')
    expect(cards(frame)).to_have_count(5)
    return page, frame


def cards(frame):
    return frame.locator('#notesList > [data-note-id]')


def card(frame, note_id):
    return frame.locator(f'#notesList > [data-note-id="{note_id}"]')


def call_count(page, command):
    return page.evaluate('command=>window.__noteCalls.filter(call=>call.command===command).length', command)


def menu_action(frame, note_id, action):
    target = card(frame, note_id)
    target.locator('summary').click()
    target.locator(f'[data-note-action="{action}"]').click()


def settle_motion(frame):
    frame.evaluate('''async()=>{
        const tick=()=>new Promise(resolve=>requestAnimationFrame(resolve));await tick();await tick();
        for(let attempt=0;attempt<180;attempt++){
            const moving=document.querySelector('.notes-shell').getAnimations({subtree:true}).some(animation=>animation.playState==='running'&&animation.effect?.getTiming().iterations!==Infinity);
            if(!moving)return;await tick();
        }
        throw new Error('Note transitions did not settle');
    }''')


def test_filters_motion(context, base_url, errors):
    page, frame = open_library(context, base_url, errors)
    expect(frame.locator('#notesActiveCount')).to_have_text('5')
    expect(frame.locator('#notesPinnedCount')).to_have_text('1')
    expect(frame.locator('#notesOpenedCount')).to_have_text('1')
    expect(card(frame, ONE).locator('.notes-card__progress')).to_contain_text('1/2')
    frame.locator('[data-filter="pinned"]').click()
    expect(cards(frame)).to_have_count(1)
    frame.locator('[data-filter="opened"]').click()
    expect(cards(frame)).to_have_count(1)
    expect(card(frame, THREE)).to_be_visible()
    frame.locator('[data-filter="all"]').click()
    frame.locator('[data-filter-color="green"]').click()
    expect(cards(frame)).to_have_count(1)
    expect(card(frame, TWO)).to_be_visible()
    frame.locator('[data-filter-color="all"]').click()
    frame.locator('#notesTags [data-note-tag="灵感"]').click()
    expect(cards(frame)).to_have_count(2)
    frame.locator('#notesTags [data-note-tag="灵感"]').click()
    frame.locator('#notesSearch').fill('工作 设计')
    expect(cards(frame)).to_have_count(1)
    expect(card(frame, ONE).locator('mark')).to_have_count(2)
    frame.locator('#notesSearch').fill('"绿色的灵感"')
    expect(card(frame, TWO)).to_be_visible()
    frame.locator('#notesSearch').fill('')
    expect(cards(frame)).to_have_count(5)
    settle_motion(frame)
    before_height = card(frame, ONE).bounding_box()['height']
    frame.locator('[data-layout="list"]:is(button)').click()
    expect(frame.locator('#notesList')).to_have_attribute('data-layout', 'list')
    moving = card(frame, ONE).evaluate('element=>({height:element.getBoundingClientRect().height,animations:element.getAnimations().filter(animation=>animation.playState==="running").length})')
    assert moving['animations'] > 0, moving
    assert 90 <= moving['height'] <= before_height + 1, (before_height, moving)
    settle_motion(frame)
    assert card(frame, ONE).bounding_box()['height'] < 120
    frame.locator('[data-layout="grid"]:is(button)').click()
    frame.locator('#notesSort').select_option('title')
    settle_motion(frame)
    # Rapid reversals keep a single live node per note and remove exit ghosts.
    frame.evaluate('''()=>{for(const filter of ['pinned','all','trash','all','opened','all'])document.querySelector(`[data-filter="${filter}"]`).click();}''')
    settle_motion(frame)
    expect(cards(frame)).to_have_count(5)
    assert frame.locator('#notesList [inert]').count() == 0
    assert cards(frame).evaluate_all('elements=>new Set(elements.map(element=>element.dataset.noteId)).size') == 5
    # A routine refresh keeps an open menu and its focused action continuous.
    card(frame, ONE).locator('summary').click()
    card(frame, ONE).locator('[data-note-action="copy"]').focus()
    page.evaluate('window.__notesUpdate("11111111-1111-4111-8111-111111111111",{content:"同步新增内容 #工作 #灵感"})')
    expect(card(frame, ONE).locator('.notes-card__content p')).to_contain_text('同步新增内容')
    expect(card(frame, ONE).locator('details')).to_have_attribute('open', '')
    expect(card(frame, ONE).locator('[data-note-action="copy"]')).to_be_focused()
    card(frame, ONE).locator('summary').focus()
    page.evaluate('window.__notesUpdate("11111111-1111-4111-8111-111111111111",{content:"再同步一段内容 #工作 #灵感"})')
    expect(card(frame, ONE).locator('.notes-card__content p')).to_contain_text('再同步一段内容')
    expect(card(frame, ONE).locator('summary')).to_be_focused()
    frame.locator('#notesRefresh').click()
    frame.locator('#notesSearch').focus()
    page.screenshot(path=str(OUTPUT / 'library-desktop.png'), full_page=True)
    for width in (900, 680, 390):
        page.set_viewport_size({'width': width, 'height': 900})
        settle_motion(frame)
        assert frame.locator('.notes-shell').evaluate('element=>element.scrollWidth<=element.clientWidth+1'), width
        page.screenshot(path=str(OUTPUT / f'library-main-{width}.png'), full_page=True)
    page.close()


def test_composer(context, base_url, errors):
    page, frame = open_library(context, base_url, errors)
    frame.locator('#notesCreate').click()
    expect(frame.locator('#notesComposer')).to_be_visible()
    expect(frame.locator('#notesComposeContent')).to_be_focused()
    frame.locator('[data-template="todo"]').click()
    expect(frame.locator('#notesComposeTitle')).to_have_value('今日待办')
    expect(frame.locator('#notesComposeContent')).to_have_value(re.compile(r'- \[ \]'))
    frame.locator('[data-compose-color="blue"]').click()
    expect(frame.locator('#notesComposePaper')).to_have_attribute('data-color', 'blue')
    frame.locator('#notesComposePin').check()
    frame.locator('#notesComposeOpen').uncheck()
    frame.locator('#notesComposeContent').fill('- [ ] 需要保留的模板内容\n#工作')
    # Failure stays visible in the modal and preserves editable content.
    page.evaluate('window.__noteFailure.create_sticky_note="保存测试失败"')
    frame.locator('#notesComposeSubmit').click()
    expect(frame.locator('#notesComposeNotice')).to_contain_text('保存测试失败')
    expect(frame.locator('#notesComposeContent')).to_be_editable()
    expect(frame.locator('#notesComposeContent')).to_have_value('- [ ] 需要保留的模板内容\n#工作')
    page.evaluate('delete window.__noteFailure.create_sticky_note')
    frame.locator('#notesComposeContent').press('Control+Enter')
    expect(frame.locator('#notesComposer')).not_to_be_visible()
    expect(cards(frame)).to_have_count(6)
    seed = page.evaluate('window.__noteCalls.filter(call=>call.command==="create_sticky_note").at(-1).args.seed')
    assert seed == {'title': '今日待办', 'content': '- [ ] 需要保留的模板内容\n#工作', 'color': 'blue', 'pinned': True}, seed
    assert call_count(page, 'open_sticky_note') == 0
    frame.locator('#notesCreate').press('Control+n')
    frame.locator('#notesComposeTitle').fill('草稿连续性')
    frame.locator('#notesComposeContent').fill('仍未创建的内容')
    snapshot = frame.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    assert snapshot['state']['compose']['content'] == '仍未创建的内容'
    assert frame.locator('#notesComposer').is_visible()
    frame.locator('#notesComposeContent').press('Escape')
    expect(frame.locator('#notesComposer')).not_to_be_visible()
    frame.locator('#notesCreate').click()
    expect(frame.locator('#notesComposeContent')).to_have_value('仍未创建的内容')
    frame.locator('[data-template="idea"]').click()
    expect(frame.locator('#notesConfirm')).to_be_visible()
    frame.locator('#notesConfirmCancel').click()
    expect(frame.locator('#notesComposeContent')).to_have_value('仍未创建的内容')
    frame.locator('#notesComposeCancel').click()
    frame.evaluate('async snapshot=>await window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    expect(frame.locator('#notesComposer')).to_be_visible()
    expect(frame.locator('#notesComposeTitle')).to_have_value('草稿连续性')
    expect(frame.locator('#notesComposeContent')).to_have_value('仍未创建的内容')
    frame.locator('#notesComposeCancel').click()
    frame.locator('#notesHelpTrigger').click()
    expect(frame.locator('#notesHelp')).to_be_visible()
    frame.locator('[data-close-dialog="notesHelp"]').click()
    expect(frame.locator('#notesHelp')).not_to_be_visible()
    page.close()


def test_bulk(context, base_url, errors):
    page, frame = open_library(context, base_url, errors)
    frame.locator('#notesSelect').click()
    expect(frame.locator('#notesBulk')).to_be_visible()
    expect(frame.locator('[data-bulk-action="all"]')).to_be_enabled()
    frame.locator('[data-bulk-action="all"]').click()
    expect(frame.locator('#notesSelectedCount')).to_have_text('5')
    frame.locator('[data-bulk-action="clear"]').click()
    card(frame, ONE).locator('.notes-card__select').click()
    card(frame, TWO).locator('.notes-card__select').click()
    expect(frame.locator('#notesSelectedCount')).to_have_text('2')
    frame.locator('[data-bulk-action="trash"]').click()
    expect(cards(frame)).to_have_count(3)
    expect(frame.locator('#notesUndo')).to_be_visible()
    frame.locator('#notesUndo').click()
    expect(cards(frame)).to_have_count(5)
    expect(frame.locator('#notesTrashCount')).to_have_text('1')
    frame.locator('[data-filter="trash"]').click()
    expect(card(frame, SIX)).to_be_visible()
    card(frame, SIX).locator('.notes-card__select').click()
    frame.locator('[data-bulk-action="delete"]').click()
    expect(frame.locator('#notesConfirm')).to_be_visible()
    frame.locator('#notesConfirmCancel').click()
    expect(card(frame, SIX)).to_be_visible()
    frame.locator('[data-bulk-action="restore"]').click()
    expect(cards(frame)).to_have_count(0)
    frame.locator('[data-filter="all"]').click()
    expect(cards(frame)).to_have_count(6)
    frame.locator('#notesSelect').click()
    # Selection always consumes Escape before the quick host could close.
    frame.locator('#notesSelect').click()
    frame.locator('#notesSelect').press('Escape')
    expect(frame.locator('#notesBulk')).not_to_be_visible()
    frame.locator('#notesShowAll').click()
    frame.locator('#notesHideAll').click()
    visibility = page.evaluate('window.__noteCalls.filter(call=>call.command==="set_sticky_notes_visible").map(call=>call.args.visible)')
    assert visibility == [True, False], visibility
    page.close()


def test_files(context, base_url, errors):
    page, frame = open_library(context, base_url, errors)
    menu_action(frame, ONE, 'copy')
    page.wait_for_function('window.__noteTextCopies.length===1')
    assert page.evaluate('window.__noteTextCopies[0]') == '# 工作清单\n\n- [ ] 设计审查\n- [x] 同步记录\n\n#工作 #灵感\n'
    card(frame, ONE).locator('summary').click()
    with page.expect_download() as pending:
        card(frame, ONE).locator('[data-note-action="export"]').click()
    download = pending.value
    assert download.suggested_filename == '工作清单.md'
    assert '- [x] 同步记录' in Path(download.path()).read_text(encoding='utf-8')
    with page.expect_download() as pending:
        frame.locator('#notesExport').click()
    backup = json.loads(Path(pending.value.path()).read_text(encoding='utf-8'))
    assert backup['format'] == 'dtkit-sticky-notes'
    assert len(backup['notes']) == 6
    assert len([note for note in backup['notes'] if note['trashedAt']]) == 1
    # Export queries persistence, even before a separate editor's change event
    # has refreshed this library. A read failure must not create a stale backup.
    page.evaluate('window.__noteItems[0].content="刚刚在独立小窗保存的最新内容"')
    expect(card(frame, ONE).locator('.notes-card__content p')).not_to_contain_text('刚刚在独立小窗')
    with page.expect_download() as pending:
        frame.locator('#notesExport').click()
    backup = json.loads(Path(pending.value.path()).read_text(encoding='utf-8'))
    assert next(note for note in backup['notes'] if note['title'] == '工作清单')['content'] == '刚刚在独立小窗保存的最新内容'
    failed_downloads = []
    page.on('download', lambda item: failed_downloads.append(item.suggested_filename))
    page.evaluate('window.__noteFailure.list_sticky_notes="最新便签读取测试失败"')
    frame.locator('#notesExport').click()
    expect(frame.locator('#notesNotice')).to_contain_text('备份失败')
    assert failed_downloads == [], failed_downloads
    page.evaluate('delete window.__noteFailure.list_sticky_notes')
    frame.locator('#notesImportFile').set_input_files({'name': 'bad.json', 'mimeType': 'application/json', 'buffer': b'{broken'})
    expect(frame.locator('#notesNotice')).to_contain_text('无法解析')
    assert call_count(page, 'import_sticky_notes') == 0
    frame.locator('#notesImportFile').set_input_files({'name': '导入灵感.md', 'mimeType': 'text/markdown', 'buffer': '## 一点想法\n- [ ] 去实现\n#灵感'.encode()})
    expect(frame.locator('#notesConfirm')).to_be_visible()
    expect(frame.locator('#notesConfirmMessage')).to_contain_text('现有便签会完整保留')
    frame.locator('#notesConfirmAccept').click()
    expect(cards(frame)).to_have_count(6)
    assert page.evaluate('window.__noteItems.some(note=>note.title==="导入灵感"&&note.content.includes("去实现"))')
    frame.locator('#notesImportFile').set_input_files({'name': 'backup.json', 'mimeType': 'application/json', 'buffer': json.dumps(backup, ensure_ascii=False).encode()})
    expect(frame.locator('#notesConfirm')).to_be_visible()
    expect(frame.locator('#notesConfirmMessage')).to_contain_text('1 张会保留在回收站')
    frame.locator('#notesConfirmAccept').click()
    expect(frame.locator('#notesActiveCount')).to_have_text('11')
    expect(frame.locator('#notesTrashCount')).to_have_text('2')
    page.close()


def test_quick_visual(context, base_url, errors):
    page, frame = open_library(context, base_url, errors, quick=True)
    page.set_viewport_size({'width': 390, 'height': 850})
    settle_motion(frame)
    assert frame.locator('.notes-shell').evaluate('element=>element.scrollWidth<=element.clientWidth+1')
    page.screenshot(path=str(OUTPUT / 'library-quick-390.png'), full_page=True)
    card(frame, ONE).locator('summary').click()
    panel = card(frame, ONE).locator('.notes-card-menu__panel')
    expect(panel).to_be_visible()
    bounds = panel.bounding_box()
    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 391, bounds
    page.screenshot(path=str(OUTPUT / 'library-quick-menu-390.png'), full_page=True)
    card(frame, ONE).locator('summary').click()
    frame.locator('#notesCreate').click()
    frame.locator('[data-template="todo"]').click()
    settle_motion(frame)
    page.screenshot(path=str(OUTPUT / 'library-composer-390.png'))
    frame.locator('#notesComposeCancel').click()
    frame.locator('#notesHelpTrigger').click()
    expect(frame.locator('#notesHelp')).to_be_visible()
    settle_motion(frame)
    page.screenshot(path=str(OUTPUT / 'library-help-390.png'))
    frame.locator('[data-close-dialog="notesHelp"]').click()
    frame.evaluate('document.documentElement.dataset.theme="dark"')
    frame.evaluate('()=>{for(const element of document.querySelectorAll("*"))if(element.scrollTop)element.scrollTop=0;window.scrollTo(0,0);}')
    settle_motion(frame)
    paper_color = card(frame, ONE).evaluate('element=>getComputedStyle(element).backgroundColor')
    assert paper_color == 'rgb(60, 54, 39)', paper_color
    page.screenshot(path=str(OUTPUT / 'library-quick-dark-390.png'), full_page=True)
    page.emulate_media(reduced_motion='reduce')
    frame.locator('[data-filter="pinned"]').click()
    expect(cards(frame)).to_have_count(1)
    frame.locator('[data-filter="all"]').click()
    expect(cards(frame)).to_have_count(5)
    assert frame.locator('#notesList [inert]').count() == 0
    frame.locator('[data-layout="list"]:is(button)').click()
    assert card(frame, ONE).evaluate('element=>element.getAnimations().length') == 0
    page.close()


def run(base_url, selected=None):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for key, case in [('filters', test_filters_motion), ('composer', test_composer), ('bulk', test_bulk), ('files', test_files), ('quick', test_quick_visual)]:
                if selected and selected != key:
                    continue
                print('Sticky library UI: ' + key, flush=True)
                context = new_context(browser, base_url)
                try:
                    start = len(errors)
                    case(context, base_url, errors)
                    assert errors[start:] == [], errors[start:]
                except Exception:
                    for index, page in enumerate(context.pages):
                        page.screenshot(path=str(OUTPUT / f'failure-{key}-{index}.png'), full_page=True)
                    raise
                finally:
                    context.close()
        finally:
            browser.close()
    print('PASS: sticky-note library production UI, screenshots=' + str(OUTPUT))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', choices=['filters', 'composer', 'bulk', 'files', 'quick'])
    args = parser.parse_args()
    with multi.production_url() as url:
        run(url, args.case)
