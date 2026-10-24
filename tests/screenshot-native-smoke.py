"""Exercise screenshot IPC using an isolated app and a generated desktop fixture.

The shared harness rejects production storage and stops only its own child PID.
Every captured region is covered by this test's Tk window. Export and OCR inputs
are generated canvases, and no captured desktop data is written to diagnostics.
"""
import argparse
import base64
import ctypes
import importlib.util
import subprocess
import time
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from PIL import Image
from playwright.sync_api import Error, expect, sync_playwright

spec = importlib.util.spec_from_file_location('native_webview', Path(__file__).with_name('native-webview-ui-smoke.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
clip_spec = importlib.util.spec_from_file_location('clipboard_fixture', Path(__file__).with_name('windows-clipboard-fixture.py'))
clip_module = importlib.util.module_from_spec(clip_spec)
clip_spec.loader.exec_module(clip_module)


def invoke(page, command, args=None):
    return page.evaluate('''({command,args})=>{
        const core=Object.getPrototypeOf(window.__TAURI__)?.core || window.__TAURI__.core;
        return core.invoke(command,args);
    }''',
                         {'command': command, 'args': args or {}})


def overlays(context):
    return [page for page in context.pages if 'screen-region.html' in page.url or 'long-capture-border.html' in page.url]


def main_and_quick_visibility(main, context, process):
    """User-requested hiding includes main even when a quick window owns it."""
    import tkinter as tk
    from ctypes import wintypes
    user=ctypes.windll.user32
    fixture=tk.Tk();fixture.overrideredirect(True);fixture.attributes('-topmost',True)
    vx,vy,vw,vh=[user.GetSystemMetrics(index) for index in (76,77,78,79)]
    fixture.geometry(f'{vw}x{vh}+0+0');fixture.configure(background='#d8ebfa');fixture.update()
    user.SetWindowPos(fixture.winfo_id(),-1,vx,vy,vw,vh,0x0040)
    def wait(predicate,timeout=15):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            fixture.update();main.wait_for_timeout(40)
            if predicate():return
        raise AssertionError('Main and quick screenshot visibility did not settle')
    def app_handles():
        result=[]
        callback_type=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
        def inspect(handle,_):
            pid=wintypes.DWORD();user.GetWindowThreadProcessId(handle,ctypes.byref(pid))
            title=ctypes.create_unicode_buffer(256);user.GetWindowTextW(handle,title,256)
            if pid.value==process.pid and title.value in ['DtKit','DtKit 快捷窗口']:result.append(handle)
            return True
        user.EnumWindows(callback_type(inspect),0)
        return result
    request={'instanceId':'native-main-visibility','requestId':'hidden-'+uuid4().hex}
    try:
        invoke(main,'open_quick_host',{'target':{'kind':'tool','toolId':'timestamp-converter'}})
        wait(lambda:len(context.pages)==2)
        quick=next(page for page in context.pages if page!=main)
        wait(lambda:quick.evaluate('window.__DTKIT_TOOL_PAGE__?.ready===true'))
        request['instanceId']=quick.evaluate('window.__DTKIT_TOOL_PAGE_CONTEXT.instanceId')
        handles=app_handles();assert len(handles)==2,handles
        assert all(user.IsWindowVisible(handle) for handle in handles)
        quick.evaluate('''async()=>{window.__visibilityShots=[];await window.__TAURI__.event.listen('screen-region-captured',event=>window.__visibilityShots.push(event.payload));}''')
        for cancel in [False,True]:
            request['requestId']='hidden-'+uuid4().hex
            invoke(quick,'start_screen_region_capture',{**request,'keepHidden':True})
            wait(lambda:len(overlays(context))==1)
            assert all(not user.IsWindowVisible(handle) for handle in handles)
            overlay=overlays(context)[0];expect(overlay.locator('#regionLoading')).to_be_hidden()
            if cancel:overlay.keyboard.press('Escape')
            else:
                overlay.mouse.move(100,100);overlay.mouse.down();overlay.mouse.move(480,350);overlay.mouse.up();overlay.keyboard.press('Enter')
            wait(lambda:not overlays(context))
            wait(lambda:quick.evaluate('request=>window.__visibilityShots.some(result=>result.requestId===request)',request['requestId']))
            main.wait_for_timeout(300)
            assert all(not user.IsWindowVisible(handle) for handle in handles), 'Completion and cancellation must leave all DtKit windows hidden'
            # A deliberate second launch follows the same ensure_main_window
            # path as a tray click, restoring the retained original quick view.
            returning=subprocess.Popen([process.args[0]],cwd=Path(process.args[0]).parent,creationflags=subprocess.CREATE_NO_WINDOW)
            returning.wait(timeout=10)
            wait(lambda:all(user.IsWindowVisible(handle) for handle in handles))
            assert len(context.pages)==2, 'Returning must restore the original windows, preserving the captured result'
        print('Native main and quick windows stayed hidden after success/cancel and returned only on an explicit user launch',flush=True)
    finally:
        fixture.destroy()


def scenario(owner, context, process, clipboard=None):
    fixture = None

    def until(predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if fixture is not None:
                fixture.update()
            owner.wait_for_timeout(40)
            if predicate():
                return
        raise AssertionError('Native screenshot state did not settle')

    until(lambda: owner.evaluate('window.__DTKIT_TOOL_PAGE__?.ready === true'))
    token = uuid4().hex
    instance_id = owner.evaluate('window.__DTKIT_TOOL_PAGE_CONTEXT.instanceId')
    from ctypes import wintypes
    user = ctypes.windll.user32
    handles = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def owned_window(handle, _):
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        if pid.value == process.pid and user.IsWindowVisible(handle):
            title = ctypes.create_unicode_buffer(256)
            user.GetWindowTextW(handle, title, 256)
            if title.value == 'DtKit 快捷窗口':
                handles.append(handle)
        return True
    user.EnumWindows(callback_type(owned_window), 0)
    assert len(handles) == 1, handles
    owner_handle = handles[0]
    request = {'instanceId': instance_id, 'requestId': 'capture-' + token}
    owner.evaluate('''async () => {
        window.__nativeShots=[];
        await window.__TAURI__.event.listen('screen-region-captured',event=>window.__nativeShots.push(event.payload));
    }''')
    invoke(owner, 'open_quick_host', {'target': {'kind': 'tool', 'toolId': 'timestamp-converter'}})
    until(lambda: len(context.pages) == 2)
    other = next(page for page in context.pages if page != owner)
    until(lambda: other.evaluate('window.__DTKIT_TOOL_PAGE__?.ready === true'))
    baseline = invoke(owner, 'get_resource_snapshot')['webviewCount']
    assert baseline == 2

    png = owner.evaluate('''() => {
        const canvas=document.createElement('canvas'); canvas.width=600;canvas.height=220;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,600,220);
        ctx.fillStyle='#111';ctx.font='bold 56px Arial';ctx.fillText('DTKIT 12345',35,125);
        return canvas.toDataURL('image/png');
    }''')
    saved = None
    editor_saved = None
    try:
        saved = Path(invoke(owner, 'save_annotated_screenshot', {'filename': 'native-shot-' + token + '.png', 'dataUrl': png}))
        assert native.IDENTIFIER in str(saved), saved
        assert saved.read_bytes() == base64.b64decode(png.split(',', 1)[1])
        assert Image.open(saved).size == (600, 220)
        for command, args in [
            ('save_annotated_screenshot', {'filename': saved.name, 'dataUrl': png}),
            ('save_annotated_screenshot', {'filename': 'invalid-' + token + '.png', 'dataUrl': 'data:image/png;base64,AA=='}),
            ('copy_screenshot_to_clipboard', {'dataUrl': 'data:image/png;base64,AA=='}),
            ('recognize_screenshot_text', {'dataUrl': 'data:image/png;base64,AA=='}),
        ]:
            failure = owner.evaluate('''async ({command,args})=>{
                try {await Object.getPrototypeOf(window.__TAURI__).core.invoke(command,args);return null;}
                catch(error){return String(error);}
            }''', {'command': command, 'args': args})
            assert failure, command
        if clipboard is not None:
            invoke(owner, 'copy_screenshot_to_clipboard', {'dataUrl': png})
            clipboard.remember()
            png_format = ctypes.windll.user32.RegisterClipboardFormatW('PNG')
            assert ctypes.windll.user32.IsClipboardFormatAvailable(png_format)
            assert ctypes.windll.user32.IsClipboardFormatAvailable(17)  # CF_DIBV5
        recognized = invoke(owner, 'recognize_screenshot_text', {'dataUrl': png})
        compact = ''.join(recognized['text'].upper().split())
        assert '12345' in compact and 'DTKIT' in compact, recognized
        assert recognized['language'], recognized
        print('Native PNG save validation and local OCR passed: ' + recognized['language'], flush=True)
        print('Native dual-format clipboard passed' if clipboard is not None else 'SKIP: clipboard copy requires a lossless backup of existing content', flush=True)

        # Both commands are posted from one JS task; cancellation can overtake
        # the first poll of an async start command.
        owner.evaluate('''async request=>{
            const invoke=Object.getPrototypeOf(window.__TAURI__).core.invoke;
            const start=invoke('start_screen_region_capture',{...request,delayMs:10000});
            await invoke('cancel_screen_region_capture',request);await start;
        }''', request)
        until(lambda: not overlays(context))
        assert invoke(owner, 'get_resource_snapshot')['webviewCount'] == baseline
        until(lambda: bool(user.IsWindowVisible(owner_handle)))

        # Cover the complete virtual desktop with our own generated pixels.
        # No other application is targeted by selection or scrolling.
        import tkinter as tk
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except OSError:
            pass
        user = ctypes.windll.user32
        vx, vy, vw, vh = [user.GetSystemMetrics(index) for index in (76, 77, 78, 79)]
        fixture = tk.Tk()
        fixture.overrideredirect(True)
        fixture.attributes('-topmost', True)
        fixture.geometry(f'{vw}x{vh}+0+0')
        board = tk.Canvas(fixture, bg='#eaf3ff', highlightthickness=0)
        board.pack(fill='both', expand=True)
        for y in range(0, vh, 90):
            board.create_rectangle(0, y, vw, y + 44, fill='#cfe5ff', outline='')
            board.create_text(100, y + 28, anchor='w', text=f'DTKIT SCREENSHOT FIXTURE {y}', fill='#164881', font=('Arial', 18, 'bold'))
        fixture.update()
        user.SetWindowPos(fixture.winfo_id(), -1, vx, vy, vw, vh, 0x0040)
        fixture.update()

        request['requestId'] = 'delayed-' + token
        started = time.monotonic()
        owner.evaluate('''request=>{
            window.__shotStart=Object.getPrototypeOf(window.__TAURI__).core.invoke('start_screen_region_capture',{...request,delayMs:3000});
            return true;
        }''', request)
        until(lambda: not user.IsWindowVisible(owner_handle))
        invoke(other, 'cancel_screen_region_capture', request)
        invoke(owner, 'cancel_screen_region_capture', {**request, 'instanceId': 'wrong-page'})
        invoke(owner, 'cancel_screen_region_capture', {**request, 'requestId': 'wrong-request'})
        failure = owner.evaluate('''async request=>{try{await Object.getPrototypeOf(window.__TAURI__).core.invoke('start_screen_region_capture',request);return null;}catch(error){return String(error)}}''', request)
        assert failure and '已有' in failure, failure
        until(lambda: len(overlays(context)) == 1)
        assert time.monotonic() - started >= 2.8
        overlay = overlays(context)[0]
        expect(overlay.locator('#regionLoading')).to_be_hidden(timeout=15000)
        overlay.mouse.move(100, 100); overlay.mouse.down(); overlay.mouse.move(480, 350); overlay.mouse.up()
        expect(overlay.locator('#regionSize')).not_to_have_text('0 × 0')
        overlay.keyboard.press('H')
        overlay.mouse.move(170, 180); overlay.mouse.down(); overlay.mouse.move(330, 180); overlay.mouse.up()
        overlay.keyboard.press('N'); overlay.mouse.click(210, 250)
        overlay.keyboard.press('Control+z')
        expect(overlay.locator('#regionRedo')).to_be_enabled()
        overlay.keyboard.press('Control+Shift+z')
        overlay.keyboard.press('ArrowRight')
        overlay.keyboard.press('Enter')
        until(lambda: not overlays(context))
        until(lambda: owner.evaluate('window.__nativeShots.some(result=>result.requestId.startsWith("delayed-")&&!result.cancelled)'))
        result = owner.evaluate('window.__nativeShots.find(result=>result.requestId.startsWith("delayed-")&&!result.cancelled)')
        actual = Image.open(BytesIO(base64.b64decode(result['capture']['dataUrl'].split(',', 1)[1])))
        assert actual.width > 300 and actual.height > 200
        assert actual.getpixel((0, 0))[:3] in [(234,243,255), (207,229,255)], actual.getpixel((0, 0))
        assert invoke(owner, 'get_resource_snapshot')['webviewCount'] == baseline
        print('Native hidden-window delay, request isolation, generated-region annotation and undo/redo passed', flush=True)

        request['requestId'] = 'long-' + token
        invoke(owner, 'start_screen_region_capture', {**request, 'longDirection': 'vertical', 'maxSegments': 20})
        until(lambda: len(overlays(context)) == 1)
        overlay = overlays(context)[0]
        expect(overlay.locator('#regionLoading')).to_be_hidden(timeout=15000)
        overlay.mouse.move(100, 100); overlay.mouse.down(); overlay.mouse.move(480, 350); overlay.mouse.up()
        overlay.keyboard.press('Enter')
        until(lambda: any('long-capture-border.html' in page.url for page in context.pages))
        invoke(owner, 'cancel_screen_region_capture', request)
        until(lambda: not overlays(context))
        until(lambda: bool(user.IsWindowVisible(owner_handle)))
        assert invoke(owner, 'get_resource_snapshot')['webviewCount'] == baseline
        assert owner.evaluate('window.__nativeShots.at(-1).cancelled')
        print('Native long-capture cancellation removed the scrolling border and restored windows', flush=True)

        # Manual mode must never synthesize scrolling. The only wheel input
        # below is generated by this test over its own full-desktop fixture.
        from PIL import ImageTk
        pattern = Image.new('RGB', (600, 1800))
        pattern.putdata([((x * 13 + y * 17) % 251, (x * 3 + y * 23) % 253, (x * 31 + y * 7) % 255)
                         for y in range(1800) for x in range(600)])
        pattern_image = ImageTk.PhotoImage(pattern, master=fixture)
        board.delete('all');board.create_image(0, 0, image=pattern_image, anchor='nw')
        board.configure(scrollregion=(0, 0, vw, max(vh + 1000, 1800)), yscrollincrement=1)
        wheel_events = []
        enter_events = []
        def scroll_fixture(event):
            wheel_events.append(event.delta)
            board.yview_scroll(60 if event.delta < 0 else -60, 'units')
        board.bind('<MouseWheel>', scroll_fixture)
        fixture.bind('<Return>', lambda event: enter_events.append(True))
        board.focus_set();fixture.update()
        request['requestId'] = 'manual-' + token
        invoke(owner, 'start_screen_region_capture', {**request, 'longDirection': 'vertical', 'longMode': 'manual', 'maxSegments': 5, 'keepHidden': True})
        until(lambda: len(overlays(context)) == 1)
        overlay = overlays(context)[0]
        expect(overlay.locator('#regionLoading')).to_be_hidden(timeout=15000)
        overlay.mouse.move(100, 100);overlay.mouse.down();overlay.mouse.move(480, 350);overlay.mouse.up()
        selected_size = [int(value.strip()) for value in overlay.locator('#regionSize').inner_text().split('×')]
        overlay.keyboard.press('Enter')
        until(lambda: any('long-capture-border.html' in page.url for page in context.pages))
        border = next(page for page in context.pages if 'long-capture-border.html' in page.url)
        expect(border.locator('#longCaptureStatus')).to_contain_text('手动')
        until(lambda: '1/5' in border.locator('#longCaptureStatus').inner_text())
        # A pause must not auto-complete, scroll the target, or interpret the
        # Enter used for selection as the Enter used to finish capture.
        owner.wait_for_timeout(800);fixture.update()
        assert not wheel_events and board.yview()[0] == 0, wheel_events
        assert not user.IsWindowVisible(owner_handle)
        assert any('long-capture-border.html' in page.url for page in context.pages)
        user.SetForegroundWindow(fixture.winfo_id());board.focus_set();fixture.update()
        user.SetCursorPos(vx + 200, vy + 200)
        user.mouse_event(0x0800, 0, 0, ctypes.c_uint32(-120).value, 0)
        until(lambda: len(wheel_events) == 1)
        until(lambda: '2/5' in border.locator('#longCaptureStatus').inner_text())
        user.keybd_event(0x0D, 0, 0, 0);owner.wait_for_timeout(70);user.keybd_event(0x0D, 0, 2, 0)
        until(lambda: not overlays(context))
        until(lambda: owner.evaluate('window.__nativeShots.some(result=>result.requestId.startsWith("manual-")&&!result.cancelled)'))
        result = owner.evaluate('window.__nativeShots.find(result=>result.requestId.startsWith("manual-")&&!result.cancelled)')
        actual = Image.open(BytesIO(base64.b64decode(result['capture']['dataUrl'].split(',', 1)[1])))
        assert actual.size == (selected_size[0], selected_size[1] + 60), (actual.size,selected_size)
        sample=(min(150,actual.width-1),selected_size[1]+25)
        source=(result['capture']['x']-vx+sample[0],result['capture']['y']-vy+sample[1])
        assert actual.getpixel(sample)[:3] == pattern.getpixel(source), (actual.getpixel(sample),source)
        fixture.update();assert not enter_events, 'Finishing capture must not also submit Enter to the target app'
        assert not user.IsWindowVisible(owner_handle), 'Manual completion must not reopen DtKit'
        assert len(wheel_events) == 1, wheel_events
        print('Native manual wheel stitching waited for user input, preserved exact seams, swallowed finish Enter and left windows hidden', flush=True)
        board.delete('all');board.yview_moveto(0);fixture.update()
        # Simulate the user's deliberate return before the next test case.
        returning = subprocess.Popen([process.args[0]], cwd=Path(process.args[0]).parent,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
        returning.wait(timeout=10)
        until(lambda: bool(user.IsWindowVisible(owner_handle)))
        until(lambda: invoke(owner, 'get_resource_snapshot')['mainWindowOpen'])
        baseline = invoke(owner, 'get_resource_snapshot')['webviewCount']

        # Exercise the packaged editor and its production CSP end to end.
        # In particular native PNG events must decode without fetching data:
        # URLs, which connect-src intentionally blocks in the desktop app.
        invoke(owner, 'open_quick_host', {'target': {'kind': 'tool', 'toolId': 'screenshot-annotator'}})
        until(lambda: any('toolId=screenshot-annotator' in page.url for page in context.pages))
        editor = next(page for page in context.pages if 'toolId=screenshot-annotator' in page.url)
        until(lambda: editor.evaluate('window.__DTKIT_TOOL_PAGE__?.ready === true'))
        until(lambda: len(overlays(context)) == 1)
        assert not user.IsWindowVisible(owner_handle), 'Starting in an editor must hide other DtKit quick windows'
        overlay = overlays(context)[0]
        expect(overlay.locator('#regionLoading')).to_be_hidden(timeout=15000)
        overlay.mouse.move(40, 70); overlay.mouse.down(); overlay.mouse.move(680, 380); overlay.mouse.up()
        overlay.keyboard.press('Enter')
        until(lambda: not overlays(context))
        expect(editor.locator('#captureViewport')).to_be_visible(timeout=15000)
        expect(editor.locator('#captureLoading')).to_be_hidden()
        assert editor.locator('#captureCanvas').evaluate('canvas=>canvas.width>500&&canvas.height>200')
        assert editor.locator('#captureStatus').get_attribute('data-tone') != 'error'
        editor_handles = []
        def find_editor(handle, _):
            pid = wintypes.DWORD();user.GetWindowThreadProcessId(handle, ctypes.byref(pid))
            title = ctypes.create_unicode_buffer(256);user.GetWindowTextW(handle, title, 256)
            if pid.value == process.pid and title.value == 'DtKit 快捷窗口' and handle != owner_handle:
                editor_handles.append(handle)
            return True
        user.EnumWindows(callback_type(find_editor), 0)
        assert editor_handles
        assert not user.IsWindowVisible(owner_handle), 'Starting in an editor must hide other DtKit quick windows'
        assert all(not user.IsWindowVisible(handle) for handle in editor_handles), 'Completing the editor screenshot must not reopen quick windows'
        returning = subprocess.Popen([process.args[0]], cwd=Path(process.args[0]).parent,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
        returning.wait(timeout=10)
        until(lambda: all(user.IsWindowVisible(handle) for handle in editor_handles))
        editor.locator('#captureFile').set_input_files({'name': 'generated-native-fixture.png', 'mimeType': 'image/png', 'buffer': base64.b64decode(png.split(',', 1)[1])})
        until(lambda: editor.locator('#captureDimensions').inner_text().startswith('600'))
        editor.locator('[data-capture-mode="text"]').click()
        canvas_box = editor.locator('#captureOverlay').bounding_box()
        editor.mouse.click(canvas_box['x'] + canvas_box['width'] * .12,
                           canvas_box['y'] + canvas_box['height'] * .8)
        expect(editor.locator('#captureInlineText')).to_be_focused()
        editor.keyboard.type('NATIVE', delay=15)
        expect(editor.locator('#captureInlineText')).to_have_value('NATIVE')
        editor.keyboard.press('Enter')
        expect(editor.locator('#captureCanvas')).to_have_attribute('data-annotation-count', '1')
        expect(editor.locator('#captureCopy')).to_be_enabled()
        if clipboard is not None:
            editor.locator('#captureCopy').click()
            expect(editor.locator('#captureStatus')).to_contain_text('图片已复制')
            clipboard.remember()
        editor.locator('#captureOcr').click()
        expect(editor.locator('#captureOcrPanel')).to_be_visible(timeout=15000)
        compact = ''.join(editor.locator('#captureOcrText').input_value().upper().split())
        assert 'DTKIT' in compact and '12345' in compact
        editor.locator('#captureOcrClose').click()
        editor.locator('#captureSave').click()
        expect(editor.locator('#captureStatus')).to_contain_text('已保存：')
        editor_saved = Path(editor.locator('#captureStatus').inner_text().split('已保存：', 1)[1])
        assert native.IDENTIFIER in str(editor_saved)
        assert Image.open(editor_saved).size == (600, 220)
        try:
            invoke(editor, 'dismiss_quick_host')
        except Error as error:
            if 'closed' not in str(error):
                raise
        until(lambda: editor.is_closed())
        assert invoke(owner, 'get_resource_snapshot')['webviewCount'] == baseline
        print('Packaged editor capture-event decoding, import, local OCR panel and PNG save passed under production CSP'
              + ('; image copy passed' if clipboard is not None else '; clipboard copy skipped'), flush=True)

        request['requestId'] = 'closing-' + token
        owner.evaluate('''request=>{
            window.__closingCapture=Object.getPrototypeOf(window.__TAURI__).core.invoke('start_screen_region_capture',{...request,delayMs:10000});return true;
        }''', request)
        until(lambda: not user.IsWindowVisible(owner_handle))
        try:
            invoke(owner, 'dismiss_quick_host')
        except Error as error:
            if 'closed' not in str(error):
                raise
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            fixture.update(); other.wait_for_timeout(50)
            if owner.is_closed() and not overlays(context):
                break
        assert owner.is_closed() and not overlays(context)
        assert invoke(other, 'get_resource_snapshot')['webviewCount'] == baseline - 1
        print('Native pending-delay owner destruction cleaned up without orphan overlays', flush=True)
    finally:
        if fixture is not None:
            fixture.destroy()
        if saved is not None and native.IDENTIFIER in str(saved) and saved.name == 'native-shot-' + token + '.png':
            saved.unlink(missing_ok=True)
        if editor_saved is not None and native.IDENTIFIER in str(editor_saved) and editor_saved.name.startswith('DtKit-'):
            editor_saved.unlink(missing_ok=True)
        if not owner.is_closed():
            try:
                invoke(owner, 'cancel_screen_region_capture', request)
                until(lambda: not overlays(context), timeout=5)
            except Exception:
                pass
        for overlay in overlays(context):
            try:
                invoke(overlay, 'finish_screen_region_capture', {'dataUrl': None, 'width': None, 'height': None})
            except Exception:
                pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--visibility-only', action='store_true')
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert executable.is_file(), executable
    with sync_playwright() as playwright, clip_module.preserved_clipboard() as clipboard:
        if not args.visibility_only:
            native.run_case(playwright, executable, ['--tool', 'html-preview'], lambda *args: scenario(*args, clipboard=clipboard))
        native.run_case(playwright, executable, [], main_and_quick_visibility)
