from pathlib import Path
from playwright.sync_api import sync_playwright


SCREENSHOT = Path(r"C:\tmp\dtkit-resource-center.png")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1360, "height": 900})
    page.add_init_script("""
        window.__resourceCalls = [];
        window.__resourceSnapshotCount = 0;
        window.__TAURI__ = { core: { invoke: async (command, args) => {
            window.__resourceCalls.push({ command, args });
            if (command === 'take_missed_alarm_triggers') return [];
            if (command === 'get_resource_policy') return {
                quickHostStandardRetentionSeconds: 60, quickHostEfficientRetentionSeconds: 10,
                maxWorkersOnBattery: 2, maxWorkersOnAc: 4, cacheLimitBytes: 104857600,
                cacheRetentionDays: 7, logRetentionDays: 7
            };
            if (command === 'get_resource_snapshot') {
                window.__resourceSnapshotCount += 1;
                return { mode: 'efficient', capturedAt: Date.now(), powerSource: 'battery',
                    effectiveWorkerLimit: 2, nativeWorkingSetBytes: 32505856, webviewCount: 2,
                    mainWindowOpen: true, quickHostOpen: false, activeJobs: 1, recordedJobs: 4,
                    registeredShortcuts: 3, lanShareActive: false,
                    storage: { cacheBytes: 10485760, logBytes: 1048576, tempTransferBytes: 5242880,
                        jobBytes: 131072, recoveryBytes: 2097152 } };
            }
            if (command === 'release_idle_resources') return { quickHostReleased: false,
                hiddenOrganizerReleased: true, nativeWorkingSetTrimmed: true };
            return true;
        }}};
    """)
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:4173")
    page.wait_for_load_state("networkidle")
    page.locator('[data-tool-id="resource-center"]').click()
    page.locator("#resourcePolicyForm").wait_for(state="visible")
    page.wait_for_function("document.querySelector('#resourceMetrics')?.textContent.includes('31.0 MB')")

    assert "31.0 MB" in page.locator("#resourceMetrics").inner_text()
    assert "电池供电" in page.locator("#resourceMetrics").inner_text()
    assert "18.1 MB" in page.locator("#resourceStorageTotal").text_content()
    resource_form = page.locator("#resourcePolicyForm")
    assert resource_form.locator('input[name="minimizeMode"][value="efficient"]').is_checked()

    initial_count = page.evaluate("window.__resourceSnapshotCount")
    page.wait_for_timeout(700)
    assert page.evaluate("window.__resourceSnapshotCount") == initial_count, "resource center must not poll"

    page.locator("#resourceRefresh").click()
    page.wait_for_function(f"window.__resourceSnapshotCount === {initial_count + 1}")
    page.locator("#resourceBatteryWorkers").fill("1")
    page.locator("#resourceAcWorkers").fill("3")
    page.locator("#resourceCacheLimit").fill("80")
    resource_form.locator(".resource-mode-options label").filter(has_text="深度休眠").click()
    assert resource_form.locator('input[name="minimizeMode"][value="deep"]').is_checked()
    page.locator('#resourcePolicyForm button[type="submit"]').click()
    page.wait_for_function("window.__resourceCalls.some(call => call.command === 'set_resource_policy')")
    page.wait_for_function("window.__resourceCalls.some(call => call.command === 'set_minimize_mode' && call.args.mode === 'deep')")

    saved = page.evaluate("window.__resourceCalls.find(call => call.command === 'set_resource_policy').args.policy")
    assert saved["maxWorkersOnBattery"] == 1
    assert saved["maxWorkersOnAc"] == 3
    assert saved["cacheLimitBytes"] == 80 * 1024 * 1024

    page.locator("#resourceRelease").click()
    page.wait_for_function("window.__resourceCalls.some(call => call.command === 'release_idle_resources')")
    assert "隐藏桌面整理窗口" in page.locator("#resourceStatus").text_content()
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    assert not errors, errors
    browser.close()

print(f"resource center UI smoke passed; screenshot={SCREENSHOT}")
