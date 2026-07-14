from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:4173"
SCREENSHOT_DIR = Path(r"C:\tmp\dtkit-settings-refactor")


def open_settings(page):
    page.goto(BASE_URL)
    page.wait_for_load_state("networkidle")
    page.locator('[data-view="settings"]').click()
    page.locator("#settingsView.view--active").wait_for(state="visible")
    page.locator(".settings-side-nav").wait_for(state="visible")
    page.wait_for_timeout(300)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    page = browser.new_page(viewport={"width": 1360, "height": 900})
    console_errors = []
    page_errors = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    open_settings(page)

    assert page.locator("#settingsView .settings-section").count() == 5
    assert page.locator(".settings-side-nav__item").count() == 5
    assert page.locator("#configSection button:disabled").count() == 2
    assert page.locator("#generalSection input:disabled").count() == 2

    layout = page.evaluate("""() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        contentHeight: document.querySelector('#settingsView .settings-content').getBoundingClientRect().height
    })""")
    assert layout["scrollWidth"] <= layout["clientWidth"]
    assert layout["contentHeight"] < 2600
    page.screenshot(path=str(SCREENSHOT_DIR / "settings-desktop-top.png"), full_page=True)

    download_path = r"D:\Downloads\DtKit Refactor"
    page.locator("#downloadPathInput").fill(download_path)
    page.locator("#changeDownloadPathBtn").click()
    assert page.evaluate("localStorage.getItem('dtkit_downloadPath')") == download_path

    shortcut = page.locator('[data-shortcut-id="recentTool"]')
    shortcut.focus()
    page.keyboard.press("Enter")
    assert "recording" in (shortcut.get_attribute("class") or "")
    page.keyboard.press("Control+Alt+K")
    assert "Ctrl" in shortcut.inner_text()
    shortcuts = page.evaluate("JSON.parse(localStorage.getItem('dtkit_shortcuts'))")
    assert shortcuts["recentTool"] == "Ctrl+Alt+K"

    config_button = page.locator("#configCustomSourceBtn")
    config_button.click()
    dialog = page.locator("#customSourceDialog")
    assert dialog.is_visible()
    assert page.locator("#customSourceInput").evaluate("element => document.activeElement === element")
    page.locator("#customSourceInput").fill('{"name":"Local","url":"file://mirror"}')
    page.locator("#confirmCustomSource").click()
    assert page.locator("#customSourceError").is_visible()
    assert "HTTP 或 HTTPS" in page.locator("#customSourceError").inner_text()

    page.locator("#customSourceInput").fill('{"name":"Team Mirror","url":"https://mirror.example/npm"}')
    page.locator("#confirmCustomSource").click()
    assert not dialog.is_visible()
    assert page.locator("#mirrorSourceSelect").input_value() == "custom"
    assert page.locator('#mirrorSourceSelect option[value="custom"]').get_attribute("data-url") == "https://mirror.example/npm"
    assert config_button.evaluate("element => document.activeElement === element")

    desktop_toggle = page.locator("#desktopOrganizerToggle")
    desktop_toggle.check()
    confirm_dialog = page.locator("#desktopOrganizerConfirmDialog")
    assert confirm_dialog.is_visible()
    page.locator("#cancelDesktopOrganizer").click()
    assert not desktop_toggle.is_checked()

    desktop_toggle.check()
    page.locator("#confirmDesktopOrganizer").click()
    assert desktop_toggle.is_checked()
    assert page.locator("#desktopOrganizerSubSettings").is_visible()
    organizer_settings = page.evaluate("JSON.parse(localStorage.getItem('dtkit_desktop_organizer'))")
    assert organizer_settings["enabled"] is True

    page.locator('.settings-side-nav__item[href="#configSection"]').click()
    page.wait_for_timeout(500)
    assert page.locator('.settings-side-nav__item[href="#configSection"]').get_attribute("aria-current") == "true"
    page.screenshot(path=str(SCREENSHOT_DIR / "settings-desktop.png"), full_page=True)

    mobile = browser.new_page(viewport={"width": 430, "height": 850})
    mobile_errors = []
    mobile.on("pageerror", lambda error: mobile_errors.append(str(error)))
    open_settings(mobile)
    mobile_layout = mobile.evaluate("""() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
    })""")
    assert mobile_layout["scrollWidth"] <= mobile_layout["clientWidth"]
    assert mobile.locator(".settings-side-nav__item").count() == 5
    mobile.screenshot(path=str(SCREENSHOT_DIR / "settings-mobile.png"), full_page=True)

    assert not page_errors, f"Page errors: {page_errors}"
    assert not console_errors, f"Console errors: {console_errors}"
    assert not mobile_errors, f"Mobile page errors: {mobile_errors}"
    browser.close()

print(f"Settings UI smoke test passed; content height: {layout['contentHeight']:.0f}px")
