"""Real Windows WebView checks for timetable edits and the desktop widget.

Uses the shared native harness and its mandatory isolated native-smoke identifier.
Only the child test process and its own WebView profile are touched. Generated
localStorage data is restored in finally; no real timetable or clipboard is read.
"""
import argparse
import ctypes
import importlib.util
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load('native', 'native-webview-ui-smoke.py')
redesign = load('redesign', 'timetable-redesign-ui-smoke.py')


def invoke(page, command, args=None):
    return page.evaluate('({command,args})=>window.__TAURI__.core.invoke(command,args)',
                         {'command': command, 'args': args or {}})


def owned_widget_handle(process):
    from ctypes import wintypes
    user = ctypes.windll.user32
    user.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user.GetWindowLongW.restype = ctypes.c_long
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    matches = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def inspect(handle, _):
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        title = ctypes.create_unicode_buffer(256)
        user.GetWindowTextW(handle, title, 256)
        if pid.value == process.pid and title.value == 'DtKit · 我的课表':
            matches.append(handle)
        return True

    user.EnumWindows(callback_type(inspect), 0)
    assert len(matches) == 1, matches
    return matches[0]


def scenario(manager, context, process):
    def until(predicate):
        def pump():
            manager.wait_for_timeout(30)
            return predicate()
        native.wait_until(pump)

    until(lambda: manager.evaluate('window.__DTKIT_TOOL_PAGE__?.ready===true'))
    key = redesign.KEY
    baseline = manager.evaluate('(key)=>localStorage.getItem(key)', key)
    context.add_init_script(redesign.CLOCK)
    manager.evaluate('({key,data})=>localStorage.setItem(key,JSON.stringify(data))',
                     {'key': key, 'data': redesign.fixture()})
    widget = None
    try:
        manager.reload(wait_until='networkidle')
        expect(manager.locator('#ttGrid .tt-course')).to_have_count(6)
        manager.locator('[data-tt-action="add"]').first.click()
        manager.locator('#ttCourseName').focus()
        manager.keyboard.type('Native timetable course')
        manager.locator('#ttCourseDay').select_option('1')
        manager.locator('#ttCourseStart').select_option('1')
        manager.locator('#ttCourseRoom').fill('Generated Room 101')
        manager.get_by_role('button', name='保存课程', exact=True).click()
        expect(manager.locator('#ttDialog')).not_to_be_visible()
        expect(manager.locator('#ttGrid .tt-course').filter(has_text='Native timetable course')).to_have_count(1)
        saved = manager.evaluate('(key)=>JSON.parse(localStorage.getItem(key))', key)
        assert len(saved['semester']['courses']) == 7
        assert any(item['room'] == 'Generated Room 101' for item in saved['semester']['courses'])
        manager.locator('#ttUndo').click()
        until(lambda: manager.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).semester.courses.length', key) == 6)
        manager.locator('#ttRedo').click()
        until(lambda: manager.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).semester.courses.length', key) == 7)

        invoke(manager, 'open_timetable_widget', {'pinned': False})
        until(lambda: any('/timetable-widget.html' in page.url for page in context.pages))
        widget = next(page for page in context.pages if '/timetable-widget.html' in page.url)
        expect(widget.locator('#ttWidgetCurrent')).to_have_text('高等数学')
        expect(widget.locator('#ttWidgetCountdown')).to_contain_text('25 分钟')
        widget.locator('#ttWidgetPin').click()
        expect(widget.locator('#ttWidgetPin')).to_have_attribute('aria-pressed', 'true')
        handle = owned_widget_handle(process)
        until(lambda: bool(ctypes.windll.user32.GetWindowLongW(handle, -20) & 0x00000008))
        until(lambda: manager.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).settings.widgetPinned', key))
        widget.locator('#ttWidgetMode').click()
        expect(widget.locator('#ttWidgetBoard')).to_be_visible()
        expect(widget.locator('#ttWidgetGrid .tt-course')).to_have_count(7)
        # A store update from another real WebView reaches the visible widget.
        manager.evaluate('''key=>{const data=JSON.parse(localStorage.getItem(key));data.semester.name='Native shared schedule';data.revision++;localStorage.setItem(key,JSON.stringify(data));dispatchEvent(new Event('dtkit:timetable-changed'));}''', key)
        expect(widget.locator('#ttWidgetTitle')).to_have_text('Native shared schedule')
        widget.locator('#ttWidgetPin').click()
        until(lambda: not bool(ctypes.windll.user32.GetWindowLongW(handle, -20) & 0x00000008))
        widget.locator('#ttWidgetClose').click()
        until(widget.is_closed)
        widget = None
        print('Native timetable: real keyboard course save, undo/redo, cross-WebView storage, widget open/mode, OS topmost toggle and close passed', flush=True)
    finally:
        if widget is not None and not widget.is_closed():
            invoke(manager, 'close_timetable_widget')
            until(widget.is_closed)
        if not manager.is_closed():
            manager.evaluate('({key,baseline})=>{if(baseline===null)localStorage.removeItem(key);else localStorage.setItem(key,baseline)}',
                             {'key': key, 'baseline': baseline})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert executable.is_file(), executable
    with sync_playwright() as playwright:
        native.run_case(playwright, executable, ['--tool', 'timetable'], scenario)
