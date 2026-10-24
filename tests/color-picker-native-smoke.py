"""Exercise native screen picking using only this run's generated swatch window.

Build with tests/native-webview.config.json first. The shared runner refuses
production storage. Pixel confirmation targets the center of a solid-color
window created by this test, and overlays are closed before failure screenshots.
"""
import argparse
import ctypes
import importlib.util
import time
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import Error, expect, sync_playwright

spec = importlib.util.spec_from_file_location('native_webview', Path(__file__).with_name('native-webview-ui-smoke.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def invoke(page, command, args=None):
    return page.evaluate('''({command,args})=>
        Object.getPrototypeOf(window.__TAURI__).core.invoke(command,args)''',
                         {'command':command,'args':args or {}})


def pump_until(page, predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        page.wait_for_timeout(50)
        if predicate():
            return
    raise AssertionError('Native color picker state did not settle')


def overlays(context):
    return [page for page in context.pages if 'color-pick.html' in page.url]


def dismiss(page):
    try:
        invoke(page,'dismiss_quick_host')
    except Error as error:
        if not page.is_closed() and 'closed' not in str(error):
            raise


def test_swatch_center(process_id):
    """Read geometry only from a visible quick window belonging to our test PID."""
    from ctypes import wintypes
    user = ctypes.windll.user32
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except OSError:
        pass
    found = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
    def visit(handle, _):
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(handle,ctypes.byref(pid))
        if pid.value != process_id or not user.IsWindowVisible(handle):
            return True
        title = ctypes.create_unicode_buffer(256)
        user.GetWindowTextW(handle,title,256)
        if title.value != 'DtKit 快捷窗口':
            return True
        rect = wintypes.RECT()
        origin = wintypes.POINT(0,0)
        user.GetClientRect(handle,ctypes.byref(rect))
        user.ClientToScreen(handle,ctypes.byref(origin))
        found.append({'x':origin.x+(rect.right-rect.left)//2,
                      'y':origin.y+(rect.bottom-rect.top)//2})
        return True
    user.EnumWindows(callback_type(visit),0)
    assert len(found) == 1, f'Expected only this run\'s visible swatch window, found {len(found)}'
    return found[0]


def scenario(owner,context,process):
    pump_until(owner,lambda:owner.evaluate('window.__DTKIT_TOOL_PAGE__?.ready === true'))
    token = uuid4().hex
    instance_id = owner.evaluate('window.__DTKIT_TOOL_PAGE_CONTEXT.instanceId')
    request = {'instanceId':instance_id,'requestId':'pick-'+token}
    owner.evaluate("""async () => {
        window.__nativeColorResults=[];
        await window.__TAURI__.event.listen('screen-color-picked',event=>{
            window.__nativeColorResults.push(event.payload);
        });
    }""")
    invoke(owner,'open_quick_host',{'target':{'kind':'tool','toolId':'html-preview'}})
    pump_until(owner,lambda:len(context.pages)==2)
    swatch = next(page for page in context.pages if page != owner)
    pump_until(swatch,lambda:swatch.evaluate('window.__DTKIT_TOOL_PAGE__?.ready === true'))
    swatch.evaluate("""() => {
        const node=document.createElement('div');
        node.id='native-test-swatch';
        Object.assign(node.style,{position:'fixed',inset:'0',zIndex:'2147483647',
            backgroundColor:'#17B68F',pointerEvents:'none'});
        document.body.append(node);
    }""")
    expect(swatch.locator('#native-test-swatch')).to_be_visible()
    swatch.evaluate('window.__TAURI__.window.getCurrentWindow().setAlwaysOnTop(true)')
    swatch.wait_for_timeout(150)
    base = invoke(owner,'get_resource_snapshot')['webviewCount']
    assert base == 2

    try:
        # Both IPC messages are posted in one JS task. Cancellation must work
        # during the initial hidden-window delay, before capture is registered.
        owner.evaluate("""async request => {
            const invoke=Object.getPrototypeOf(window.__TAURI__).core.invoke;
            const start=invoke('start_screen_color_pick',request);
            await invoke('cancel_screen_color_pick',request);
            await start;
        }""",request)
        owner.wait_for_timeout(250)
        assert not overlays(context)
        assert invoke(owner,'get_resource_snapshot')['webviewCount'] == base
        assert owner.evaluate('window.__nativeColorResults.every(result=>result.cancelled)') is True

        request['requestId'] = 'confirmed-'+token
        invoke(owner,'start_screen_color_pick',request)
        pump_until(owner,lambda:len(overlays(context))==1)
        overlay = overlays(context)[0]
        expect(overlay.locator('#magnifier')).to_be_visible(timeout=15000)
        assert invoke(owner,'get_resource_snapshot')['webviewCount'] == base+1
        # Another native owner, or another page/request in the same owner,
        # cannot cancel this session.
        invoke(swatch,'cancel_screen_color_pick',request)
        invoke(owner,'cancel_screen_color_pick',{**request,'instanceId':'different-page'})
        invoke(owner,'cancel_screen_color_pick',{**request,'requestId':'different-request'})
        assert len(overlays(context)) == 1
        duplicate = owner.evaluate("""async request => {
            try {await Object.getPrototypeOf(window.__TAURI__).core.invoke('start_screen_color_pick',request);return null;}
            catch(error){return String(error);}
        }""",request)
        assert duplicate and '已有' in duplicate, duplicate
        duplicate_window = swatch.evaluate("""async request => {
            try {await Object.getPrototypeOf(window.__TAURI__).core.invoke('start_screen_color_pick',request);return null;}
            catch(error){return String(error);}
        }""",{**request,'requestId':'other-owner-'+token})
        assert duplicate_window and '已有' in duplicate_window,duplicate_window

        center = test_swatch_center(process.pid)
        point = overlay.evaluate("""physical => {
            const canvas=document.getElementById('screenCanvas');
            const coordinate=document.getElementById('pickedCoordinate').textContent.match(/-?\\d+/g).map(Number);
            const rect=canvas.getBoundingClientRect();
            const cursor=new DOMMatrixReadOnly(getComputedStyle(document.getElementById('pickCursor')).transform);
            const origin={x:coordinate[0]-Math.floor((cursor.m41-rect.left)*canvas.width/rect.width),
                          y:coordinate[1]-Math.floor((cursor.m42-rect.top)*canvas.height/rect.height)};
            return {x:(physical.x-origin.x+.5)*rect.width/canvas.width,
                    y:(physical.y-origin.y+.5)*rect.height/canvas.height};
        }""",center)
        overlay.mouse.move(point['x'],point['y'])
        expect(overlay.locator('#pickedHex')).to_have_text('#17B68F')
        overlay.keyboard.press('ArrowRight')
        expect(overlay.locator('#pickedHex')).to_have_text('#17B68F')
        overlay.keyboard.press('Enter')
        pump_until(owner,lambda:not overlays(context))
        result = owner.evaluate('window.__nativeColorResults.at(-1)')
        assert result == {**request,'color':'#17B68F','cancelled':False}, result

        # Exercise the real product button and event listener as well as the
        # direct command contract above.
        owner.locator('#screenColorPicker').click()
        pump_until(owner,lambda:len(overlays(context))==1)
        overlay = overlays(context)[0]
        expect(overlay.locator('#magnifier')).to_be_visible()
        overlay.mouse.move(point['x'],point['y'])
        expect(overlay.locator('#pickedHex')).to_have_text('#17B68F')
        overlay.keyboard.press('Enter')
        pump_until(owner,lambda:not overlays(context))
        expect(owner.locator('#colorPreviewValue')).to_have_text('#17B68F')
        expect(owner.locator('#screenColorPicker')).to_be_enabled()

        request['requestId'] = 'escape-'+token
        invoke(owner,'start_screen_color_pick',request)
        pump_until(owner,lambda:len(overlays(context))==1)
        overlay = overlays(context)[0]
        expect(overlay.locator('#magnifier')).to_be_visible()
        overlay.keyboard.press('Escape')
        pump_until(owner,lambda:not overlays(context))
        assert owner.evaluate('window.__nativeColorResults.at(-1).cancelled') is True

        request['requestId'] = 'closing-'+token
        invoke(owner,'start_screen_color_pick',request)
        pump_until(owner,lambda:len(overlays(context))==1)
        dismiss(owner)
        pump_until(swatch,lambda:owner.is_closed() and not overlays(context))
        swatch.wait_for_timeout(300)
        assert invoke(swatch,'get_resource_snapshot')['webviewCount'] == 1
        dismiss(swatch)
        native.wait_until(lambda:process.poll() is not None)
        assert process.returncode == 0,process.returncode
        print('Native color cancellation, request isolation, generated-swatch picking, keyboard, Esc and owner cleanup passed',flush=True)
    finally:
        # The generic runner records failing windows. Never leave a desktop
        # capture overlay open for those diagnostic screenshots.
        if not owner.is_closed():
            try:
                invoke(owner,'cancel_screen_color_pick',request)
                pump_until(owner,lambda:not overlays(context),timeout=5)
            except Exception:
                pass
        for overlay in overlays(context):
            try:
                invoke(overlay,'finish_screen_color_pick',{'color':None})
            except Exception:
                pass
        if not swatch.is_closed():
            swatch.wait_for_timeout(100)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe',type=Path,required=True)
    args=parser.parse_args()
    executable=args.exe.resolve()
    assert executable.is_file(),executable
    with sync_playwright() as playwright:
        native.run_case(playwright,executable,['--tool','color-picker'],scenario)
