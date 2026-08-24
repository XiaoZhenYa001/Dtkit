import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("DTKIT_TEST_BASE_URL", "http://127.0.0.1:4173")
ARTIFACTS = Path(os.environ.get("DTKIT_TEST_ARTIFACTS", r"C:\tmp\dtkit-system-assistant"))


MOCK_TAURI = """
(() => {
  const items = [
    { id: 'one', name: 'Cloud Sync', command: '\"C:\\\\Apps\\\\Cloud.exe\" --background', targetPath: 'C:\\\\Apps\\\\Cloud.exe', sourceKind: 'registry', sourceLabel: '当前用户 · 注册表 Run', sourceDetail: 'Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run', scope: 'user', enabled: true, canToggle: true, requiresElevation: false },
    { id: 'two', name: 'Updater Service', command: 'C:\\\\Program Files\\\\Updater\\\\update.exe', targetPath: null, sourceKind: 'registry', sourceLabel: '所有用户 · 64 位 Run', sourceDetail: 'Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run', scope: 'system', enabled: true, canToggle: true, requiresElevation: true },
    { id: 'three', name: 'Workspace Helper', command: 'C:\\\\Users\\\\Demo\\\\Startup\\\\Workspace.lnk', targetPath: 'C:\\\\Users\\\\Demo\\\\Startup\\\\Workspace.lnk.dtkit-disabled', sourceKind: 'startupFolder', sourceLabel: '当前用户 · 启动文件夹', sourceDetail: 'C:\\\\Users\\\\Demo\\\\Startup', scope: 'user', enabled: false, canToggle: true, requiresElevation: false }
  ];
  const snapshot = () => ({
    items: items.map(item => ({ ...item })),
    total: items.length,
    enabled: items.filter(item => item.enabled).length,
    disabled: items.filter(item => !item.enabled).length,
    userItems: items.filter(item => item.scope === 'user').length,
    systemItems: items.filter(item => item.scope === 'system').length,
    scannedAt: Date.now(), warnings: []
  });
  window.__TAURI__ = {
    core: { invoke: async (command, args = {}) => {
      if (command === 'scan_system_startup_items') return snapshot();
      if (command === 'set_system_startup_enabled') {
        const item = items.find(entry => entry.id === args.id);
        if (item) item.enabled = args.enabled;
        return snapshot();
      }
      if (command === 'get_tool_module_settings') return [];
      if (command === 'get_shortcut_bindings') return [];
      if (command === 'take_missed_alarm_triggers') return [];
      if (command === 'sync_alarm_tasks') return [];
      if (command === 'reveal_system_startup_item') return null;
      return null;
    }},
    event: { listen: async () => () => {} },
    window: { getCurrentWindow: () => ({ label: 'main', startDragging: async () => {}, isMaximized: async () => false }) }
  };
})();
"""


def no_horizontal_overflow(page, selector):
    sizes = page.locator(selector).evaluate("node => ({ scroll: node.scrollWidth, client: node.clientWidth })")
    if sizes["scroll"] > sizes["client"] + 1:
        raise AssertionError(f"Horizontal overflow in {selector}: {sizes}")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)

    page = browser.new_page(viewport={"width": 1440, "height": 920})
    errors = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.on("console", lambda message: errors.append(f"console.error: {message.text}") if message.type == "error" else None)
    page.add_init_script(MOCK_TAURI)
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-tool-id="system-assistant"]').click()
    page.locator(".system-assistant-shell").wait_for(state="visible")
    expect(page.locator("#systemOverviewTotal")).to_have_text("3")
    page.locator('[data-open-system-module="startup"]').click()
    expect(page.locator("#systemStartupList .system-startup-row")).to_have_count(3)
    page.locator("#systemStartupSearch").fill("workspace")
    expect(page.locator("#systemStartupList .system-startup-row")).to_have_count(1)
    page.locator("#systemStartupSearch").fill("")
    page.locator("#systemScopeFilter").select_option("system")
    expect(page.locator("#systemStartupList .system-startup-row")).to_have_count(1)
    page.locator("#systemScopeFilter").select_option("all")
    page.locator('[data-startup-id="three"] .system-toggle').click()
    expect(page.locator('[data-startup-id="three"] .system-toggle')).to_have_attribute("aria-checked", "true")
    no_horizontal_overflow(page, ".system-assistant-shell")
    page.screenshot(path=str(ARTIFACTS / "desktop.png"), full_page=True)

    page.set_viewport_size({"width": 760, "height": 860})
    no_horizontal_overflow(page, ".system-assistant-shell")
    page.screenshot(path=str(ARTIFACTS / "narrow.png"), full_page=True)

    quick = browser.new_page(viewport={"width": 760, "height": 580})
    quick_errors = []
    quick.on("pageerror", lambda error: quick_errors.append(f"pageerror: {error}"))
    quick.on("console", lambda message: quick_errors.append(f"console.error: {message.text}") if message.type == "error" else None)
    quick.add_init_script(MOCK_TAURI)
    quick.goto(f"{BASE_URL}/quick.html?kind=tool&toolId=system-assistant", wait_until="networkidle")
    quick.locator(".system-assistant-shell").wait_for(state="visible")
    expect(quick.locator("#systemOverviewTotal")).to_have_text("3")
    no_horizontal_overflow(quick, ".system-assistant-shell")
    quick.screenshot(path=str(ARTIFACTS / "quick.png"), full_page=True)

    if errors or quick_errors:
        raise AssertionError("Runtime errors:\n" + "\n".join(errors + quick_errors))
    quick.close()
    browser.close()

print("System assistant UI smoke test passed")
