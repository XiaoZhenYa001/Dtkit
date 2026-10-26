"""Regression for concurrent shortcut controls using production DOM and IPC seams."""
import importlib.util
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('shortcut_ui_helpers', ROOT / 'tests/desktop-space-activation-ui-smoke.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.MOCK += r"""
(() => {
    window.__pendingShortcutWrites = [];
    window.__holdShortcutWrites = true;
    const invoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = (command,args={}) => {
        if (command === 'get_shortcut_bindings' && window.__failShortcutRefresh) return Promise.reject(new Error('REFRESH_FAILURE_FIXTURE'));
        if (command === 'upsert_shortcut_binding' && window.__holdShortcutWrites) {
            return new Promise((resolve,reject) => window.__pendingShortcutWrites.push({command,args,resolve,reject}));
        }
        return invoke(command,args);
    };
    window.__releaseShortcutWrites = async () => {
        window.__holdShortcutWrites = false;
        for (const pending of [...window.__pendingShortcutWrites].reverse()) {
            try { pending.resolve(await invoke(pending.command,pending.args)); }
            catch (error) { pending.reject(error); }
        }
    };
})();
"""


def main():
    url, close_server = helper.local_test_url()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                context, page = helper.open_settings(browser, url, enabled=True, presentation='classic')
                try:
                    space = page.locator('#shortcutBindings button[aria-label="设置“桌面空间”的快捷键"]')
                    palette = page.locator('#shortcutBindings button[aria-label="设置“万能命令面板”的快捷键"]')
                    space.click()
                    page.keyboard.press('Control+Alt+Y')
                    page.wait_for_function('window.__pendingShortcutWrites.length === 1')
                    expect(space).to_be_disabled()
                    palette.click()
                    page.keyboard.press('Control+Alt+U')
                    page.wait_for_function('window.__pendingShortcutWrites.length === 2')
                    expect(palette).to_be_disabled()
                    page.evaluate('window.__releaseShortcutWrites()')
                    expect(space).to_be_enabled()
                    expect(palette).to_be_enabled()
                    expect(space).to_contain_text('Y')
                    expect(palette).to_contain_text('U')
                    bindings = page.evaluate('window.__bindings')
                    assert len(bindings) == 3, bindings
                    assert next(item for item in bindings if item['target']['kind'] == 'desktopSpace')['accelerator'] == 'Ctrl+Alt+Y'
                    assert next(item for item in bindings if item['target']['kind'] == 'palette')['accelerator'] == 'Ctrl+Alt+U'
                    assert any(item['target'].get('toolId') == 'timestamp-converter' for item in bindings)
                    assert not page.evaluate("window.__calls.some(call => call.command === 'replace_shortcut_bindings')")

                    # A failed restored key stays configured and reports its cause.
                    page.evaluate('''() => {
                        const item = window.__bindings.find(binding => binding.target.kind === 'desktopSpace');
                        item.registered = false; item.registrationError = 'RESTORE_CONFLICT_FIXTURE';
                        window.dispatchEvent(new CustomEvent('dtkit:shortcut-bindings-changed', {detail:{bindings:window.__bindings}}));
                    }''')
                    expect(space.locator('xpath=ancestor::div[contains(@class,"shortcut-binding")][last()]')).to_contain_text('RESTORE_CONFLICT_FIXTURE')
                    page.locator('#shortcutBindings button[aria-label="清除“桌面空间”的快捷键"]').click()
                    page.wait_for_function("!window.__bindings.some(binding => binding.target.kind === 'desktopSpace')")
                    remaining = page.evaluate('window.__bindings')
                    assert len(remaining) == 2 and any(item['target']['kind'] == 'palette' for item in remaining)
                    assert any(item['target'].get('toolId') == 'timestamp-converter' for item in remaining)
                    page.evaluate('window.__failShortcutRefresh = true')
                    space.click()
                    page.keyboard.press('Control+Alt+V')
                    expect(space.locator('xpath=ancestor::div[contains(@class,"shortcut-binding")][last()]')).to_contain_text('已保存，状态刷新失败')
                    assert next(item for item in page.evaluate('window.__bindings') if item['target']['kind'] == 'desktopSpace')['accelerator'] == 'Ctrl+Alt+V'
                    page.evaluate('window.__failShortcutRefresh = false; window.dispatchEvent(new Event("focus"))')
                    expect(space).to_contain_text('V')
                    print('PASS: delayed concurrent controls preserve both edits and unrelated tool; failed restored key is visible; target removal preserves others', flush=True)
                finally:
                    context.close()
            finally:
                browser.close()
    finally:
        close_server()


if __name__ == '__main__':
    main()
