import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("DTKIT_TEST_BASE_URL", "http://127.0.0.1:4173")
SCREENSHOT_DIR = Path(r"C:\tmp\dtkit-settings-refactor")


def open_settings(page):
    response = page.goto(BASE_URL, wait_until="networkidle")
    assert response and response.ok, f"Preview failed: {response.status if response else 'no response'}"
    settings_button = page.locator('[data-view="settings"]')
    settings_button.wait_for(state="visible")
    settings_button.click()
    page.locator("#settingsView.view--active").wait_for(state="visible")
    page.locator(".settings-side-nav").wait_for(state="visible")
    page.wait_for_timeout(300)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    page = browser.new_page(viewport={"width": 1360, "height": 900})
    page.add_init_script("""
        window.__shortcutBindings = [];
        window.__cleanupCalls = [];
        window.__cleanupStatus = {
            policy: { automaticEnabled: false, lastAutomaticRunAt: null },
            usage: { cacheBytes: 1536, logBytes: 2048, recoveryBytes: 0, tempTransferBytes: 0, jobBytes: 0 },
            latestRecoveryBatchId: null,
            running: false,
            cacheRetentionDays: 7,
            logRetentionDays: 7
        };
        window.__TAURI__ = {
            core: {
                invoke: async (command, args = {}) => {
                    if (command === 'get_storage_layout') return {
                        root: 'D:\\DtKit', downloads: 'D:\\DtKit\\Downloads', writable: true, warning: null
                    };
                    if (command === 'migrate_storage_root') return {
                        layout: { root: args.targetRoot, downloads: args.targetRoot + String.fromCharCode(92) + 'Downloads', writable: true, warning: null },
                        filesCopied: 12, bytesCopied: 2048, previousRoot: 'D:\\DtKit'
                    };
                    if (command === 'get_shortcut_bindings') return window.__shortcutBindings;
                    if (command === 'replace_shortcut_bindings') {
                        window.__shortcutBindings = args.bindings;
                        return window.__shortcutBindings;
                    }
                    if (command === 'get_cleanup_status') return window.__cleanupStatus;
                    if (command === 'set_automatic_cleanup_enabled') {
                        window.__cleanupStatus.policy.automaticEnabled = args.enabled;
                        return window.__cleanupStatus.policy;
                    }
                    if (command === 'set_cleanup_retention_days') {
                        window.__cleanupStatus.cacheRetentionDays = args.cacheDays;
                        window.__cleanupStatus.logRetentionDays = args.logDays;
                        return null;
                    }
                    if (command === 'run_storage_cleanup') {
                        window.__cleanupCalls.push(args.request);
                        if (!args.request.permanent) {
                            window.__cleanupStatus.latestRecoveryBatchId = 'cleanup-test';
                            window.__cleanupStatus.usage.cacheBytes = 0;
                            window.__cleanupStatus.usage.logBytes = 0;
                            window.__cleanupStatus.usage.recoveryBytes = 3584;
                        }
                        return { permanent: args.request.permanent, filesProcessed: 3, bytesProcessed: 3584, recoveryBatchId: 'cleanup-test' };
                    }
                    if (command === 'restore_latest_cleanup') {
                        window.__cleanupStatus.latestRecoveryBatchId = null;
                        return { permanent: false, filesProcessed: 3, bytesProcessed: 3584, recoveryBatchId: 'cleanup-test' };
                    }
                    return null;
                }
            }
        };
    """)
    console_errors = []
    page_errors = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    open_settings(page)

    assert page.locator("#settingsView .settings-section").count() == 6
    assert page.locator(".settings-side-nav__item").count() == 6
    assert page.locator("#configSection button:disabled").count() == 2
    assert page.locator("#generalSection input:disabled").count() == 2
    assert page.locator("#minimizeModeOptions [data-minimize-mode]").count() == 3
    assert page.locator('input[name="minimizeMode"]:checked').input_value() == "efficient"
    page.locator('#cleanupStatus').filter(has_text='自动清理：未启用').wait_for()
    assert page.locator('#cleanupCacheUsage').inner_text() == '1.50 KB'

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
    assert page.evaluate("localStorage.getItem('dtkit_downloadPath')") == download_path + r"\Downloads"
    page.locator('#storageRootStatus').filter(has_text='目录可用').wait_for()

    shortcut = page.locator('#shortcutBindings .shortcut-binding__record')
    page.locator('#shortcutStatus').filter(has_text='各工具的专属快捷键').wait_for()
    shortcut.click()
    assert "is-recording" in (shortcut.get_attribute("class") or "")
    page.keyboard.press("Control+Alt+K")
    assert "Ctrl" in shortcut.inner_text()
    shortcuts = page.evaluate("window.__shortcutBindings")
    assert shortcuts[0]["accelerator"] == "Ctrl+Alt+K"
    assert shortcuts[0]["target"]["kind"] == "palette"

    page.locator('#runStorageCleanup').click()
    page.locator('#cleanupRecoveryUsage').filter(has_text='3.50 KB').wait_for()
    cleanup_calls = page.evaluate('window.__cleanupCalls')
    assert cleanup_calls[0] == {"targets": ["cache", "logs"], "permanent": False}
    assert page.locator('#restoreLatestCleanup').is_enabled()

    page.locator('#permanentCleanupEnabled').check()
    assert page.locator('#cleanupTargetRecovery').is_enabled()
    page.locator('#cleanupTargetRecovery').check()
    page.locator('#runStorageCleanup').click()
    danger_dialog = page.locator('#desktopOrganizerConfirmDialog')
    assert danger_dialog.is_visible()
    assert '无法从 DtKit 恢复' in page.locator('#desktopOrganizerDialogMessage').inner_text()
    assert 'modal-btn--danger' in (page.locator('#confirmDesktopOrganizer').get_attribute('class') or '')
    page.locator('#confirmDesktopOrganizer').click()
    page.wait_for_function('window.__cleanupCalls.length === 2')
    cleanup_calls = page.evaluate('window.__cleanupCalls')
    assert cleanup_calls[1]["permanent"] is True
    assert "recovery" in cleanup_calls[1]["targets"]

    assert page.locator("#customSourceDialog").count() == 0
    assert page.locator("#mirrorSourceSelect").count() == 0
    assert page.locator("#auto-open-folder").count() == 0

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

    page.locator('.settings-side-nav__item[href="#generalSection"]').click()
    page.locator('input[name="minimizeMode"][value="deep"]').check()
    assert page.evaluate("localStorage.getItem('dtkit_minimize_mode')") == "deep"
    assert "selected" in (page.locator('[data-minimize-mode="deep"]').get_attribute("class") or "")
    page.screenshot(path=str(SCREENSHOT_DIR / "settings-minimize-modes.png"), full_page=True)

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
    assert mobile.locator(".settings-side-nav__item").count() == 6
    assert mobile.locator("#minimizeModeOptions").evaluate(
        "element => getComputedStyle(element).gridTemplateColumns.split(' ').length"
    ) == 1
    mobile.screenshot(path=str(SCREENSHOT_DIR / "settings-mobile.png"), full_page=True)

    assert not page_errors, f"Page errors: {page_errors}"
    assert not console_errors, f"Console errors: {console_errors}"
    assert not mobile_errors, f"Mobile page errors: {mobile_errors}"
    browser.close()

print(f"Settings UI smoke test passed; content height: {layout['contentHeight']:.0f}px")
