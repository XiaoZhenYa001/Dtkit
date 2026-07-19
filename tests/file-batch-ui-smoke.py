from pathlib import Path
from playwright.sync_api import sync_playwright


SCREENSHOT = Path(r"C:\tmp\dtkit-file-batch.png")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1360, "height": 900})
    page.add_init_script("""
        window.__batchRequests = [];
        window.__batchListener = null;
        window.__TAURI__ = {
            dialog: { open: async options => options.directory
                ? 'C:\\\\Users\\\\demo\\\\Documents\\\\Output'
                : ['C:\\\\Users\\\\demo\\\\Documents\\\\one.txt', 'C:\\\\Users\\\\demo\\\\Documents\\\\two.txt'] },
            event: { listen: async (name, listener) => { window.__batchListener = listener; return () => {}; } },
            core: { invoke: async (command, args) => {
                window.__batchRequests.push({ command, args });
                if (command === 'take_missed_alarm_triggers') return [];
                if (command === 'preview_file_batch') return {
                    operation: args.request.operation,
                    items: args.request.sources.map((source, index) => ({
                        source, target: args.request.operation === 'delete' ? null : `C:\\\\Output\\\\renamed-${index + 1}.txt`,
                        name: source.split('\\\\').at(-1), size: 1024, conflict: null
                    })),
                    skipped: 0, totalBytes: 2048, hasConflicts: false, permanent: args.request.permanent
                };
                if (command === 'start_file_batch') {
                    const jobId = `job-${window.__batchRequests.length}`;
                    window.__batchListener?.({ payload: { jobId, status: 'completed', progress: 1,
                        result: { processed: 2, total: 2, bytesProcessed: 2048, cancelled: false,
                            recoveryBatchId: args.request.permanent ? null : 'file-batch-test' }, error: null } });
                    return { jobId, fileCount: 2, totalBytes: 2048 };
                }
                if (command === 'restore_file_batch') return { batchId: args.batchId, restored: 2, skipped: 0 };
                return true;
            }}
        };
    """)
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:4173")
    page.wait_for_load_state("networkidle")
    page.locator('[data-tool-id="file-batch"]').click()
    page.locator("#batchSelectFiles").wait_for(state="visible")

    page.locator("#batchSelectFiles").click()
    assert "已选择 2 个文件" in page.locator("#batchSelectionSummary").inner_text()
    page.locator("#batchNamePattern").fill("archive-{n}{dotext}")
    page.locator("#batchPreview").click()
    page.locator(".batch-preview-row").first.wait_for(state="visible")
    assert page.locator(".batch-preview-row").count() == 2
    assert not page.locator("#batchExecute").is_disabled()

    page.locator("#batchExecute").click()
    page.wait_for_function("document.querySelector('#batchProgressLabel').textContent === '处理完成'")
    assert page.locator("#batchProgressValue").text_content() == "100%"

    page.locator('input[name="batchOperation"][value="delete"]').locator("..").click()
    page.locator("#batchPermanent").check()
    page.locator("#batchPreview").click()
    page.locator("#batchExecute").click()
    assert page.locator("#batchDangerDialog").evaluate("dialog => dialog.open")
    assert "无法通过 DtKit 撤销" in page.locator("#batchDangerDialog").inner_text()
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    page.locator("#batchConfirmPermanent").click()
    page.wait_for_function("document.querySelector('#batchProgressLabel').textContent === '处理完成'")

    requests = page.evaluate("window.__batchRequests")
    permanent_starts = [item for item in requests if item["command"] == "start_file_batch" and item["args"]["request"]["permanent"]]
    assert len(permanent_starts) == 1
    assert not errors, errors
    browser.close()

print(f"file batch UI smoke passed; screenshot={SCREENSHOT}")
