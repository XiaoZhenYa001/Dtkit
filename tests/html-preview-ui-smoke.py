"""Exercise the production HTML workspace with headless browser IPC mocks.

Build first: npm run build
Run: python tests/html-preview-ui-smoke.py
DTKIT_TEST_BASE_URL may point to an existing production preview server.
No native DtKit process is launched, and browser data stays in a fresh context.
"""

import importlib.util
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location(
    "multi_page", Path(__file__).with_name("multi-page-ui-smoke.py")
)
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)

ARTIFACTS = Path(__file__).resolve().parent / "artifacts" / "html-preview"
EXPECTED_ERROR = "html-preview-smoke-intentional-error"
HTML = '<main id="sample"><h1 id="result">Viewport sample</h1><p>A small page, inside a real sandbox.</p></main>'
CSS = """body { margin: 0; padding: 28px; background: #eef3eb; color: #344b39;
font: 16px/1.6 system-ui; } main { padding: 22px; border: 1px solid #cbd8c6;
border-radius: 16px; background: #fff; } h1 { margin: 0 0 12px; font-size: 28px; }
@media (max-width: 400px) { h1 { color: rgb(140, 45, 75); } }
@media (min-width: 401px) { h1 { color: rgb(30, 80, 145); } }"""


def open_tool(context, base_url, errors):
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url + "/quick.html?kind=tool&toolId=html-preview", wait_until="networkidle")
    page.wait_for_function("window.__DTKIT_TOOL_PAGE__?.ready")
    expect(page.locator("#htmlEditor")).to_be_visible()
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "empty")
    return page


def set_auto(page, enabled):
    checkbox = page.locator("#autoRefreshToggle")
    if checkbox.is_checked() != enabled:
        page.locator(".html-preview-toggle").click()
    assert checkbox.is_checked() == enabled


def select_language(page, language):
    page.locator(f'button[data-tab="{language}"]').click()
    expect(page.locator(f"#{language}Tab")).to_have_attribute("aria-selected", "true")


def set_sources(page, *, html=HTML, css=CSS, js=""):
    set_auto(page, False)
    for language, value in (("html", html), ("css", css), ("js", js)):
        select_language(page, language)
        page.locator(f"#{language}Editor").fill(value)


def run_preview(page):
    page.locator("#refreshPreviewBtn").click()
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "ready")


def sandbox(page):
    frame = page.locator("#previewFrame").element_handle().content_frame()
    assert frame is not None, "Preview sandbox did not load"
    return frame


def assert_no_horizontal_overflow(page):
    metrics = page.evaluate("""() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      nodes: [...document.querySelectorAll('.html-preview-view,.html-preview-container,' +
        '.html-preview-toolbar,.html-preview-main,#previewEditorPanel,#previewResultPanel')]
        .map(node => ({name: node.id || node.className, client: node.clientWidth, scroll: node.scrollWidth}))
    })""")
    assert metrics["document"] <= metrics["viewport"] + 1, metrics
    assert all(node["scroll"] <= node["client"] + 1 for node in metrics["nodes"]), metrics


def screenshot(page, name):
    page.screenshot(path=str(ARTIFACTS / name), full_page=True)


