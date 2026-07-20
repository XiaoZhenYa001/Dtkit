import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("DTKIT_TEST_BASE_URL", "http://127.0.0.1:4191")
SCREENSHOT = Path(r"C:\tmp\dtkit-whiteboard.png")
QUICK_SCREENSHOT = Path(r"C:\tmp\dtkit-whiteboard-quick.png")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 860})
    page.add_init_script("""
        window.__powerListener = null;
        window.__shortcutBindings = [];
        window.__dismissCalls = 0;
        window.__TAURI__ = {
            core: { invoke: async (command, args = {}) => {
                if (command === 'get_shortcut_bindings') return window.__shortcutBindings;
                if (command === 'replace_shortcut_bindings') {
                    window.__shortcutBindings = args.bindings;
                    return window.__shortcutBindings;
                }
                if (command === 'take_missed_alarm_triggers') return [];
                if (command === 'dismiss_quick_host') {
                    window.__dismissCalls += 1;
                    return null;
                }
                return null;
            }},
            event: { listen: async (event, callback) => {
                if (event === 'app-power-state') window.__powerListener = callback;
                return () => {};
            }}
        };
    """)
    console_errors = []
    page_errors = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))

    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-tool-id="whiteboard"]').wait_for(state="visible")
    page.locator('[data-tool-id="whiteboard"]').click()
    canvas = page.locator("#whiteboardCanvas")
    canvas.wait_for(state="visible")
    box = canvas.bounding_box()
    assert box and box["width"] > 500 and box["height"] > 250, box

    page.mouse.move(box["x"] + 90, box["y"] + 120)
    page.mouse.down()
    for offset in range(0, 180, 15):
        page.mouse.move(box["x"] + 90 + offset, box["y"] + 120 + offset * 0.35)
    page.mouse.up()
    page.locator("#whiteboardStrokeCount").filter(has_text="1 笔").wait_for()
    page.wait_for_timeout(550)
    assert page.evaluate("JSON.parse(localStorage.getItem('dtkit_whiteboard_v1')).strokes.length") == 1

    page.locator("#whiteboardUndo").click()
    assert page.locator("#whiteboardStrokeCount").inner_text() == "0 笔"
    page.locator("#whiteboardRedo").click()
    assert page.locator("#whiteboardStrokeCount").inner_text() == "1 笔"
    page.locator('[data-board-mode="highlighter"]').click()
    assert page.locator('[data-board-mode="highlighter"]').get_attribute("aria-pressed") == "true"
    page.locator("#whiteboardGrid").click()
    assert page.locator("#whiteboardGrid").get_attribute("aria-pressed") == "false"

    with page.expect_download() as download_info:
        page.locator("#whiteboardExport").click()
    assert download_info.value.suggested_filename.startswith("DtKit-白板-")
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")

    # 模拟节能关闭后在休眠状态重新渲染工具卡，再模拟托盘恢复事件。
    page.wait_for_function("window.__powerListener !== null")
    page.evaluate("window.__powerListener({ payload: { suspended: true, mode: 'efficient' } })")
    page.locator('[data-view="toolLibrary"]').click()
    page.wait_for_function("document.querySelectorAll('.tool-card').length === 17")
    suspended = page.evaluate("""() => ({
        className: document.documentElement.classList.contains('app-is-suspended'),
        opacity: getComputedStyle(document.querySelector('.tool-card')).opacity,
        playState: getComputedStyle(document.querySelector('.tool-card')).animationPlayState
    })""")
    assert suspended == {"className": True, "opacity": "0", "playState": "paused"}, suspended

    page.evaluate("window.__powerListener({ payload: { suspended: false, mode: 'efficient' } })")
    page.wait_for_function("""() => {
        const card = document.querySelector('.tool-card');
        return !document.documentElement.classList.contains('app-is-suspended') && Number(getComputedStyle(card).opacity) > 0.95;
    }""")

    # 快捷键入口只展示沉浸式画布和辅助控件，不装载主界面结构。
    page.set_viewport_size({"width": 760, "height": 580})
    page.goto(f"{BASE_URL}/quick.html?kind=tool&toolId=whiteboard", wait_until="networkidle")
    page.locator("html.quick-tool--whiteboard #whiteboardCanvas").wait_for(state="visible")
    assert page.locator(".tool-shortcut-slot").count() == 0
    assert page.locator(".whiteboard-hero").evaluate("element => getComputedStyle(element).display") == "none"
    assert page.locator(".quick-footer").evaluate("element => getComputedStyle(element).display") == "none"
    assert page.locator(".whiteboard-toolbar").is_visible()
    quick_canvas = page.locator("#whiteboardCanvas")
    quick_box = quick_canvas.bounding_box()
    assert quick_box and quick_box["width"] >= 750 and quick_box["height"] >= 570, quick_box

    initial_count = int(page.locator("#whiteboardStrokeCount").inner_text().split()[0])
    page.mouse.move(quick_box["x"] + 160, quick_box["y"] + 210)
    page.mouse.down()
    page.mouse.move(quick_box["x"] + 300, quick_box["y"] + 275, steps=8)
    page.mouse.up()
    page.locator("#whiteboardStrokeCount").filter(has_text=f"{initial_count + 1} 笔").wait_for()
    page.wait_for_timeout(550)
    assert page.evaluate("JSON.parse(localStorage.getItem('dtkit_whiteboard_v1')).strokes.length") == initial_count + 1
    page.screenshot(path=str(QUICK_SCREENSHOT), full_page=True)
    page.locator("#quickClose").click()
    page.wait_for_function("window.__dismissCalls === 1")

    assert not page_errors, page_errors
    assert not console_errors, console_errors
    browser.close()

print(f"whiteboard, immersive quick canvas and tray-resume UI passed; screenshots={SCREENSHOT}, {QUICK_SCREENSHOT}")
