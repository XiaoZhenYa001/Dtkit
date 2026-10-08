"""Verify the real Windows Tauri bridge with an isolated application identifier.

Build first: npm run build
  npm run tauri build -- --debug --no-bundle --config tests/native-webview.config.json
Run: python tests/native-webview-ui-smoke.py --exe src-tauri/target/debug/DtKit.exe
The production identifier is rejected before testing. Only launched test PIDs are stopped.
CDP is enabled in the child environment only, as documented by Microsoft:
https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code
"""

import argparse
import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import Error, expect, sync_playwright


IDENTIFIER = 'com.administrator.dtkit.native-smoke'
ROOT = Path(__file__).resolve().parents[1]


def wait_until(predicate, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except Error as error:
            if 'Execution context was destroyed' not in str(error):
                raise
        time.sleep(0.1)
    raise AssertionError('Native window did not reach the expected state')


def run_case(playwright, executable, arguments, scenario):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    diagnostics = Path(tempfile.mkdtemp(prefix='dtkit-native-webview-'))
    environment = dict(os.environ)
    environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = f'--remote-debugging-port={port}'
    environment['WEBVIEW2_USER_DATA_FOLDER'] = str(diagnostics / 'webview-profile')
    log_file = (diagnostics / 'native.log').open('wb')
    process = subprocess.Popen([str(executable), *arguments], cwd=executable.parent,
                               env=environment, stdout=log_file, stderr=log_file,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    browser = None
    pages = []
    try:
        def endpoint_available():
            if process.poll() is not None:
                raise AssertionError(f'Test process exited early: {process.returncode}')
            try:
                with urlopen(f'http://127.0.0.1:{port}/json/version', timeout=0.3) as response:
                    return bool(json.load(response).get('webSocketDebuggerUrl'))
            except OSError:
                return False

        wait_until(endpoint_available)
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        wait_until(lambda: any(context.pages for context in browser.contexts))
        context = browser.contexts[0]
        pages = context.pages
        page = pages[0]
        wait_until(lambda: page.evaluate('Boolean(window.__TAURI__?.core?.invoke)'))
        identifier = page.evaluate('window.__TAURI__.core.invoke("get_storage_layout").then(layout => layout.root)')
        assert IDENTIFIER in identifier, f'Refusing to test a production data directory: {identifier}'
        errors = []
        context.on('page', lambda new_page: new_page.on('pageerror', lambda error: errors.append(str(error))))
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.reload(wait_until='networkidle')
        scenario(page, context, process)
        assert not errors, errors
        print(f'native {arguments or ["main"]} passed; diagnostics={diagnostics}', flush=True)
    except Exception:
        for index, page in enumerate(browser.contexts[0].pages if browser else []):
            try:
                page.screenshot(path=str(diagnostics / f'failure-{index}.png'))
            except Exception:
                pass
        print(f'Native failure diagnostics: {diagnostics}', flush=True)
        raise
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        if browser:
            browser.close()
        log_file.close()


def check_quick_controls(page, context, process):
    expect(page.locator('#htmlEditor')).to_be_visible()
    assert page.evaluate('Object.getOwnPropertyDescriptor(window,"__TAURI_INTERNALS__").writable') is False
    assert page.evaluate('typeof window.__TAURI__.dialog.open') == 'function'
    assert page.evaluate('typeof window.__TAURI__.fs.readFile') == 'function'
    assert page.evaluate('window.__TAURI__.window.getCurrentWindow().label').startswith('quick-host-')
    snapshot = page.evaluate('window.__TAURI__.core.invoke("get_resource_snapshot")')
    assert snapshot['mainWindowOpen'] is False and snapshot['toolOnly'] is True
    page.locator('#htmlEditor').fill('<h1 id="native-preview">native bridge works</h1>')
    page.locator('#refreshPreviewBtn').click()
    expect(page.frame_locator('#previewFrame').locator('#native-preview')).to_have_text('native bridge works')
    initial_size = page.evaluate('[innerWidth,innerHeight]')
    page.locator('#quickMaximize').click()
    wait_until(lambda: page.evaluate('[innerWidth,innerHeight]') != initial_size)
    page.locator('#quickMaximize').click()
    wait_until(lambda: page.evaluate('[innerWidth,innerHeight]') == initial_size)
    page.locator('#quickMinimize').click()
    wait_until(lambda: page.evaluate('window.__DTKIT_TOOL_PAGE__.suspended'))
    # Maximizing through the same permitted native API restores a minimized window.
    page.evaluate('window.__TAURI__.window.getCurrentWindow().toggleMaximize()')
    wait_until(lambda: page.evaluate('!window.__DTKIT_TOOL_PAGE__.suspended'))
    page.locator('#quickClose').click()
    wait_until(lambda: process.poll() is not None)
    assert process.returncode == 0, process.returncode


def check_wheel_scrolling(page, surface, offset, bottom):
    box = surface.bounding_box()
    page.mouse.move(box['x'] + box['width'] - 25, box['y'] + box['height'] * 0.7)
    page.mouse.wheel(0, 6000)
    wait_until(lambda: offset() > 20 and bottom())
    page.mouse.wheel(0, -6000)
    wait_until(lambda: offset() == 0)


def check_quick_scrolling(page, context, process):
    expect(page.locator('.unit-tool')).to_be_visible()
    snapshot = page.evaluate('window.__TAURI__.core.invoke("get_resource_snapshot")')
    assert snapshot['mainWindowOpen'] is False and snapshot['toolOnly'] is True
    content = page.locator('#quickContent')
    check_wheel_scrolling(page, content,
                         lambda: content.evaluate('(node) => node.scrollTop'),
                         lambda: content.evaluate('(node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 2'))
    assert page.locator('.quick-footer').bounding_box()['y'] < page.evaluate('innerHeight')
    page.locator('#quickClose').click()
    wait_until(lambda: process.poll() is not None)
    assert process.returncode == 0, process.returncode


def check_main_tools(page, context, process):
    expect(page.locator('#toolLibraryView')).to_be_visible()
    # Exercise the packaged module loaders and native IPC, not browser mocks.
    tool_ids = ['html-preview', 'unit-converter', 'qr-generator', 'hash-tool', 'password-vault', 'timetable']
    for tool_id in tool_ids:
        if page.locator('#toolLibraryView').is_hidden():
            page.locator('[data-view="toolLibrary"]').click()
        card = page.locator(f'#toolLibraryView [data-tool-id="{tool_id}"]')
        if card.count():
            card.click()
        else:
            page.locator(f'[data-tool="{tool_id}"]').click()
        frame = page.locator('iframe.tool-page-frame:not([hidden])').element_handle().content_frame()
        assert frame is not None
        wait_until(lambda: frame.evaluate('Boolean(window.__DTKIT_TOOL_PAGE__?.ready && document.getElementById("toolPageStatus").hidden)'))
        assert frame.evaluate('typeof window.__TAURI__.dialog.open') == 'function'
        assert frame.evaluate('typeof window.__TAURI__.fs.readFile') == 'function'
        if tool_id in ['unit-converter', 'qr-generator', 'timetable']:
            page.wait_for_timeout(350)
            check_wheel_scrolling(page, page.locator('iframe.tool-page-frame:not([hidden])'),
                                 lambda: frame.evaluate('document.scrollingElement.scrollTop'),
                                 lambda: frame.evaluate('document.scrollingElement.scrollTop + innerHeight >= document.scrollingElement.scrollHeight - 2'))
            print(f'native main tool {tool_id} wheel scrolling passed', flush=True)
        print(f'native main tool {tool_id} loaded', flush=True)
    page.evaluate('window.__TAURI__.core.invoke("open_quick_host",{target:{kind:"tool",toolId:"html-preview"}})')
    def quick_created():
        # Pump Playwright's sync event loop so CDP target-created events arrive.
        page.wait_for_timeout(50)
        return len(context.pages) == 2
    wait_until(quick_created)
    quick = next(candidate for candidate in context.pages if candidate != page)
    expect(quick.locator('#htmlEditor')).to_be_visible()
    quick.locator('#quickMaximize').click()
    quick.locator('#quickClose').click()
    wait_until(lambda: page.evaluate('window.__TAURI__.core.invoke("get_resource_snapshot").then(snapshot => snapshot.webviewCount === 1)'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert executable.is_file(), executable
    with sync_playwright() as playwright:
        run_case(playwright, executable, ['--tool', 'html-preview'], check_quick_controls)
        run_case(playwright, executable, ['--tool', 'unit-converter'], check_quick_scrolling)
        run_case(playwright, executable, [], check_main_tools)
    print('Native WebView2 tool loading, wheel scrolling and window controls passed', flush=True)