def test_empty_and_keyboard(context, base_url, errors):
    page = open_tool(context, base_url, errors)
    expect(page.locator("#previewEmpty")).to_be_visible()
    expect(page.locator("#previewNotice")).to_be_hidden()
    expect(page.locator("#previewSize")).to_have_text("0 B")
    expect(page.locator("#autoRefreshToggle")).to_be_checked()
    screenshot(page, "desktop-empty-light.png")

    tablist = page.get_by_role("tablist", name="代码语言")
    expect(tablist.get_by_role("tab")).to_have_count(3)
    expect(page.get_by_role("tabpanel")).to_have_count(1)
    for language in ("html", "css", "js"):
        expect(page.locator(f"#{language}Tab")).to_have_attribute("aria-controls", f"{language}EditorPane")
        expect(page.locator(f"#{language}EditorPane")).to_have_attribute("aria-labelledby", f"{language}Tab")

    page.locator("#htmlTab").focus()
    for key, language in (("ArrowRight", "css"), ("ArrowRight", "js"),
                          ("ArrowRight", "html"), ("ArrowLeft", "js"), ("Home", "html"), ("End", "js")):
        page.keyboard.press(key)
        expect(page.locator(f"#{language}Tab")).to_be_focused()
        expect(page.locator(f"#{language}Tab")).to_have_attribute("aria-selected", "true")
        expect(page.locator('[role="tab"][tabindex="0"]')).to_have_count(1)
        expect(page.get_by_role("tabpanel")).to_have_count(1)

    # Tab from the selected tab reaches its editor, skipping both hidden panes.
    page.keyboard.press("Tab")
    expect(page.locator("#jsEditor")).to_be_focused()
    for language in ("html", "css"):
        expect(page.locator(f"#{language}Editor")).to_be_hidden()
        page.locator(f"#{language}Editor").evaluate("node => node.focus()")
        expect(page.locator("#jsEditor")).to_be_focused()
    page.keyboard.press("Shift+Tab")
    expect(page.locator("#jsTab")).to_be_focused()
    expect(page.locator("#jsEditor")).to_have_value("")

    set_auto(page, False)
    select_language(page, "html")
    editor = page.locator("#htmlEditor")
    editor.fill("<p>Undo keeps your draft</p>")
    editor.press("Control+End")
    editor.press("Tab")
    expect(editor).to_have_value("<p>Undo keeps your draft</p>    ")
    editor.press("Control+z")
    expect(editor).to_have_value("<p>Undo keeps your draft</p>")
    editor.press("Shift+Tab")
    expect(page.locator("#htmlTab")).to_be_focused()
    expect(editor).to_have_value("<p>Undo keeps your draft</p>")
    editor.focus()
    editor.press("Escape")
    expect(page.locator("#htmlTab")).to_be_focused()
    page.close()


def test_run_feedback_and_debounce(context, base_url, errors):
    page = open_tool(context, base_url, errors)
    set_sources(page, js="document.getElementById('result').textContent = 'Rendered by JavaScript';")
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "pending")
    expect(page.locator("#previewRunStatus")).to_contain_text("未运行")
    expect(page.locator("#previewEmpty")).to_be_visible()
    page.locator("#jsEditor").press("Control+Enter")
    expect(page.frame_locator("#previewFrame").locator("#result")).to_have_text("Rendered by JavaScript")
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "ready")
    expect(page.locator("#previewEmpty")).to_be_hidden()

    select_language(page, "html")
    page.locator("#htmlEditor").fill(HTML.replace("Viewport sample", "Unrun draft"))
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "pending")
    page.wait_for_timeout(650)  # Manual mode must keep the previous rendered document.
    expect(page.frame_locator("#previewFrame").locator("#result")).to_have_text("Rendered by JavaScript")

    select_language(page, "js")
    page.locator("#jsEditor").fill(f'throw new Error("{EXPECTED_ERROR}");')
    page.locator("#refreshPreviewBtn").click()
    expect(page.locator("#previewNotice")).to_be_visible()
    expect(page.locator("#previewNotice")).to_contain_text(EXPECTED_ERROR)
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "error")
    page.locator("#jsEditor").fill("document.getElementById('result').textContent = 'Recovered';")
    run_preview(page)
    expect(page.frame_locator("#previewFrame").locator("#result")).to_have_text("Recovered")
    expect(page.locator("#previewNotice")).to_be_hidden()

    # Observe actual runner navigations. Running while an auto update is pending
    # must cancel that update, rather than executing the same draft twice.
    page.evaluate("""() => {
      window.__htmlPreviewNavigations = 0;
      new MutationObserver(records => {
        window.__htmlPreviewNavigations += records.filter(record => record.attributeName === 'src').length;
      }).observe(document.getElementById('previewFrame'), {attributes: true, attributeFilter: ['src']});
    }""")
    set_auto(page, True)
    page.locator("#jsEditor").fill("document.getElementById('result').textContent = 'One manual run';")
    page.locator("#jsEditor").press("Control+Enter")
    expect(page.frame_locator("#previewFrame").locator("#result")).to_have_text("One manual run")
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "ready")
    page.wait_for_timeout(750)
    assert page.evaluate("window.__htmlPreviewNavigations") == 1, "Pending debounce recreated the runner after a manual run"

    page.locator("#jsEditor").fill("document.getElementById('result').textContent = 'Auto update';")
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "pending")
    expect(page.frame_locator("#previewFrame").locator("#result")).to_have_text("Auto update")
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "ready")
    assert page.evaluate("window.__htmlPreviewNavigations") == 2
    page.close()


