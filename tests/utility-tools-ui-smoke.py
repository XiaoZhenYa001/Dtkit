from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:4173"
SCREENSHOT_DIR = Path(r"C:\tmp\dtkit-utility-tools")


def open_library(page):
    page.goto(BASE_URL)
    page.wait_for_load_state("networkidle")
    page.locator(".tool-card").first.wait_for(state="visible")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1360, "height": 900})
    console_errors = []
    page_errors = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    open_library(page)

    for tool_id in ("image-compressor", "favicon-generator"):
        card = page.locator(f'[data-tool-id="{tool_id}"]')
        assert card.get_attribute("data-status") == "planned"
        assert card.get_attribute("aria-disabled") == "true"
        assert "即将推出" in card.inner_text()
        card.click()
        assert page.locator(f'#dynamicToolContainer[data-tool-id="{tool_id}"]').count() == 0

    page.locator('[data-tool-id="url-encoder"]').click()
    page.locator("#urlInput").wait_for(state="visible")
    source_url = "https://example.com/搜索?q=桌面 工具&lang=zh-CN"
    page.locator("#urlMode").select_option("full")
    page.locator("#urlInput").fill(source_url)
    page.locator("#urlEncodeBtn").click()
    encoded_url = page.locator("#urlOutput").input_value()
    assert encoded_url.startswith("https://example.com/")
    assert "%E6%90%9C%E7%B4%A2" in encoded_url
    page.locator("#urlSwapBtn").click()
    page.locator("#urlDecodeBtn").click()
    assert page.locator("#urlOutput").input_value() == source_url
    page.screenshot(path=str(SCREENSHOT_DIR / "url-encoder.png"), full_page=True)

    open_library(page)
    page.locator('[data-tool-id="unit-converter"]').click()
    page.locator("#unitInput").wait_for(state="visible")
    page.locator("#unitCategory").select_option("temperature")
    page.locator("#unitFrom").select_option("c")
    page.locator("#unitTo").select_option("f")
    page.locator("#unitInput").fill("100")
    assert page.locator("#unitOutput").input_value() == "212"
    assert "100 °C = 212 °F" in page.locator("#unitEquation").inner_text()
    page.screenshot(path=str(SCREENSHOT_DIR / "unit-converter.png"), full_page=True)

    open_library(page)
    page.locator('[data-tool-id="crontab-explainer"]').click()
    page.locator("#cronInput").wait_for(state="visible")
    page.locator("#cronInput").fill("0 9 * * MON-FRI")
    page.locator("#cronExplainBtn").click()
    assert "周一" in page.locator("#cronSummary").inner_text()
    assert page.locator("#cronFieldGrid .cron-field-card").count() == 5
    assert page.locator("#cronUpcoming li").count() == 5

    page.locator("#cronInput").fill("60 * * * *")
    page.locator("#cronExplainBtn").click()
    assert page.locator("#cronError").is_visible()
    assert "超出范围" in page.locator("#cronError").inner_text()
    page.screenshot(path=str(SCREENSHOT_DIR / "crontab-explainer.png"), full_page=True)

    assert not page_errors, f"Page errors: {page_errors}"
    assert not console_errors, f"Console errors: {console_errors}"
    browser.close()

print("Utility tool UI smoke test passed")
