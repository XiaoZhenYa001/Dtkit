"""Independent sticky-note editor, using the production build and production CSP."""

import ast
import functools
import http.server
import json
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = ROOT / ".tmp" / "sticky-note-editor"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)
NOTE_ID = "11111111-1111-4111-8111-111111111111"
source = ast.parse((ROOT / "tests/sticky-notes-ui-smoke.py").read_text(encoding="utf-8"))
MOCK = next(ast.literal_eval(node.value) for node in source.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "MOCK" for target in node.targets))
CSP = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["app"]["security"]["csp"]


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()


def editor(browser, url, errors, *, width=340, height=440, extra="", dark=False, reduced=False):
    page = browser.new_page(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light", reduced_motion="reduce" if reduced else "no-preference")
    page.add_init_script(MOCK + "\nwindow.__noteItems = [window.__note({opened:true})];\n" + extra)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" and "Content Security Policy" in message.text else None)
    page.goto(f"{url}/sticky-note.html?id={NOTE_ID}", wait_until="networkidle")
    expect(page.locator("#noteContent")).to_have_value("牛奶\n苹果")
    expect(page.locator("#noteSaveStatus")).to_have_attribute("data-state", "saved")
    return page


def saved(page):
    expect(page.locator("#noteSaveStatus")).to_have_attribute("data-state", "saved")


def test_writing(browser, url, errors):
    page = editor(browser, url, errors)
    field = page.locator("#noteContent")
    field.fill("第一行\n第二行")
    field.evaluate("e => e.setSelectionRange(0,3)")
    page.locator('[data-format="bold"]').click()
    expect(field).to_have_value("**第一行**\n第二行")
    field.press("Control+z")
    expect(field).to_have_value("第一行\n第二行")
    field.press("Control+b")
    assert "**" in field.input_value()
    field.fill("- [x] 完成")
    field.press("End")
    field.press("Enter")
    expect(field).to_have_value("- [x] 完成\n- [ ] ")
    field.press("Enter")
    expect(field).to_have_value("- [x] 完成\n")
    field.fill("列表")
    field.press("Control+a")
    page.locator('[data-format="checklist"]').click()
    expect(field).to_have_value("- [ ] 列表")
    field.press("Tab")
    expect(field).to_have_value("  - [ ] 列表")
    field.press("Shift+Tab")
    expect(field).to_have_value("- [ ] 列表")
    field.fill("")
    page.locator("#noteInsertDate").click()
    assert len(field.input_value()) == 10 and field.input_value()[4] == "-"
    page.locator("#noteTitle").fill("<img src=x onerror=alert(1)>")
    field.fill('# 设计备忘\n\n- [ ] 整理灵感\n- [x] 喝一杯咖啡\n\n**留一点空白**，让想法慢慢成形。\n<img src=x onerror=alert(1)>')
    page.locator("#notePreviewMode").click()
    expect(page.locator("#notePreview h1")).to_have_text("设计备忘")
    expect(page.locator("#notePreview img, #notePreview script")).to_have_count(0)
    expect(page.locator("#notePreview")).to_contain_text("<img src=x onerror=alert(1)>")
    expect(page.locator("#noteTaskCount")).to_have_text("1/2 项")
    task = page.locator('[data-task-line="2"]')
    identity = task.evaluate("e => { e.dataset.identity = 'retained'; return true; }")
    assert identity
    task.check()
    expect(field).to_have_value('# 设计备忘\n\n- [x] 整理灵感\n- [x] 喝一杯咖啡\n\n**留一点空白**，让想法慢慢成形。\n<img src=x onerror=alert(1)>')
    expect(task).to_have_attribute("data-identity", "retained")
    expect(page.locator("#noteTaskCount")).to_have_text("2/2 项")
    saved(page)
    page.screenshot(path=str(SCREENSHOTS / "preview-light.png"))
    page.close()


def test_continuity(browser, url, errors):
    page = editor(browser, url, errors)
    field = page.locator("#noteContent")
    field.fill("\n".join(f"记录 {index}: 留住此刻的想法" for index in range(70)))
    field.evaluate("e => { e.setSelectionRange(300,310); e.scrollTop=650; }")
    scroll = field.evaluate("e => e.scrollTop")
    page.locator("#notePreviewMode").click()
    assert page.locator("#notePreview").evaluate("e => !e.inert")
    page.wait_for_timeout(80)
    transform = page.locator(".note-view-indicator").evaluate("e => getComputedStyle(e).transform")
    value = float(transform.split(",")[4])
    assert 0 < value < 43, transform
    page.locator("#notePreview").evaluate("e => e.scrollTop=400")
    page.locator("#noteEditMode").click()
    assert field.evaluate("e => [e.selectionStart,e.selectionEnd]") == [300, 310]
    assert abs(field.evaluate("e => e.scrollTop") - scroll) < 2
    page.locator("#notePreviewMode").click()
    assert page.locator("#notePreview").evaluate("e => e.scrollTop") == 400
    field.press("Control+Shift+p")
    expect(page.locator("body")).to_have_attribute("data-view", "edit")
    field.fill("自动换行的文字" * 100 + "目标文字" + "结尾" * 10)
    field.press("Control+f")
    page.locator("#noteFindInput").fill("目标文字")
    expect(page.locator("#noteFindCount")).to_have_text("1/1")
    assert field.evaluate("e => e.scrollTop") > 300
    page.locator("#noteFindInput").fill("不存在的内容")
    expect(page.locator("#noteFindCount")).to_have_text("0/0")
    page.locator("#noteFindInput").press("Escape")
    expect(page.locator("#noteFind")).to_be_hidden()
    field.fill("今天 今天 今天")
    field.press("Control+f")
    page.locator("#noteFindInput").fill("今天")
    page.locator("#noteFindInput").press("Enter")
    expect(page.locator("#noteFindCount")).to_have_text("2/3")
    page.locator("#noteFindInput").press("Shift+Enter")
    expect(page.locator("#noteFindCount")).to_have_text("1/3")
    page.close()


def test_preferences_and_compact(browser, url, errors):
    page = editor(browser, url, errors)
    page.locator("#noteAppearance").click()
    expect(page.locator("#noteAppearancePanel")).to_be_visible()
    page.locator('[data-note-color="blue"]').click()
    expect(page.locator("body")).to_have_attribute("data-note-theme", "blue")
    page.locator('button[data-font-size="large"]').click()
    expect(page.locator("body")).to_have_attribute("data-font-size", "large")
    page.locator("#noteAppearance").press("Escape")
    expect(page.locator("#noteAppearancePanel")).to_be_hidden()
    saved(page)
    page.reload(wait_until="networkidle")
    expect(page.locator("body")).to_have_attribute("data-font-size", "large")
    for size in [(250, 240), (260, 260), (340, 440)]:
        page.set_viewport_size({"width": size[0], "height": size[1]})
        page.wait_for_timeout(50)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert page.locator("#noteContent").bounding_box()["height"] >= 30
        assert page.locator("#noteAppearance").bounding_box()["x"] >= 0
        page.screenshot(path=str(SCREENSHOTS / f"editor-{size[0]}x{size[1]}.png"))
    page.locator("#noteCollapse").click()
    expect(page.locator("body")).to_have_attribute("data-collapsed", "true")
    assert page.evaluate("window.__noteCalls.at(-1).command") == "set_sticky_note_collapsed"
    expect(page.locator("#noteHeaderTitle")).to_have_text("购物清单")
    page.locator("#noteCollapse").click()
    expect(page.locator("body")).to_have_attribute("data-collapsed", "false")
    page.close()
    dark = editor(browser, url, errors, dark=True, reduced=True)
    dark.locator("#noteContent").fill("# 深夜灵感\n\n- [ ] 给想法留一点空间\n- [x] 整理今天的收获\n\n宁静一点，专注一点。")
    dark.locator("#notePreviewMode").click()
    assert dark.locator(".note-view-indicator").evaluate("e => getComputedStyle(e).transitionDuration") == "0s"
    dark.screenshot(path=str(SCREENSHOTS / "preview-dark.png"))
    dark.close()

    # Native close requests arriving during the height animation must be queued,
    # then use the same confirmed-save barrier as an ordinary close.
    queued = editor(browser, url, errors, extra="""
        const invoke = window.__TAURI__.core.invoke;
        window.__TAURI__.core.invoke = (command,args) => command === 'set_sticky_note_collapsed'
            ? new Promise(resolve => { window.__releaseCollapse = resolve; }) : invoke(command,args);
    """)
    queued.locator("#noteContent").fill("折叠途中关闭也要保存")
    queued.locator("#noteCollapse").click()
    queued.evaluate("window.__requestNoteClose()")
    assert queued.evaluate("window.__noteCalls.filter(x => x.command === 'close_sticky_note').length") == 0
    queued.evaluate("window.__releaseCollapse(true)")
    queued.wait_for_function("() => window.__noteCalls.some(x => x.command === 'close_sticky_note')")
    assert queued.evaluate("window.__noteItems[0].content") == "折叠途中关闭也要保存"
    queued.close()


def test_save_recovery_and_close(browser, url, errors):
    page = editor(browser, url, errors)
    page.evaluate("window.__holdNoteSaves = true")
    page.locator("#noteContent").fill("保存中的 A")
    page.wait_for_function("() => window.__pendingNoteSaves.length === 1")
    page.locator("#noteContent").fill("保存时继续输入 B")
    page.locator("#noteClose").click()
    assert page.evaluate("window.__noteCalls.filter(x => x.command === 'close_sticky_note').length") == 0
    page.evaluate("window.__releaseNoteSave()")
    page.wait_for_function("() => window.__pendingNoteSaves.length === 1")
    page.evaluate("window.__releaseNoteSave()")
    page.wait_for_function("() => window.__noteCalls.some(x => x.command === 'close_sticky_note')")
    assert page.evaluate("window.__noteItems[0].content") == "保存时继续输入 B"
    page.close()
    page = editor(browser, url, errors)
    page.evaluate("window.__noteFailure.save_sticky_note = '磁盘暂时不可写'")
    page.locator("#noteContent").fill("保存失败，保留这段文字")
    page.evaluate("window.__requestNoteClose()")
    expect(page.locator("#noteSaveStatus")).to_have_attribute("data-state", "error")
    expect(page.locator("#noteContent")).to_be_editable()
    page.evaluate("delete window.__noteFailure.save_sticky_note")
    page.locator("#noteRetry").click()
    saved(page)
    page.evaluate("localStorage.setItem('dtkit_sticky_note_recovery_11111111-1111-4111-8111-111111111111', JSON.stringify({...window.__noteItems[0],content:'可恢复的草稿',revision:1}))")
    page.reload(wait_until="networkidle")
    expect(page.locator("#noteRecovery")).to_be_visible()
    expect(page.locator("#noteContent")).to_be_disabled()
    page.locator("#recoveryRestore").click()
    expect(page.locator("#noteContent")).to_have_value("可恢复的草稿")
    saved(page)
    assert page.evaluate("window.__noteItems[0].content") == "可恢复的草稿"
    page.close()


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT / "dist")))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        errors = []
        url = f"http://127.0.0.1:{server.server_port}"
        try:
            for check in [test_writing, test_continuity, test_preferences_and_compact, test_save_recovery_and_close]:
                check(browser, url, errors)
                print(f"PASS: {check.__name__}")
            assert not errors, errors
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