def test_undo_feedback_and_sandbox_escape(context, base_url, errors):
    page = open_tool(context, base_url, errors)
    set_sources(page, html='<button id="insidePreview">Interact with the preview</button>', css="")
    run_preview(page)
    select_language(page, "html")
    editor = page.locator("#htmlEditor")
    rendered = editor.input_value()
    editor.press("Control+End")
    page.keyboard.insert_text("<!-- unrun edit -->")
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "pending")
    editor.press("Control+z")
    expect(editor).to_have_value(rendered)
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "ready")

    dismissals = page.evaluate("window.__multiCalls.filter(call => call.command === 'dismiss_quick_host').length")
    page.locator("#fullscreenBtn").click()
    inside = page.frame_locator("#previewFrame").get_by_role("button", name="Interact with the preview")
    inside.click()
    expect(inside).to_be_focused()
    page.keyboard.press("Escape")
    expect(page.locator("#previewResultPanel")).not_to_have_class(re.compile(r"\bfullscreen\b"))
    expect(page.locator("#fullscreenBtn")).to_be_focused()
    assert page.evaluate("window.__multiCalls.filter(call => call.command === 'dismiss_quick_host').length") == dismissals

    page.locator("#clearCodeBtn").click()
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "empty")
    editor.focus()
    page.keyboard.insert_text("<p>Temporary draft</p>")
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "pending")
    editor.press("Control+z")
    expect(editor).to_have_value("")
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "empty")
    page.close()


def exercise_splitter(page):
    divider = page.get_by_role("separator", name="调整编辑区宽度")
    editor = page.locator("#previewEditorPanel")
    before = editor.bounding_box()["width"]
    divider.focus()
    divider.press("ArrowRight")
    expect(divider).to_have_attribute("aria-valuenow", "47")
    assert editor.bounding_box()["width"] > before
    divider.press("Home")
    divider.press("ArrowLeft")
    expect(divider).to_have_attribute("aria-valuenow", "25")
    divider.press("End")
    divider.press("ArrowRight")
    expect(divider).to_have_attribute("aria-valuenow", "70")
    divider.dblclick()
    expect(divider).to_have_attribute("aria-valuenow", "45")

    bounds = page.locator(".html-preview-main").bounding_box()
    handle = divider.bounding_box()
    page.mouse.move(handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2)
    page.mouse.down()
    page.mouse.move(bounds["x"] + bounds["width"] * .60, handle["y"] + handle["height"] / 2, steps=8)
    page.mouse.up()
    assert 58 <= int(divider.get_attribute("aria-valuenow")) <= 62
    assert editor.bounding_box()["width"] > before
    assert not page.locator(".html-preview-main").evaluate("node => node.classList.contains('is-resizing')")
    divider.dblclick()
    expect(divider).to_have_attribute("aria-valuenow", "45")


def assert_mobile_viewport(page):
    page.get_by_role("button", name="手机 390 × 844", exact=True).click()
    expect(page.locator('[data-viewport="mobile"][aria-pressed="true"]')).to_have_count(1)
    expect(page.locator("#viewportSize")).to_have_text("390 × 844")
    frame = sandbox(page)
    frame.wait_for_function("innerWidth === 390 && innerHeight === 844")
    assert frame.evaluate("matchMedia('(max-width: 400px)').matches") is True
    expect(frame.locator("#result")).to_have_css("color", "rgb(140, 45, 75)")


