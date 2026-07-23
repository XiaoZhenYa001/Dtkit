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
        window.__editRevokedListener = null;
        window.__shortcutBindings = [];
        window.__dismissCalls = 0;
        window.__boards = [];
        window.__draftCalls = [];
        window.__toggleMaximizeCalls = 0;
        window.__TAURI__ = {
            core: { invoke: async (command, args = {}) => {
                if (command === 'get_storage_layout') return { root: 'D:\\DtKit', downloads: 'D:\\DtKit\\Downloads', writable: true, warning: null };
                if (command === 'get_shortcut_bindings') return window.__shortcutBindings;
                if (command === 'replace_shortcut_bindings') {
                    window.__shortcutBindings = args.bindings;
                    return window.__shortcutBindings;
                }
                if (command === 'take_missed_alarm_triggers') return [];
                if (command === 'list_whiteboards') return window.__boards;
                if (command === 'save_whiteboard') {
                    const id = args.request.id || '11111111-1111-4111-8111-111111111111';
                    const meta = { id, name: args.request.name, createdAt: Date.now(), updatedAt: Date.now(), hasDraft: false };
                    window.__boards = [meta, ...window.__boards.filter(item => item.id !== id)];
                    window.__savedDocument = args.request.document;
                    window.__thumbnail = args.request.thumbnailDataUrl;
                    return meta;
                }
                if (command === 'save_whiteboard_draft') {
                    window.__draftCalls.push(args.request);
                    return null;
                }
                if (command === 'get_whiteboard_thumbnail') return window.__thumbnail || null;
                if (command === 'dismiss_quick_host') {
                    window.__dismissCalls += 1;
                    return null;
                }
                return null;
            }},
            event: { listen: async (event, callback) => {
                if (event === 'app-power-state') window.__powerListener = callback;
                if (event === 'whiteboard-edit-revoked') window.__editRevokedListener = callback;
                return () => {};
            }},
            window: { getCurrentWindow: () => ({
                toggleMaximize: async () => { window.__toggleMaximizeCalls += 1; }
            }) }
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
    page.locator("#whiteboardObjectCount").filter(has_text="1 个对象").wait_for()

    page.locator("#whiteboardUndo").click()
    assert page.locator("#whiteboardObjectCount").inner_text() == "0 个对象"
    page.locator("#whiteboardRedo").click()
    assert page.locator("#whiteboardObjectCount").inner_text() == "1 个对象"
    page.locator('[data-board-panel="draw"]').click()
    page.locator('[data-board-mode="highlighter"]').click()
    assert page.locator('[data-board-mode="highlighter"]').get_attribute("aria-pressed") == "true"

    page.locator('[data-board-panel="shape"]').click()
    page.locator('[data-board-mode="rect"]').click()
    page.mouse.move(box["x"] + 340, box["y"] + 160)
    page.mouse.down()
    page.mouse.move(box["x"] + 500, box["y"] + 270, steps=5)
    page.mouse.up()
    page.locator("#whiteboardObjectCount").filter(has_text="2 个对象").wait_for()

    page.locator('[data-board-panel="content"]').click()
    page.locator('[data-board-mode="formula"]').click()
    page.mouse.click(box["x"] + 540, box["y"] + 330)
    page.locator("#whiteboardObjectDialog").wait_for(state="visible")
    page.locator("#whiteboardObjectInput").fill(r"\frac{1}{2}")
    page.locator("#whiteboardFormulaPreview .katex").wait_for(state="visible")
    page.locator("#whiteboardDialogConfirm").click()
    page.locator("#whiteboardObjectCount").filter(has_text="3 个对象").wait_for()

    page.locator('[data-board-panel="canvas"]').click()
    page.locator("#whiteboardBackground").click()
    page.locator('[data-board-background="english"]').click()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.wheel(0, -500)
    page.wait_for_function("parseInt(document.querySelector('#whiteboardZoom').textContent) > 100")

    page.locator("#whiteboardName").fill("函数讲解")
    page.locator('[data-board-panel="file"]').click()
    page.locator("#whiteboardSave").click()
    page.locator("#whiteboardStatus").filter(has_text="正式白板已保存").wait_for()
    assert page.evaluate("window.__savedDocument.infinite") is True
    assert page.evaluate("window.__savedDocument.elements.length") == 3
    page.locator("#whiteboardHistoryRail").click()
    page.locator(".whiteboard-history-card.is-current").filter(has_text="函数讲解").wait_for()
    page.locator(".whiteboard-history-thumb img").wait_for(state="visible")
    history_box = page.locator("#whiteboardHistory").bounding_box()
    rail_box = page.locator("#whiteboardHistoryRail").bounding_box()
    assert history_box and rail_box and rail_box["x"] >= history_box["x"] + history_box["width"] - 8
    page.locator("#whiteboardHistoryRail").click()
    assert page.locator("#whiteboardHistory").get_attribute("aria-hidden") == "true"
    page.locator("#whiteboardHistoryRail").click()
    page.locator('[data-board-panel="draw"]').click()
    page.locator('[data-board-mode="pen"]').click()
    page.mouse.move(box["x"] + 620, box["y"] + 240)
    page.mouse.down()
    page.mouse.move(box["x"] + 660, box["y"] + 260)
    page.mouse.up()
    assert page.locator("#whiteboardHistory").get_attribute("aria-hidden") == "true"
    page.evaluate("window.__editRevokedListener({ payload: window.__boards[0].id })")
    assert page.locator("#whiteboardReadOnly").is_visible()
    read_only_count = page.locator("#whiteboardObjectCount").inner_text()
    page.mouse.move(box["x"] + 700, box["y"] + 280)
    page.mouse.down()
    page.mouse.move(box["x"] + 740, box["y"] + 300)
    page.mouse.up()
    assert page.locator("#whiteboardObjectCount").inner_text() == read_only_count
    page.locator("#whiteboardTakeOver").click()
    assert not page.locator("#whiteboardReadOnly").is_visible()

    with page.expect_download() as download_info:
        page.locator('[data-board-panel="file"]').click()
        page.locator("#whiteboardExport").click()
    assert download_info.value.suggested_filename.endswith(".png")
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
    assert page.locator(".quick-titlebar").evaluate("element => getComputedStyle(element).pointerEvents") == "auto"
    page.locator(".quick-titlebar").dblclick(position={"x": 300, "y": 8})
    page.wait_for_function("window.__toggleMaximizeCalls === 1")
    assert page.locator('[data-board-panel]').count() == 5
    quick_canvas = page.locator("#whiteboardCanvas")
    quick_box = quick_canvas.bounding_box()
    assert quick_box and quick_box["width"] >= 750 and quick_box["height"] >= 570, quick_box

    page.locator("#whiteboardHistoryRail").click()
    quick_history_box = page.locator("#whiteboardHistory").bounding_box()
    quick_rail_box = page.locator("#whiteboardHistoryRail").bounding_box()
    assert quick_history_box and quick_rail_box and quick_rail_box["x"] >= quick_history_box["x"] + quick_history_box["width"] - 8

    initial_count = int(page.locator("#whiteboardObjectCount").inner_text().split()[0])
    page.mouse.move(quick_box["x"] + 160, quick_box["y"] + 210)
    page.mouse.down()
    page.mouse.move(quick_box["x"] + 300, quick_box["y"] + 275, steps=8)
    page.mouse.up()
    page.locator("#whiteboardObjectCount").filter(has_text=f"{initial_count + 1} 个对象").wait_for()
    assert page.locator("#whiteboardHistory").get_attribute("aria-hidden") == "true"
    page.evaluate("window.dispatchEvent(new CustomEvent('dtkit:power-state', { detail: { suspended: true } }))")
    page.wait_for_function("window.__draftCalls.length === 1")
    page.screenshot(path=str(QUICK_SCREENSHOT), full_page=True)

    # 大量历史笔迹存在时，当前笔画必须留在增量覆盖层，不能每个 pointermove 清空并重绘全画布。
    legacy_strokes = [
        {
            "id": f"perf-{stroke_index}",
            "tool": "pen",
            "color": "#242937",
            "width": 3,
            "points": [
                [0.05 + (stroke_index % 30) / 34 + point / 9000, 0.08 + (stroke_index // 30) / 24 + point / 12000, 0.5]
                for point in range(12)
            ],
        }
        for stroke_index in range(600)
    ]
    page.evaluate(
        "(strokes) => localStorage.setItem('dtkit_whiteboard_v1', JSON.stringify({ strokes, gridEnabled: true }))",
        legacy_strokes,
    )
    page.reload(wait_until="networkidle")
    perf_canvas = page.locator("#whiteboardCanvas")
    perf_canvas.wait_for(state="visible")
    page.wait_for_function("document.querySelector('#whiteboardObjectCount').textContent.startsWith('600 ')")
    page.evaluate("""() => {
        window.__whiteboardClearCalls = 0;
        const original = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function (...args) {
            window.__whiteboardClearCalls += 1;
            return original.apply(this, args);
        };
    }""")
    perf_box = perf_canvas.bounding_box()
    page.mouse.move(perf_box["x"] + 120, perf_box["y"] + 180)
    page.mouse.down()
    page.mouse.move(perf_box["x"] + 620, perf_box["y"] + 300, steps=120)
    page.mouse.up()
    page.wait_for_timeout(50)
    assert page.evaluate("window.__whiteboardClearCalls") <= 6

    page.locator("#quickClose").click()
    page.wait_for_function("window.__dismissCalls === 1")

    assert not page_errors, page_errors
    assert not console_errors, console_errors
    browser.close()

print(f"whiteboard, immersive quick canvas and tray-resume UI passed; screenshots={SCREENSHOT}, {QUICK_SCREENSHOT}")
