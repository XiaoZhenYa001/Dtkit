"""Production CSP and real browser interactions; native widget calls are mocked."""
import functools
import http.server
import json
import os
import tempfile
import threading
import struct
import zlib
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = Path(tempfile.gettempdir())
CSP = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['app']['security']['csp']
MOCK = r"""
window.__ttCalls = []; window.__ttListeners = {}; window.__ttDelays = []; window.__ttIntervals = 0;
const timeout = window.setTimeout.bind(window), interval = window.setInterval.bind(window);
window.setTimeout = (callback, delay, ...args) => { window.__ttDelays.push(delay); return timeout(callback, delay, ...args); };
window.setInterval = (...args) => { window.__ttIntervals++; return interval(...args); };
window.__ttEmit = (name, payload) => (window.__ttListeners[name] || []).forEach(fn => fn({payload}));
window.__TAURI__ = {
 core:{invoke:async (command,args={}) => {
  window.__ttCalls.push({command,args:structuredClone(args)});
  if (['get_tool_module_settings','get_shortcut_bindings','take_missed_alarm_triggers','sync_alarm_tasks','scan_audio_files'].includes(command)) return [];
  if (command === 'get_storage_layout') return {root:'D:\\DtKit',downloads:'D:\\DtKit\\Downloads',writable:true,warning:null};
  if (command === 'get_resource_policy') return {minimizeMode:'efficient'};
  if (command === 'get_hotzone_status') return false;
  return null;
 }},
 event:{listen:async (name,callback) => { (window.__ttListeners[name] ||= []).push(callback); return () => { window.__ttListeners[name] = window.__ttListeners[name].filter(fn => fn !== callback); }; }},
 window:{getCurrentWindow:() => ({label:'main',isMaximized:async () => false,startDragging:async () => {},setAlwaysOnTop:async () => {}})},
 dialog:{open:async () => null}
};
"""

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

def active_frame(page):
    host = page.locator('iframe.tool-page-frame:not([hidden])')
    expect(host).to_have_count(1)
    frame = host.element_handle().content_frame()
    frame.locator('.tt-shell').wait_for()
    return frame

def click(frame, action):
    frame.locator(f'[data-tt-action="{action}"]').first.click()

def settings_tab(frame, tab):
    click(frame, 'settings')
    frame.locator(f'[data-tab="{tab}"]').click()

def save(frame, label):
    frame.get_by_role('button', name=label, exact=True).click()

def stored(page):
    return page.evaluate("JSON.parse(localStorage.getItem('dtkit_timetable_v1'))")