def test_layout_viewports_and_restore(context, base_url, errors):
    page = open_tool(context, base_url, errors)
    set_sources(page)
    run_preview(page)
    select_language(page, "html")
    assert_no_horizontal_overflow(page)
    exercise_splitter(page)
    assert_mobile_viewport(page)
    page.get_by_role("button", name="平板 768 × 1024", exact=True).click()
    sandbox(page).wait_for_function("innerWidth === 768 && innerHeight === 1024")
    expect(page.frame_locator("#previewFrame").locator("#result")).to_have_css("color", "rgb(30, 80, 145)")
    assert_mobile_viewport(page)

    # Preserve the last rendered page separately from an unrun manual draft.
    select_language(page, "html")
    draft = HTML.replace("Viewport sample", "Saved unrun draft")
    page.locator("#htmlEditor").fill(draft)
    select_language(page, "css")
    page.locator("#cssEditor").evaluate("node => { node.focus(); node.setSelectionRange(2, 16, 'backward'); }")
    page.locator("#previewDivider").focus()
    for _ in range(6):
        page.keyboard.press("ArrowRight")
    page.locator("#fullscreenBtn").click()
    snapshot = page.evaluate("window.__DTKIT_TOOL_PAGE__.snapshot()")
    assert snapshot["state"] is not None and snapshot["canRelease"] is True
    page.keyboard.press("Escape")
    page.locator("#clearCodeBtn").click()
    expect(page.locator("#previewEmpty")).to_be_visible()
    page.get_by_role("button", name="自适应宽度", exact=True).click()
    page.locator("#previewDivider").press("Home")
    set_auto(page, True)
    select_language(page, "js")

    page.evaluate("saved => window.__DTKIT_TOOL_PAGE__.restore(saved)", snapshot)
    expect(page.locator("#previewResultPanel")).to_have_class(re.compile(r"\bfullscreen\b"))
    expect(page.locator("#htmlEditor")).to_have_value(draft)
    expect(page.locator("#cssEditor")).to_have_value(CSS)
    expect(page.locator("#jsEditor")).to_have_value("")
    expect(page.locator("#cssTab")).to_have_attribute("aria-selected", "true")
    expect(page.locator("#autoRefreshToggle")).not_to_be_checked()
    expect(page.locator("#previewDivider")).to_have_attribute("aria-valuenow", "57")
    assert page.locator("#cssEditor").evaluate("node => [node.selectionStart, node.selectionEnd, node.selectionDirection]") == [2, 16, "backward"]
    expect(page.frame_locator("#previewFrame").locator("#result")).to_have_text("Viewport sample")
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "pending")
    assert_mobile_viewport(page)
    page.keyboard.press("Escape")
    expect(page.locator("#fullscreenBtn")).to_be_focused()

    # Capture the same rendered sample in both schemes and compact host sizes.
    page.locator("#previewDivider").dblclick()
    select_language(page, "html")
    page.locator("#htmlEditor").fill(HTML)
    run_preview(page)
    for width, height, name in ((1360, 900, "desktop"), (760, 580, "compact"), (390, 844, "phone")):
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_function("({width}) => innerWidth === width", arg={"width": width})
        expect(page.locator("#htmlEditor")).to_be_visible()
        expect(page.locator("#previewResultPanel")).to_be_visible()
        editor = page.locator("#previewEditorPanel").bounding_box()
        result = page.locator("#previewResultPanel").bounding_box()
        assert editor["height"] > 100 and result["height"] > 100, (editor, result)
        if width >= 760:
            expect(page.locator("#previewDivider")).to_be_visible()
            assert abs(editor["y"] - result["y"]) <= 1 and result["x"] >= editor["x"] + editor["width"], (editor, result)
        else:
            expect(page.locator("#previewDivider")).to_be_hidden()
            assert result["y"] >= editor["y"] + editor["height"] - 1, (editor, result)
        assert_no_horizontal_overflow(page)
        light_surface = None
        for scheme in ("light", "dark"):
            page.emulate_media(color_scheme=scheme, reduced_motion="reduce")
            assert_mobile_viewport(page)
            assert_no_horizontal_overflow(page)
            surface = page.locator(".html-preview-container").evaluate("node => getComputedStyle(node).backgroundColor")
            if scheme == "light":
                light_surface = surface
            else:
                expect(page.locator(".html-preview-view")).to_have_css("color-scheme", "dark")
                assert surface != light_surface, "Dark mode retained the light workspace surface"
            screenshot(page, f"{name}-{width}x{height}-{scheme}.png")
    page.close()


def exercise_editor_scroll(page, frame):
    set_auto(frame, False)
    select_language(frame, "html")
    lines = ['<!-- ' + 'long line ' * 80 + ' -->'] + [f'<p>Line {index}</p>' for index in range(1, 160)]
    editor = frame.locator("#htmlEditor")
    editor.fill("\n".join(lines))
    expect(frame.locator("#editorLineCount")).to_have_text("160 行")
    metrics = editor.evaluate("node => ({height: node.clientHeight, scroll: node.scrollHeight})")
    assert metrics["scroll"] > metrics["height"] + 100, metrics
    body_before = frame.evaluate("document.scrollingElement.scrollTop")
    editor.hover()
    page.mouse.wheel(0, 900)
    frame.wait_for_function("document.getElementById('htmlEditor').scrollTop > 100")
    assert frame.evaluate("document.scrollingElement.scrollTop") == body_before
    assert_no_horizontal_overflow(frame)


