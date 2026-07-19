from pathlib import Path
from playwright.sync_api import sync_playwright


SCREENSHOT = Path(r"C:\tmp\dtkit-transfer-station.png")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1360, "height": 900})
    page.add_init_script("""
        const now = Date.now();
        window.__transferItems = [
            { id: '11111111-1111-4111-8111-111111111111', name: 'project-notes.txt', size: 2048, createdAt: now, expiresAt: now + 86400000 },
            { id: '22222222-2222-4222-8222-222222222222', name: 'design-preview.png', size: 1048576, createdAt: now, expiresAt: now + 86400000 }
        ];
        window.__transferCalls = [];
        window.__shareListener = null;
        window.__removedSafe = null;
        window.__TAURI__ = {
            dialog: { open: async options => options.directory
                ? 'C:\\\\Users\\\\demo\\\\Desktop\\\\Export'
                : ['C:\\\\Users\\\\demo\\\\Desktop\\\\new-file.pdf'] },
            event: { listen: async (name, listener) => {
                if (name === 'lan-share-stopped') window.__shareListener = listener;
                return () => {};
            }},
            core: { invoke: async (command, args) => {
                window.__transferCalls.push({ command, args });
                if (command === 'take_missed_alarm_triggers') return [];
                if (command === 'list_transfer_items') return window.__transferItems;
                if (command === 'get_lan_share') return null;
                if (command === 'import_transfer_files') {
                    const item = { id: '33333333-3333-4333-8333-333333333333', name: 'new-file.pdf', size: 4096,
                        createdAt: Date.now(), expiresAt: Date.now() + args.request.ttlSeconds * 1000 };
                    window.__transferItems.unshift(item);
                    return { imported: [item], totalBytes: 4096 };
                }
                if (command === 'export_transfer_item') return 'C:\\\\Users\\\\demo\\\\Desktop\\\\Export\\\\project-notes.txt';
                if (command === 'start_lan_share') return { shareId: 'share-1', itemId: args.itemId,
                    itemName: window.__transferItems.find(item => item.id === args.itemId).name,
                    url: 'http://192.168.1.8:45678/download?token=secret-test-token', expiresAt: Date.now() + 600000 };
                if (command === 'stop_lan_share') return true;
                if (command === 'remove_transfer_item') {
                    const index = window.__transferItems.findIndex(item => item.id === args.itemId);
                    const [removed] = window.__transferItems.splice(index, 1);
                    if (!args.permanent) window.__removedSafe = removed;
                    return { permanent: args.permanent, recoveryBatchId: args.permanent ? null : 'transfer-removed-test' };
                }
                if (command === 'restore_transfer_item') {
                    window.__transferItems.unshift(window.__removedSafe);
                    window.__removedSafe = null;
                    return { batchId: args.batchId, restored: true };
                }
                return true;
            }}
        };
    """)
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:4173")
    page.wait_for_load_state("networkidle")
    page.locator('[data-tool-id="transfer-station"]').click()
    page.locator("#transferImport").wait_for(state="visible")

    assert page.locator(".transfer-item").count() == 2
    assert "2 / 100" in page.locator("#transferSummary").text_content()

    page.locator("#transferImport").click()
    page.wait_for_function("document.querySelectorAll('.transfer-item').length === 3")
    assert "new-file.pdf" in page.locator(".transfer-item").first.inner_text()

    first = page.locator(".transfer-item").first
    first.locator('[data-transfer-action="share"]').click()
    assert page.locator("#transferShareActive").is_visible()
    assert "192.168.1.8" in page.locator("#transferShareUrl").input_value()
    page.evaluate("window.__shareListener({ payload: { shareId: 'share-1', reason: 'downloaded' } })")
    assert page.locator("#transferShareActive").is_hidden()
    assert "自动停止" in page.locator("#transferStatus").text_content()

    page.locator(".transfer-item").first.locator('[data-transfer-action="remove"]').click()
    assert page.locator("#transferRemoveDialog").evaluate("dialog => dialog.open")
    assert not page.locator("#transferPermanent").is_checked()
    page.locator("#transferConfirmRemove").click()
    page.wait_for_function("document.querySelectorAll('.transfer-item').length === 2")
    assert page.locator("#transferUndo").is_visible()
    page.locator("#transferRestore").click()
    page.wait_for_function("document.querySelectorAll('.transfer-item').length === 3")

    page.locator(".transfer-item").nth(1).locator('[data-transfer-action="remove"]').click()
    page.locator("#transferPermanent").check()
    assert "无法通过 DtKit 恢复" in page.locator("#transferRemoveDescription").text_content()
    assert "彻底删除" in page.locator("#transferConfirmRemove").text_content()
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    page.locator("#transferConfirmRemove").click()
    page.wait_for_function("document.querySelectorAll('.transfer-item').length === 2")

    calls = page.evaluate("window.__transferCalls")
    assert any(call["command"] == "import_transfer_files" and call["args"]["request"]["ttlSeconds"] == 86400 for call in calls)
    assert any(call["command"] == "remove_transfer_item" and call["args"]["permanent"] for call in calls)
    assert not errors, errors
    browser.close()

print(f"transfer station UI smoke passed; screenshot={SCREENSHOT}")