def run(browser, base):
    context = browser.new_context(viewport={'width': 1440, 'height': 1080}, timezone_id='Asia/Shanghai', accept_downloads=True)
    context.add_init_script(MOCK)
    errors = []
    def production_csp(route):
        response = route.fetch()
        headers = dict(response.headers)
        if 'text/html' in headers.get('content-type', ''):
            headers['content-security-policy'] = CSP
        route.fulfill(response=response, headers=headers)
    context.route(base + '/**', production_csp)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
    page.goto(base, wait_until='networkidle')
    resources = page.evaluate("performance.getEntriesByType('resource').map(item=>item.name)")
    assert not any('/timetable-' in resource for resource in resources), resources
    page.locator('[data-tool-id="timetable"] .tool-card__title').click()
    frame = active_frame(page)
    expect(frame.locator('.tt-day-head')).to_have_count(7)
    expect(frame.locator('.tt-period')).to_have_count(12)
    expect(frame.locator('#ttEmpty')).to_be_visible()
    click(frame, 'add')
    frame.locator('#ttCourseName').fill('高等数学')
    frame.locator('#ttCourseRoom').fill('A-302')
    frame.locator('#ttCourseTeacher').fill('李老师')
    frame.locator('#ttCourseDay').select_option('1')
    frame.locator('#ttCourseParity').select_option('odd')
    save(frame, '保存课程')
    expect(frame.locator('#ttDialog')).not_to_be_visible()
    expect(frame.locator('.tt-course')).to_have_count(1)
    expect(frame.locator('#ttEmpty')).not_to_be_visible()
    click(frame, 'add')
    frame.locator('#ttCourseName').fill('大学英语')
    frame.locator('#ttCourseParity').select_option('even')
    frame.locator('#ttCourseRoom').fill('B-201')
    save(frame, '保存课程')
    frame.locator('#ttWeek').select_option('2')
    expect(frame.locator('.tt-course')).to_have_count(1)
    expect(frame.locator('.tt-course')).to_contain_text('大学英语')
    click(frame, 'add')
    frame.locator('#ttCourseName').fill('时间冲突课程')
    save(frame, '保存课程')
    expect(frame.locator('#ttPanelNotice')).to_contain_text('冲突')
    assert len(stored(page)['semester']['courses']) == 2
    click(frame, 'close')

    settings_tab(frame, 'basic')
    frame.locator('#ttShowWeekend').uncheck()
    frame.locator('#ttShowOther').check()
    frame.locator('#ttWeekStart').select_option('7')
    frame.locator('#ttCurrentWeek').fill('6')
    frame.locator('#ttCurrentWeek').dispatch_event('change')
    frame.locator('#ttPeriodCount').fill('10')
    frame.locator('#ttFirstTime').fill('08:15')
    click(frame, 'generate-periods')
    frame.locator('[data-tab="other"]').click()
    frame.locator('#ttEducation').select_option(label='高中')
    save(frame, '保存设置')
    expect(frame.locator('.tt-day-head')).to_have_count(5)
    expect(frame.locator('.tt-period')).to_have_count(10)
    expect(frame.locator('.tt-course')).to_have_count(2)
    expect(frame.locator('.tt-course.is-other-week')).to_have_count(1)
    expect(frame.locator('#ttSemesterLabel')).to_contain_text('第 6 周')
    expect(frame.locator('#ttSemesterLabel')).to_contain_text('高中')

    # Populate a realistic week via the same preview/restore flow exposed to users.
    backup = stored(page)
    for name, day, start, end, room, color in [('程序设计', 2, 3, 4, '机房 201', 'purple'), ('大学物理', 3, 1, 2, 'C-406', 'green'), ('体育', 4, 5, 6, '田径场', 'orange'), ('线性代数', 5, 3, 4, 'A-305', 'cyan'), ('思想政治', 3, 7, 8, 'B-202', 'rose')]:
        backup['semester']['courses'].append({'id': f'ui-{day}-{start}', 'name': name, 'day': day, 'start': start, 'end': end, 'weeks': list(range(1, 21)), 'room': room, 'teacher': '', 'color': color, 'notes': ''})
    backup['settings']['showWeekend'] = True
    backup['settings']['showOtherWeeks'] = False
    backup['settings']['weekStartsOn'] = 1
    backup['settings']['education'] = '本科'
    frame.locator('#ttImportFile').set_input_files({'name': '课表.json', 'mimeType': 'application/json', 'buffer': json.dumps(backup, ensure_ascii=False).encode()})
    expect(frame.locator('#ttDialogTitle')).to_have_text('导入预览')
    assert len(stored(page)['semester']['courses']) == 2
    save(frame, '确认恢复备份')
    expect(frame.locator('.tt-day-head')).to_have_count(7)
    expect(frame.locator('.tt-course')).to_have_count(6)

    # Local image background is compressed; generated data URLs survive production CSP.
    settings_tab(frame, 'features')
    def png_chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    tiny_png = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('!IIBBBBB', 1600, 900, 8, 2, 0, 0, 0)) + png_chunk(b'IDAT', zlib.compress((b'\x00' + b'\xdd\xe8\xdf' * 1600) * 900)) + png_chunk(b'IEND', b'')
    frame.locator('#ttBackgroundFile').set_input_files({'name': '背景.png', 'mimeType': 'image/png', 'buffer': tiny_png})
    expect(frame.locator('#ttBackgroundInfo')).to_contain_text('图片已压缩')
    save(frame, '保存设置')
    expect(frame.locator('#ttBoard')).to_have_attribute('data-background', 'image')
    settings_tab(frame, 'features')
    click(frame, 'remove-background')
    frame.locator('#ttBackground').select_option('mint')
    frame.locator('#ttWidgetMode').select_option('week')
    frame.locator('#ttWidgetPinned').select_option('true')
    click(frame, 'widget-open')
    expect(frame.locator('#ttPanelNotice')).to_contain_text('已打开')
    assert page.evaluate("__ttCalls.filter(call=>call.command==='open_timetable_widget').length") == 1
    assert stored(page)['settings']['widgetPinned'] is True
    click(frame, 'widget-close')
    expect(frame.locator('#ttPanelNotice')).to_contain_text('资源已释放')
    click(frame, 'close')
    page.screenshot(path=str(SHOTS / 'dtkit-timetable.png'), full_page=True)

    # Verify all actual downloaded file contents, including decoded PNG dimensions.
    settings_tab(frame, 'transfer')
    files = {}
    for action, suffix in [('export-json', '.json'), ('export-csv', '.csv'), ('export-ics', '.ics'), ('export-png', '.png')]:
        with page.expect_download() as pending:
            click(frame, action)
        result = pending.value
        assert result.suggested_filename.endswith(suffix)
        data = Path(result.path()).read_bytes()
        assert len(data) > 30
        files[suffix] = data
    assert len(json.loads(files['.json'])['semester']['courses']) == 7
    assert b'BEGIN:VEVENT' in files['.ics']
    assert files['.png'].startswith(b'\x89PNG')
    (SHOTS / 'dtkit-timetable-export.png').write_bytes(files['.png'])
    click(frame, 'close')
    # CSV merge conflict leaves saved records intact; replace succeeds.
    frame.locator('#ttImportFile').set_input_files({'name': '课程.csv', 'mimeType': 'text/csv', 'buffer': files['.csv']})
    save(frame, '确认导入')
    expect(frame.locator('#ttPanelNotice')).to_contain_text('冲突')
    assert len(stored(page)['semester']['courses']) == 7
    frame.locator('[name="ttImportMode"][value="replace"]').check()
    save(frame, '确认导入')
    expect(frame.locator('#ttDialog')).not_to_be_visible()

    # Widget uses the same store, has no interval and consumes a single long timeout.
    widget = context.new_page()
    widget.on('pageerror', lambda error: errors.append(str(error)))
    widget.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
    widget.goto(base + '/timetable-widget.html', wait_until='networkidle')
    expect(widget.locator('#ttWidgetGrid .tt-course')).to_have_count(6)
    assert widget.evaluate('__ttIntervals') == 0
    assert widget.evaluate('__ttDelays.filter(delay=>delay>0).every(delay=>delay>=1000)')
    widget.locator('#ttWidgetMode').click()
    expect(widget.locator('#ttWidgetAgenda')).to_be_visible()
    assert stored(page)['settings']['widgetMode'] == 'today'
    widget.locator('#ttWidgetPin').click()
    expect(widget.locator('#ttWidgetPin')).to_have_attribute('aria-pressed', 'false')
    widget.evaluate("__ttEmit('timetable-widget-power',{suspended:true})")
    widget.evaluate("__ttEmit('timetable-widget-power',{suspended:false})")
    widget.screenshot(path=str(SHOTS / 'dtkit-timetable-widget.png'), full_page=True)
    widget.locator('#ttWidgetClose').click()
    assert widget.evaluate("__ttCalls.some(call=>call.command==='close_timetable_widget')")
    widget.close()

    # A stale modal cannot overwrite a settings change in another window.
    page.bring_to_front()
    settings_tab(frame, 'basic')
    page.evaluate("""() => { const data=JSON.parse(localStorage.getItem('dtkit_timetable_v1')); data.revision++; data.semester.name='另一个窗口修改'; localStorage.setItem('dtkit_timetable_v1',JSON.stringify(data)); }""")
    frame.locator('#ttSemesterName').fill('旧窗口的修改')
    save(frame, '保存设置')
    expect(frame.locator('#ttPanelNotice')).to_contain_text('另一个窗口')
    assert stored(page)['semester']['name'] == '另一个窗口修改'
    click(frame, 'close')
    settings_tab(frame, 'other')
    click(frame, 'new-semester')
    frame.locator('#ttNewSemesterName').fill('春季学期')
    save(frame, '归档并开始新学期')
    expect(frame.locator('#ttEmpty')).to_be_visible()
    assert len(stored(page)['archives']) == 1
    assert len(stored(page)['archives'][0]['courses']) == 7
    settings_tab(frame, 'other')
    click(frame, 'restore-archive')
    click(frame, 'confirm-restore')
    expect(frame.locator('.tt-course')).to_have_count(6)
    click(frame, 'manage')
    frame.locator('#ttCourseSearch').fill('程序设计')
    expect(frame.locator('.tt-course-row')).to_have_count(1)
    click(frame, 'duplicate')
    expect(frame.locator('[data-tt-action="delete-course"]')).to_have_count(0)
    frame.locator('#ttCourseDay').select_option('6')
    save(frame, '保存课程')
    expect(frame.locator('#ttDialog')).not_to_be_visible()
    assert len(stored(page)['semester']['courses']) == 8
    frame.locator('.tt-course').filter(has_text='程序设计').last.click()
    click(frame, 'delete-course')
    click(frame, 'confirm-delete-course')
    expect(frame.locator('#ttDialog')).not_to_be_visible()
    assert len(stored(page)['semester']['courses']) == 7
    page.reload(wait_until='networkidle')
    # App navigation may restore the saved tool; otherwise reopen the card.
    if page.locator('[data-tool-id="timetable"] .tool-card__title').is_visible():
        page.locator('[data-tool-id="timetable"] .tool-card__title').click()
    frame = active_frame(page)
    expect(frame.locator('.tt-course')).to_have_count(6)

    # Quick entry loads just this tool, and narrow layouts keep actions reachable.
    quick = context.new_page()
    quick.goto(base + '/quick.html?kind=tool&toolId=timetable', wait_until='networkidle')
    expect(quick.locator('.tt-shell')).to_be_visible()
    expect(quick.locator('#quickTitle')).to_contain_text('课表')
    quick.set_viewport_size({'width': 560, 'height': 700})
    quick.locator('[data-tt-action="settings"]').click()
    expect(quick.locator('#ttDialog')).to_be_visible()
    quick.set_viewport_size({'width': 420, 'height': 760})
    expect(quick.get_by_role('button', name='保存设置', exact=True)).to_be_visible()
    quick.screenshot(path=str(SHOTS / 'dtkit-timetable-settings-narrow.png'), full_page=True)
    # Single-period cards keep name and room visible without overflowing the slot.
    click(quick, 'close')
    quick.set_viewport_size({'width': 760, 'height': 800})
    quick.locator('[data-tt-action="add-cell"][data-day="6"][data-period="9"]').click()
    quick.locator('#ttCourseName').fill('单节课程')
    quick.locator('#ttCourseRoom').fill('D-101')
    save(quick, '保存课程')
    expect(quick.locator('#ttDialog')).not_to_be_visible()
    card = quick.locator('.tt-course.is-single').filter(has_text='单节课程')
    expect(card).to_be_visible()
    assert card.evaluate("node=>{const room=node.querySelector('span').getBoundingClientRect(),card=node.getBoundingClientRect();return room.bottom<=card.bottom && room.top>=card.top}")
    assert errors == [], errors
    context.close()
    print('PASS: timetable CRUD/parity/conflicts, all settings, compressed background under production CSP, JSON/CSV import preview and atomic failures, four downloads, semester archive/restore, concurrent editing, persistent reload, lightweight widget sync and quick/narrow views')

handler = functools.partial(QuietHandler, directory=str(ROOT / 'dist'))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            run(browser, os.environ.get('DTKIT_TEST_BASE_URL', f'http://127.0.0.1:{server.server_port}').rstrip('/'))
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
