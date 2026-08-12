import os
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("DTKIT_TEST_BASE_URL", "http://127.0.0.1:4173")
SCREENSHOT_DIR = Path(os.environ.get("DTKIT_TEST_ARTIFACTS", r"C:\tmp\dtkit-data-converter"))


def assert_no_overflow(page, selector):
    overflow = page.locator(selector).evaluate(
        "element => ({ width: element.scrollWidth, viewport: element.clientWidth })"
    )
    if overflow["width"] > overflow["viewport"] + 1:
        raise AssertionError(f"Horizontal overflow in {selector}: {overflow!r}")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.on(
        "console",
        lambda message: errors.append(f"console.error: {message.text}")
        if message.type == "error"
        else None,
    )
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    page.goto(BASE_URL, wait_until="networkidle")
    card = page.locator('[data-tool-id="json-formatter"]')
    card.wait_for(state="visible")
    if "JSON / YAML / XML" not in card.inner_text():
        raise AssertionError("Updated converter title is missing from the tool library")
    card.click()
    page.locator("#jsonInput").wait_for(state="visible")

    page.locator("#jsonInput").fill('{"app":"DtKit","items":[1,2],"ready":true}')
    expect(page.locator("#jsonStatus")).to_contain_text("JSON → YAML", timeout=10000)
    expect(page.locator("#jsonOutput")).to_have_value(re.compile("app: DtKit"))
    expect(page.locator("#jsonDetectedBadge")).to_contain_text("JSON 已识别")

    page.locator('[data-target-format="xml"]').click()
    expect(page.locator("#jsonOutput")).to_have_value(re.compile("<root>"), timeout=10000)
    expect(page.locator("#jsonOutput")).to_have_value(re.compile("<ready>true</ready>"))

    page.locator("#jsonSwapBtn").click()
    expect(page.locator("#jsonInput")).to_have_value(re.compile("<root>"))
    expect(page.locator('[data-source-format="xml"]')).to_have_attribute("aria-pressed", "true")
    expect(page.locator("#jsonOutput")).to_have_value(re.compile('"app": "DtKit"'), timeout=10000)

    page.locator('[data-example-format="yaml"]').click()
    expect(page.locator("#jsonOutput")).to_have_value(re.compile('"project": "DtKit"'), timeout=10000)
    page.locator("#jsonInput").fill("project: DtKit\nitems: [one, two")
    expect(page.locator("#jsonErrorPanel")).to_be_visible(timeout=10000)
    expect(page.locator("#jsonErrorTitle")).to_contain_text("第")
    page.locator("#jsonLocateError").click()
    if page.locator("#jsonInput").evaluate("element => element.selectionStart") <= 0:
        raise AssertionError("Error locator did not move the source selection")

    assert_no_overflow(page, ".data-converter-shell")
    page.screenshot(path=str(SCREENSHOT_DIR / "desktop.png"), full_page=True)

    page.set_viewport_size({"width": 760, "height": 820})
    assert_no_overflow(page, ".data-converter-shell")
    page.screenshot(path=str(SCREENSHOT_DIR / "narrow.png"), full_page=True)

    quick = browser.new_page(viewport={"width": 980, "height": 700})
    quick_errors = []
    quick.on("pageerror", lambda error: quick_errors.append(f"pageerror: {error}"))
    quick.goto(f"{BASE_URL}/quick.html?kind=tool&toolId=json-formatter", wait_until="networkidle")
    quick.locator("#jsonInput").wait_for(state="visible")
    quick.locator("#jsonInput").fill("<project><name>DtKit</name></project>")
    expect(quick.locator("#jsonOutput")).to_have_value(re.compile("project:\\s+name: DtKit"), timeout=10000)
    assert_no_overflow(quick, ".data-converter-shell")
    quick.screenshot(path=str(SCREENSHOT_DIR / "quick-window.png"), full_page=True)

    if errors or quick_errors:
        raise AssertionError("Runtime errors:\n" + "\n".join(errors + quick_errors))
    quick.close()
    browser.close()

print("Data converter UI smoke test passed")