def exercise_hidden_scroll_restore(frame):
    sources = {}
    positions = {}
    for index, language in enumerate(("css", "js")):
        select_language(frame, language)
        source = "\n".join(["/* " + "wide source " * 80 + " */"]
                           + [f"/* Saved {language} line {line} */" for line in range(1, 160)])
        sources[language] = source
        field = frame.locator(f"#{language}Editor")
        field.fill(source)
        positions[language] = field.evaluate("""(node, offset) => {
          node.scrollTop = offset; node.scrollLeft = 140;
          return {top: node.scrollTop, left: node.scrollLeft};
        }""", 1100 + index * 250)
        assert positions[language]["top"] > 100 and positions[language]["left"] > 0

    # Both scrolled editors are hidden when the workspace is serialized.
    select_language(frame, "html")
    saved = frame.evaluate("window.__DTKIT_TOOL_PAGE__.snapshot()")
    for language in ("css", "js"):
        select_language(frame, language)
        frame.locator(f"#{language}Editor").fill("/* replacement draft */")
    select_language(frame, "html")
    frame.evaluate("snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)", saved)

    for language in ("css", "js"):
        select_language(frame, language)
        field = frame.locator(f"#{language}Editor")
        expect(field).to_have_value(sources[language])
        actual = field.evaluate("node => ({top: node.scrollTop, left: node.scrollLeft})")
        assert abs(actual["top"] - positions[language]["top"]) <= 1, (language, positions, actual)
        assert abs(actual["left"] - positions[language]["left"]) <= 1, (language, positions, actual)
    assert_no_horizontal_overflow(frame)


def test_scroll_in_both_hosts(context, base_url, errors):
    page = open_tool(context, base_url, errors)
    exercise_editor_scroll(page, page)
    screenshot(page, "quick-editor-160-lines.png")
    exercise_hidden_scroll_restore(page)
    page.close()

    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url, wait_until="networkidle")
    page.locator('[data-tool-id="html-preview"] .tool-card__title').click()
    frame = multi.active_tool_frame(page)
    exercise_editor_scroll(page, frame)
    screenshot(page, "embedded-editor-160-lines.png")
    exercise_hidden_scroll_restore(frame)
    page.close()


def capture_workspace_screenshots(context, base_url, errors):
    page = open_tool(context, base_url, errors)
    page.set_viewport_size({"width": 1360, "height": 900})
    page.get_by_role("button", name="卡片组件", exact=True).click()
    expect(page.frame_locator("#previewFrame").get_by_role("heading", name="精美卡片组件")).to_be_visible()
    expect(page.locator("#previewRunStatus")).to_have_attribute("data-state", "ready")
    select_language(page, "html")
    page.locator("#htmlEditor").press("Control+Home")
    page.get_by_role("button", name="自适应宽度", exact=True).click()
    for scheme in ("light", "dark"):
        page.emulate_media(color_scheme=scheme, reduced_motion="reduce")
        assert_no_horizontal_overflow(page)
        screenshot(page, f"workspace-{scheme}.png")
    page.close()


def run(base_url):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1360, "height": 900},
                                      color_scheme="light", reduced_motion="reduce")
        context.add_init_script(multi.MOCK)

        def apply_csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if "text/html" in headers.get("content-type", ""):
                headers["content-security-policy"] = multi.CSP
            route.fulfill(response=response, headers=headers)

        context.route(base_url + "/**", apply_csp)
        try:
            print("HTML preview: empty state, semantic tabs and native editor keyboard behavior", flush=True)
            test_empty_and_keyboard(context, base_url, errors)
            print("HTML preview: manual drafts, errors, recovery and pending auto refresh", flush=True)
            test_run_feedback_and_debounce(context, base_url, errors)
            print("HTML preview: undo restores feedback and sandbox Escape leaves fullscreen", flush=True)
            test_undo_feedback_and_sandbox_escape(context, base_url, errors)
            print("HTML preview: splitter, real device viewports, restore and responsive screenshots", flush=True)
            test_layout_viewports_and_restore(context, base_url, errors)
            print("HTML preview: 160-line editors scroll internally in quick and embedded hosts", flush=True)
            test_scroll_in_both_hosts(context, base_url, errors)
            capture_workspace_screenshots(context, base_url, errors)
            unexpected = [error for error in errors if EXPECTED_ERROR not in error]
            assert not unexpected, unexpected
        except Exception:
            for index, page in enumerate(context.pages):
                screenshot(page, f"failure-{index}.png")
            raise
        finally:
            context.close()
            browser.close()
    print(f"HTML preview UI smoke passed; screenshots={ARTIFACTS}")


if __name__ == "__main__":
    with multi.production_url() as base_url:
        run(base_url)
