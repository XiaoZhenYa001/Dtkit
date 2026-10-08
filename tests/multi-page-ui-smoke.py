"""Exercise isolated tool pages and lean tool entry using browser IPC mocks.

Does not launch DtKit or change native settings. Use a fresh `npm run build` first.
DTKIT_TEST_BASE_URL can point to an existing production preview server.
"""

import functools
import http.server
import json
import os
import re
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = Path(tempfile.gettempdir())
CSP = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["app"]["security"]["csp"]
MOCK = r"""
(() => {
  window.__multiCalls = [];
  window.__multiListeners = {};
  window.__multiWindowActions = [];
  window.__multiTicks = [];
  window.__multiTimerCallbacks = 0;
  window.__multiAnimationCallbacks = 0;
  const interval = window.setInterval.bind(window);
  const timeout = window.setTimeout.bind(window);
  const animation = window.requestAnimationFrame.bind(window);
  const instrument = callback => typeof callback === 'function' ? (...args) => {
    window.__multiTimerCallbacks += 1;
    return callback(...args);
  } : callback;
  window.setInterval = (callback, delay, ...args) => interval(instrument(callback), delay, ...args);
  window.setTimeout = (callback, delay, ...args) => timeout(instrument(callback), delay, ...args);
  window.requestAnimationFrame = callback => animation(timestamp => {
    window.__multiAnimationCallbacks += 1;
    return callback(timestamp);
  });
  if (window === window.top) window.addEventListener('message', event => {
    if (event.data?.type === 'dtkit-multipage-tick') window.__multiTicks.push(event.data);
  });
  Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async () => {}}});
  window.__TAURI__ = {
    core:{invoke:async (command, args = {}) => {
      window.__multiCalls.push({command,args:structuredClone(args)});
      if (command === 'get_storage_layout') return {root:'D:\\DtKit',downloads:'D:\\DtKit\\Downloads',writable:true,warning:null};
      if (['get_tool_module_settings','get_shortcut_bindings','take_missed_alarm_triggers','sync_alarm_tasks','scan_audio_files'].includes(command)) return [];
      if (command === 'create_tool_launcher') return 'C:\\Users\\Demo\\Desktop\\DtKit HTML preview.lnk';
      if (command === 'get_resource_policy') return {minimizeMode:'efficient',maxConcurrentJobs:2,quickHostRetentionSeconds:0};
      if (command === 'get_hotzone_status') return false;
      return null;
    }},
    event:{listen:async (name, callback) => {
      const listeners = window.__multiListeners[name] ||= new Set();
      listeners.add(callback);
      return () => listeners.delete(callback);
    }},
    window:{getCurrentWindow:() => ({label:'main',isMaximized:async () => false,
      startDragging:async () => {},toggleMaximize:async () => {window.__multiWindowActions.push('maximize');},
      minimize:async () => {window.__multiWindowActions.push('minimize');},
      setAlwaysOnTop:async () => {window.__multiWindowActions.push('pin');}})},
    dialog:{open:async () => null}
  };
  // Native Tauri internals are non-writable; plugins export non-enumerable APIs.
  Object.defineProperty(window, '__TAURI_INTERNALS__', {value:{}});
  Object.defineProperty(window.__TAURI__, 'dialog', {value:window.__TAURI__.dialog,enumerable:false});
})();
"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


@contextmanager
def production_url():
    configured = os.environ.get("DTKIT_TEST_BASE_URL")
    if configured:
        yield configured.rstrip("/")
        return
    handler = functools.partial(QuietHandler, directory=str(ROOT / "dist"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def active_tool_frame(page, ready_selector=".html-preview-view"):
    host = page.locator("iframe.tool-page-frame:not([hidden])")
    expect(host).to_have_count(1)
    expect(host).to_be_visible()
    handle = host.element_handle()
    frame = handle.content_frame()
    assert frame is not None, "Tool frame did not load"
    frame.locator(ready_selector).wait_for(state="visible")
    return frame


def active_tab_id(page):
    return page.locator(".tab--active").get_attribute("data-tab-id")


def active_instance_id(page):
    return page.locator("iframe.tool-page-frame:not([hidden])").get_attribute("data-instance-id")


def switch_tab(page, tab_id):
    page.locator(f'.tab[data-tab-id="{tab_id}"] .tab__label').click()
    expect(page.locator(f'.tab[data-tab-id="{tab_id}"]')).to_have_attribute("aria-selected", "true")


def tick_count(page, name):
    return page.evaluate("name => window.__multiTicks.filter(tick => tick.name === name).length", name)


def wait_for_ticks(page, name, count):
    page.wait_for_function("({name,count}) => window.__multiTicks.filter(tick => tick.name === name).length >= count", arg={"name":name,"count":count})


def set_auto_refresh(frame, enabled):
    checkbox = frame.locator("#autoRefreshToggle")
    if checkbox.is_checked() != enabled:
        frame.locator(".html-preview-toggle").click()
    assert checkbox.is_checked() == enabled


def write_code(frame, name, color, *, timer=False):
    set_auto_refresh(frame, False)
    frame.locator("#htmlEditor").fill(f'<h1 id="result">{name}</h1>')
    frame.locator('[data-tab="css"]').click()
    frame.locator("#cssEditor").fill(f'#result {{ color: {color}; }}')
    frame.locator('[data-tab="js"]').click()
    script = f"document.getElementById('result').textContent = 'rendered {name}'; console.log('multi-page-console-{name}');"
    if timer:
        script += f"let tick=0; setInterval(() => top.postMessage({{type:'dtkit-multipage-tick',name:'{name}',value:++tick}}, '*'), 40);"
    frame.locator("#jsEditor").fill(script)
    frame.locator("#refreshPreviewBtn").click()
    rendered = frame.frame_locator("#previewFrame").locator("#result")
    expect(rendered).to_have_text(f"rendered {name}")
    expect(rendered).to_have_css("color", color)
    return script


def assert_editor_values(frame, name, color, script):
    expect(frame.locator("#htmlEditor")).to_have_value(f'<h1 id="result">{name}</h1>')
    expect(frame.locator("#cssEditor")).to_have_value(f'#result {{ color: {color}; }}')
    expect(frame.locator("#jsEditor")).to_have_value(script)


def test_multi_page(context, base_url, errors, console_messages):
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: console_messages.append(message.text))
    page.goto(base_url, wait_until="networkidle")
    page.locator('[data-tool-id="html-preview"] .tool-card__title').click()
    first = active_tool_frame(page)
    tab_a = active_tab_id(page)
    instance_a = active_instance_id(page)
    assert instance_a, "Each tool page needs an instance identity"
    script_a = write_code(first, "A", "rgb(12, 34, 56)", timer=True)
    page.locator("[data-tool-page-window]").click()
    page.wait_for_function("() => window.__multiCalls.some(call => call.command === 'open_quick_host')")
    assert page.evaluate("window.__multiCalls.find(call => call.command === 'open_quick_host').args.target") == {'kind':'tool','toolId':'html-preview'}
    page.locator("[data-tool-page-launcher]").click()
    page.wait_for_function("() => window.__multiCalls.some(call => call.command === 'create_tool_launcher')")
    assert page.evaluate("window.__multiCalls.find(call => call.command === 'create_tool_launcher').args.toolId") == 'html-preview'
    assert active_instance_id(page) == instance_a
    first.locator("#fullscreenBtn").click()
    expect(first.locator("#previewResultPanel")).to_have_class(re.compile(r"\bfullscreen\b"))
    wait_for_ticks(page, "A", 2)

    # A toolbar action must create another instance of the same tool directly.
    page.locator("[data-tool-page-new]").click()
    second = active_tool_frame(page)
    tab_b = active_tab_id(page)
    instance_b = active_instance_id(page)
    assert tab_b != tab_a and instance_b != instance_a
    expect(page.locator("iframe.tool-page-frame")).to_have_count(2)
    expect(second.locator("#htmlEditor")).to_have_value("")
    expect(second.locator("#autoRefreshToggle")).to_be_checked()
    expect(second.locator("#previewResultPanel")).not_to_have_class(re.compile(r"\bfullscreen\b"))
    script_b = write_code(second, "B", "rgb(90, 80, 70)")
    set_auto_refresh(second, True)
    second.locator('[data-tab="css"]').click()

    # The hidden page retains editors while stopping arbitrary preview work.
    expect(first.locator("#previewFrame")).to_have_attribute("src", "about:blank")
    page.wait_for_timeout(120)  # Let already queued messages settle after unload.
    paused_a = tick_count(page, "A")
    page.wait_for_timeout(280)
    assert tick_count(page, "A") == paused_a, "Hidden preview kept executing its interval"

    switch_tab(page, tab_a)
    assert active_instance_id(page) == instance_a
    assert active_tool_frame(page) == first, "Tab switching recreated the tool document"
    assert_editor_values(first, "A", "rgb(12, 34, 56)", script_a)
    expect(first.locator("#autoRefreshToggle")).not_to_be_checked()
    expect(first.locator('[data-tab="js"]')).to_have_class(re.compile(r"\bactive\b"))
    expect(first.locator("#previewResultPanel")).to_have_class(re.compile(r"\bfullscreen\b"))
    wait_for_ticks(page, "A", paused_a + 2)
    first.locator("#fullscreenBtn").click()
    first.locator('[data-tab="html"]').click()

    # Native textarea undo is retained along with the original iframe realm.
    first.locator("#htmlEditor").click()
    first.locator("#htmlEditor").press("Control+End")
    page.keyboard.insert_text("<!-- undo probe -->")
    expect(first.locator("#htmlEditor")).to_have_value('<h1 id="result">A</h1><!-- undo probe -->')
    switch_tab(page, tab_b)
    assert_editor_values(second, "B", "rgb(90, 80, 70)", script_b)
    expect(second.locator("#autoRefreshToggle")).to_be_checked()
    expect(second.locator('[data-tab="css"]')).to_have_class(re.compile(r"\bactive\b"))
    switch_tab(page, tab_a)
    first.locator("#htmlEditor").click()
    first.locator("#htmlEditor").press("Control+z")
    expect(first.locator("#htmlEditor")).to_have_value('<h1 id="result">A</h1>')

    # Navigation history must reuse this page, while opening a card again creates
    # a fresh history entry rather than deduplicating against another tab.
    page.locator('[data-view="toolLibrary"]').click()
    expect(page.locator("iframe.tool-page-frame:not([hidden])")).to_have_count(0)
    page.locator("#backBtn").click()
    assert active_instance_id(page) == instance_a
    assert active_tool_frame(page) == first
    assert_editor_values(first, "A", "rgb(12, 34, 56)", script_a)
    page.locator("#forwardBtn").click()
    page.locator("#addTabBtn").click()
    page.locator('[data-tool-id="html-preview"] .tool-card__title').click()
    third = active_tool_frame(page)
    tab_c = active_tab_id(page)
    instance_c = active_instance_id(page)
    assert len({instance_a,instance_b,instance_c}) == 3
    assert len({tab_a,tab_b,tab_c}) == 3
    expect(third.locator("#htmlEditor")).to_have_value("")

    # Close only B, preserving both the hidden A history and fresh C.
    page.locator(f'.tab[data-tab-id="{tab_b}"] .tab__close').click()
    expect(page.locator(f'iframe.tool-page-frame[data-instance-id="{instance_b}"]')).to_have_count(0)
    assert second.is_detached(), "Closing a page left its document alive"
    expect(page.locator(f'iframe.tool-page-frame[data-instance-id="{instance_a}"]')).to_have_count(1)
    expect(page.locator(f'iframe.tool-page-frame[data-instance-id="{instance_c}"]')).to_have_count(1)
    assert active_instance_id(page) == instance_c

    # Closing A removes every history page belonging to that tab and stops work.
    page.locator(f'.tab[data-tab-id="{tab_a}"] .tab__close').click()
    expect(page.locator(f'iframe.tool-page-frame[data-instance-id="{instance_a}"]')).to_have_count(0)
    assert first.is_detached()
    page.wait_for_timeout(120)
    final_a = tick_count(page, "A")
    page.wait_for_timeout(240)
    assert tick_count(page, "A") == final_a
    page.wait_for_timeout(500)
    page.screenshot(path=str(SCREENSHOTS / "dtkit-multi-page.png"), full_page=True)
    assert any(message == "multi-page-console-A" for message in console_messages)
    assert any(message == "multi-page-console-B" for message in console_messages)
    page.close()


def test_lean_entry(context, base_url, errors):
    page = context.new_page()
    requests = []
    page.on("request", lambda request: requests.append(request.url))
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url + "/quick.html?kind=tool&toolId=html-preview", wait_until="networkidle")
    expect(page.locator("#htmlEditor")).to_be_visible()
    assert page.locator(".sidebar,#tabBar,#toolLibraryView").count() == 0
    assert page.locator("iframe.tool-page-frame").count() == 0

    # Check the actual production resource graph, not source-text declarations.
    index_html = (ROOT / "dist/index.html").read_text(encoding="utf-8")
    main_entries = re.findall(r'<script\b[^>]*\bsrc="([^"]+)"', index_html)
    assert main_entries, "Production main entry was not found"
    forbidden = {urljoin(base_url + "/", path) for path in main_entries}
    assert not forbidden.intersection(requests), "Tool-only entry downloaded the main app entry"
    assert any("html-preview" in url and url.endswith(".js") for url in requests)
    for other in ("alarm-clock", "desktop-organizer", "whiteboard", "settings-", "startup-manager", "context-menu"):
        assert not any(other in url for url in requests), f"Unrelated {other} implementation downloaded"
    calls = page.evaluate("window.__multiCalls.map(call => call.command)")
    assert not set(calls).intersection({"get_storage_layout", "sync_alarm_tasks", "get_hotzone_status", "set_minimize_mode"}), calls

    page.wait_for_timeout(150)
    settled = page.evaluate("[window.__multiTimerCallbacks,window.__multiAnimationCallbacks]")
    settled_calls = page.evaluate("window.__multiCalls.length")
    page.wait_for_timeout(600)
    assert page.evaluate("[window.__multiTimerCallbacks,window.__multiAnimationCallbacks]") == settled, "Idle tool shell kept running timers or animation callbacks"
    assert page.evaluate("window.__multiCalls.length") == settled_calls, "Idle tool shell kept invoking IPC"

    write_code(page, "only", "rgb(10, 20, 30)", timer=True)
    wait_for_ticks(page, "only", 2)

    # Escape belongs to the fullscreen preview before the tool-window shortcut.
    dismiss_calls = page.evaluate("window.__multiCalls.filter(call => call.command === 'dismiss_quick_host').length")
    page.locator("#fullscreenBtn").click()
    expect(page.locator("#previewResultPanel")).to_have_class(re.compile(r"\bfullscreen\b"))
    page.keyboard.press("Escape")
    expect(page.locator("#previewResultPanel")).not_to_have_class(re.compile(r"\bfullscreen\b"))
    page.wait_for_timeout(100)  # Allow any wrongly scheduled window dismissal to finish.
    assert page.evaluate("window.__multiCalls.filter(call => call.command === 'dismiss_quick_host').length") == dismiss_calls, "Leaving fullscreen also dismissed the standalone tool window"
    expect(page.locator("#htmlEditor")).to_have_value('<h1 id="result">only</h1>')
    expect(page.frame_locator("#previewFrame").locator("#result")).to_have_text("rendered only")

    assert page.evaluate("window.__multiListeners['app-power-state']?.size || 0") >= 1
    page.evaluate("for(const callback of window.__multiListeners['app-power-state']) callback({payload:{suspended:true}})")
    expect(page.locator("#previewFrame")).to_have_attribute("src", "about:blank")
    page.wait_for_timeout(120)
    paused = tick_count(page, "only")
    page.wait_for_timeout(240)
    assert tick_count(page, "only") == paused
    expect(page.locator("#htmlEditor")).to_have_value('<h1 id="result">only</h1>')
    page.evaluate("for(const callback of window.__multiListeners['app-power-state']) callback({payload:{suspended:false}})")
    wait_for_ticks(page, "only", paused + 2)
    page.locator('#quickMinimize').click()
    page.locator('#quickMaximize').click()
    page.locator('#quickPin').click()
    assert page.evaluate('window.__multiWindowActions') == ['minimize','maximize','pin']
    page.screenshot(path=str(SCREENSHOTS / "dtkit-tool-only.png"), full_page=True)
    page.locator('#quickClose').click()
    page.wait_for_function("() => window.__multiCalls.some(call => call.command === 'dismiss_quick_host')")
    page.close()


def test_startup_error_keeps_window_controls(context, base_url, errors):
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("window.requestAnimationFrame = null;")
    page.goto(base_url + '/quick.html?kind=tool&toolId=html-preview', wait_until='networkidle')
    expect(page.locator('#quickHeading')).to_have_text('工具初始化失败')
    expect(page.locator('#quickDescription')).not_to_be_empty()
    page.locator('#quickMinimize').click()
    page.locator('#quickMaximize').click()
    assert page.evaluate('window.__multiWindowActions') == ['minimize','maximize']
    page.locator('#quickClose').click()
    page.wait_for_function("() => window.__multiCalls.some(call => call.command === 'dismiss_quick_host')")
    page.close()


def test_sleep_reload_restore(context, base_url, errors):
    page = context.new_page()
    page.add_init_script("if(window === window.top && !sessionStorage.getItem('multi-page-sleep-check')) { localStorage.removeItem('dtkit_tool_workspace_v1'); sessionStorage.setItem('multi-page-sleep-check','1'); }")
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url, wait_until="networkidle")
    page.locator('[data-tool-id="html-preview"] .tool-card__title').click()
    first = active_tool_frame(page)
    tab_a = active_tab_id(page)
    instance_a = active_instance_id(page)
    script_a = write_code(first, "saved A", "rgb(25, 35, 45)")
    first.locator('[data-tab="html"]').click()
    first.locator("#htmlEditor").fill('<h1 id="result">A pending edit</h1>')
    first.locator('[data-tab="css"]').click()
    # Auto refresh is off, so the saved preview must differ from its editor draft.
    expect(first.frame_locator("#previewFrame").locator("#result")).to_have_text("rendered saved A")

    page.locator("[data-tool-page-new]").click()
    second = active_tool_frame(page)
    tab_b = active_tab_id(page)
    instance_b = active_instance_id(page)
    script_b = write_code(second, "saved B", "rgb(55, 65, 75)")
    set_auto_refresh(second, True)
    second.locator("#fullscreenBtn").click()
    expect(second.locator("#previewResultPanel")).to_have_class(re.compile(r"\bfullscreen\b"))
    assert page.evaluate("window.__DTKIT_TOOL_WORKSPACE__.persist({prepareSleep:true})") is True
    page.wait_for_function("() => window.__multiListeners['main-sleep-request']?.size > 0")
    page.evaluate("async () => { for(const callback of window.__multiListeners['main-sleep-request']) await callback({payload:{token:314}}); }")
    assert page.evaluate("window.__multiCalls.filter(call => call.command === 'main_sleep_ready').at(-1).args") == {'token':314,'ready':True}

    page.reload(wait_until="networkidle")
    restored_b = active_tool_frame(page)
    assert active_tab_id(page) == tab_b and active_instance_id(page) == instance_b
    assert_editor_values(restored_b, "saved B", "rgb(55, 65, 75)", script_b)
    expect(restored_b.locator("#autoRefreshToggle")).to_be_checked()
    expect(restored_b.locator('[data-tab="js"]')).to_have_class(re.compile(r"\bactive\b"))
    expect(restored_b.locator("#previewResultPanel")).to_have_class(re.compile(r"\bfullscreen\b"))
    switch_tab(page, tab_a)
    restored_a = active_tool_frame(page)
    assert active_instance_id(page) == instance_a
    expect(restored_a.locator("#htmlEditor")).to_have_value('<h1 id="result">A pending edit</h1>')
    expect(restored_a.locator("#cssEditor")).to_have_value('#result { color: rgb(25, 35, 45); }')
    expect(restored_a.locator("#jsEditor")).to_have_value(script_a)
    expect(restored_a.locator("#autoRefreshToggle")).not_to_be_checked()
    expect(restored_a.locator('[data-tab="css"]')).to_have_class(re.compile(r"\bactive\b"))
    expect(restored_a.locator("#previewResultPanel")).not_to_have_class(re.compile(r"\bfullscreen\b"))
    expect(restored_a.frame_locator("#previewFrame").locator("#result")).to_have_text("rendered saved A")
    page.wait_for_timeout(500)
    page.screenshot(path=str(SCREENSHOTS / "dtkit-multi-page-restored.png"), full_page=True)
    page.close()


def test_alarm_shared_data_with_independent_drafts(context, base_url, errors):
    page = context.new_page()
    page.add_init_script("if(window === window.top) { localStorage.removeItem('dtkit_tool_workspace_v1'); localStorage.removeItem('alarm_clock_data'); }")
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url, wait_until="networkidle")
    page.locator('[data-tool-id="alarm-clock"] .tool-card__title').click()
    first = active_tool_frame(page, "#alarmTaskName")
    tab_a = active_tab_id(page)
    first.locator("#alarmTaskType").select_option("countdown")
    first.locator("#alarmTaskName").fill("page A draft")
    first.locator("#countdownHours").fill("0")
    first.locator("#countdownMinutes").fill("2")
    first.locator("#countdownSeconds").fill("0")

    page.locator("[data-tool-page-new]").click()
    second = active_tool_frame(page, "#alarmTaskName")
    tab_b = active_tab_id(page)
    expect(second.locator("#alarmTaskName")).to_have_value("")
    second.locator("#alarmTaskType").select_option("countdown")
    second.locator("#alarmTaskName").fill("page B task")
    second.locator("#countdownHours").fill("0")
    second.locator("#countdownMinutes").fill("5")
    second.locator("#countdownSeconds").fill("0")
    second.locator("#addTaskBtn").click()
    expect(second.locator(".alarm-task-card")).to_have_count(1)

    switch_tab(page, tab_a)
    expect(first.locator("#alarmTaskName")).to_have_value("page A draft")
    expect(first.locator("#countdownMinutes")).to_have_value("2")
    first.locator("#addTaskBtn").click()
    page.wait_for_function("() => JSON.parse(localStorage.getItem('alarm_clock_data')).tasks.length === 2")
    tasks = page.evaluate("JSON.parse(localStorage.getItem('alarm_clock_data')).tasks")
    ids = {task['name']:task['id'] for task in tasks}
    assert set(ids) == {'page A draft','page B task'}
    first.locator(f'.alarm-task-card[data-task-id="{ids["page A draft"]}"] .alarm-task-btn--pause').click()
    page.wait_for_function("id => JSON.parse(localStorage.getItem('alarm_clock_data')).tasks.find(task => task.id === id).paused", arg=ids['page A draft'])
    first.locator("#alarmTaskName").fill("page A continued draft")

    switch_tab(page, tab_b)
    expect(second.locator(".alarm-task-card")).to_have_count(2)
    expect(second.locator(f'.alarm-task-card[data-task-id="{ids["page A draft"]}"]')).to_have_class(re.compile(r"\bpaused\b"))
    second.locator(f'.alarm-task-card[data-task-id="{ids["page B task"]}"] .alarm-task-btn--delete').click()
    page.wait_for_function("() => JSON.parse(localStorage.getItem('alarm_clock_data')).tasks.length === 1")
    remaining = page.evaluate("JSON.parse(localStorage.getItem('alarm_clock_data')).tasks")
    assert remaining[0]['id'] == ids['page A draft'] and remaining[0]['paused']
    switch_tab(page, tab_a)
    expect(first.locator("#alarmTaskName")).to_have_value("page A continued draft")
    expect(first.locator(".alarm-task-card")).to_have_count(1)
    page.screenshot(path=str(SCREENSHOTS / "dtkit-multi-page-alarm.png"), full_page=True)
    page.close()


def run(base_url):
    errors = []
    messages = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width":1360,"height":900})
        context.add_init_script(MOCK)

        def apply_csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if "text/html" in headers.get("content-type", ""):
                headers["content-security-policy"] = CSP
            route.fulfill(response=response, headers=headers)

        context.route(base_url + "/**", apply_csp)
        try:
            print('Multi-page UI: isolated pages, hidden work and closing', flush=True)
            test_multi_page(context, base_url, errors, messages)
            print('Multi-page UI: lean tool entry and native suspend', flush=True)
            test_lean_entry(context, base_url, errors)
            print('Multi-page UI: window controls survive a startup error', flush=True)
            test_startup_error_keeps_window_controls(context, base_url, errors)
            print('Multi-page UI: sleep handshake and reload restoration', flush=True)
            test_sleep_reload_restore(context, base_url, errors)
            print('Multi-page UI: alarm pages sharing saved tasks with separate drafts', flush=True)
            test_alarm_shared_data_with_independent_drafts(context, base_url, errors)
            assert not errors, errors
        except Exception:
            for index,page in enumerate(context.pages):
                page.screenshot(path=str(SCREENSHOTS / f"dtkit-multi-page-failure-{index}.png"), full_page=True)
            raise
        finally:
            context.close()
            browser.close()
    print(f"multi-page UI smoke passed; screenshots={SCREENSHOTS}")


if __name__ == "__main__":
    with production_url() as base_url:
        run(base_url)
