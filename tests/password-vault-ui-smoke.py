from pathlib import Path
from playwright.sync_api import sync_playwright


MOCK_TAURI = r"""
(() => {
  const calls = [];
  const summaries = [
    { id: 'one', service: 'GitHub', username: 'example', note: '个人账号', category: '开发', deletedAt: null },
    { id: 'two', service: 'Mail', username: 'me', note: '工作邮箱', category: '工作', deletedAt: null }
  ];
  window.__dtkitCalls = calls;
  window.__TAURI__ = {
    core: { invoke: async (command, args = {}) => {
      calls.push({ command, args });
      if (command === 'get_storage_layout') return {
        root: 'D:\\DtKit', downloads: 'D:\\DtKit\\Downloads', writable: true, warning: null
      };
      if (command === 'list_passwords') return {
        items: summaries, total: summaries.length, truncated: false
      };
      if (command === 'get_password_settings') return { clipboardClearSeconds: 30 };
      if (command === 'get_shortcut_bindings') return [];
      if (command === 'replace_shortcut_bindings') return args.bindings || [];
      if (command === 'preview_password_import') return {
        token: 'preview-token', format: 'JSON v1', total: 2, ready: 2,
        duplicates: 1, invalid: 0, warnings: ['count 字段与实际条目不同'],
        items: summaries
      };
      if (command === 'commit_password_import') return { imported: 1, overwritten: 0, skipped: 1 };
      if (command === 'save_password_entry') return summaries[0];
      if (command === 'get_resource_policy') return {
        minimizeMode: 'efficient', maxConcurrentJobs: 2, quickHostRetentionSeconds: 0
      };
      if (command === 'get_cleanup_status') return {
        usage: { cacheBytes: 0, logBytes: 0, recoveryBytes: 0 },
        policy: { enabled: false, cacheRetentionDays: 7, logRetentionDays: 7 },
        latestRecoveryBatch: null
      };
      if (command === 'get_hotzone_status') return false;
      return null;
    }},
    dialog: { open: async () => 'D:\\Documents\\PassCard\\passwords_export.json' },
    event: { listen: async () => () => {} },
    window: { getCurrentWindow: () => ({ toggleMaximize: async () => {} }) }
  };
})();
"""


def run():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 820})
        page.set_default_timeout(10_000)
        page.add_init_script(MOCK_TAURI)
        page.goto("http://127.0.0.1:8769", wait_until="domcontentloaded")
        print("main loaded", flush=True)

        page.locator('[data-tool="password-vault"]').click()
        page.locator(".password-shell").wait_for(state="visible")
        print("password main visible", flush=True)
        assert not page.locator("#searchContainer").is_visible()
        page.screenshot(path="C:/tmp/dtkit-password-vault-main.png", full_page=True)
        assert page.locator(".password-result").count() == 2
        assert page.locator(".password-result").first.inner_text().startswith("G")
        assert page.locator("text=个人账号").count() == 1
        assert page.evaluate("""
          window.__dtkitCalls.some(call =>
            call.command === 'list_passwords' && call.args.limit === 200)
        """)

        first = page.locator(".password-result").first
        first.click()
        assert first.get_attribute("aria-selected") == "true"
        first.click()
        page.wait_for_function("window.__dtkitCalls.some(call => call.command === 'copy_password')")
        print("copy path verified", flush=True)

        page.locator("#passwordAdd").click()
        page.locator("#passwordEditor").wait_for(state="visible")
        page.locator("#passwordService").fill("Example")
        page.locator("#passwordValue").fill("not-rendered-in-list")
        page.locator("#passwordEditorSave").click()
        page.wait_for_function("window.__dtkitCalls.some(call => call.command === 'save_password_entry')")
        print("editor verified", flush=True)

        page.locator("#passwordImport").click()
        page.locator("#passwordImportDialog").wait_for(state="visible")
        print("import preview verified", flush=True)
        assert "2" in page.locator("#passwordImportSummary").inner_text()
        assert "重复项" in page.locator("#passwordImportSummary").inner_text()
        page.locator("#passwordImportDialog .password-dialog__close").click()

        page.locator('[data-view="settings"]').click()
        page.locator("#settingsView.view--active").wait_for(state="visible")
        print("settings visible", flush=True)
        nav_targets = page.locator(".settings-side-nav__item").evaluate_all(
            "nodes => nodes.map(node => node.getAttribute('href'))"
        )
        assert nav_targets == [
            "#storageSection", "#shortcutsSection", "#toolModulesSection", "#configSection",
            "#desktopSection", "#generalSection"
        ]

        quick = browser.new_page(viewport={"width": 760, "height": 580})
        quick.set_default_timeout(10_000)
        quick.add_init_script(MOCK_TAURI)
        quick.goto(
            "http://127.0.0.1:8769/quick.html?kind=tool&toolId=password-vault",
            wait_until="domcontentloaded",
        )
        quick.locator(".password-quick").wait_for(state="visible")
        print("quick visible", flush=True)
        quick.screenshot(path="C:/tmp/dtkit-password-vault-quick.png", full_page=True)
        assert quick.locator("#passwordAdd").count() == 0
        assert quick.locator("#passwordImport").count() == 0
        assert quick.locator(".password-result").count() == 2
        assert quick.locator(".password-result__category").count() == 0
        assert quick.evaluate("""
          window.__dtkitCalls.some(call =>
            call.command === 'list_passwords' && call.args.limit === 50)
        """)
        quick.locator("#passwordSearch").fill("#分类 开发")

        output = Path("C:/tmp/dtkit-password-vault-ui.png")
        page.screenshot(path=str(output), full_page=True)
        quick.close()
        browser.close()
        print(f"password vault UI smoke passed; screenshot={output}")


if __name__ == "__main__":
    run()
