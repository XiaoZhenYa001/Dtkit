from pathlib import Path
from playwright.sync_api import sync_playwright


SCREENSHOT = Path(r"C:\tmp\dtkit-quick-palette.png")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 760, "height": 580})
    page.add_init_script("""
        window.__invocations = [];
        window.__minimized = 0;
        window.__TAURI__ = {
            core: { invoke: async (command, args) => {
                window.__invocations.push({ command, args });
                if (command === 'search_local_files') return {
                    items: [{ name: 'DtKit report.txt', path: 'C:\\\\Users\\\\demo\\\\Documents\\\\DtKit report.txt',
                        parent: 'C:\\\\Users\\\\demo\\\\Documents', isDirectory: false }],
                    truncated: false, elapsedMs: 12, rootsSearched: 4
                };
                return {};
            }},
            event: { listen: async () => () => {} },
            window: { getCurrentWindow: () => ({
                minimize: async () => { window.__minimized += 1; },
                toggleMaximize: async () => {}
            }) }
        };
    """)
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:4173/quick.html?kind=palette")
    page.wait_for_load_state("networkidle")

    assert page.title() == "万能命令面板 · DtKit"
    command = page.locator("#commandInput")
    assert command.evaluate("element => element === document.activeElement")

    command.fill("计算 128*36")
    assert page.locator(".command-result strong").first.text_content() == "4608"
    assert "不执行脚本" in page.locator("#paletteHint").text_content()

    command.fill("编码 你好")
    assert page.locator(".command-result").count() == 2
    assert "Base64" in page.locator(".command-result strong").nth(1).text_content()

    command.fill("倒计时 2分钟 喝水")
    assert "喝水" in page.locator(".command-result strong").text_content()
    page.locator(".command-result").click()
    assert page.evaluate("window.__invocations.at(-1).command") == "create_quick_countdown"
    assert page.evaluate("window.__invocations.at(-1).args.seconds") == 120

    command.fill("> DtKit")
    page.wait_for_selector("text=DtKit report.txt")
    assert "12ms" in page.locator("#paletteHint").text_content()

    command.fill("json")
    assert "JSON 格式化" in page.locator(".command-result strong").text_content()
    command.press("Escape")
    assert command.input_value() == ""
    assert page.locator(".command-result").count() >= 18
    assert page.locator(".command-result").filter(has_text="HTML 预览").count() == 1
    assert page.locator(".command-result").filter(has_text="截图与标注").count() == 1

    page.locator("#quickMinimize").click()
    assert page.evaluate("window.__minimized") == 1

    page.screenshot(path=str(SCREENSHOT))
    assert not errors, errors

    page.set_viewport_size({"width": 560, "height": 400})
    command.fill("计算 (12+8)*3")
    assert page.locator(".command-result strong").text_content() == "60"
    assert page.locator(".command-search").bounding_box()["width"] <= 530
    browser.close()

print(f"quick palette smoke passed; screenshot={SCREENSHOT}")
