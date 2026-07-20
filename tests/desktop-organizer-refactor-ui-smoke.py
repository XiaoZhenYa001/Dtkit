import os
from pathlib import Path
from playwright.sync_api import sync_playwright


ORGANIZER_SCREENSHOT = Path(r"C:\tmp\dtkit-desktop-organizer-refactor.png")
SHORTCUT_SCREENSHOT = Path(r"C:\tmp\dtkit-tool-shortcut.png")
BASE_URL = os.environ.get("DTKIT_TEST_BASE_URL", "http://127.0.0.1:4182")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    context.add_init_script("""
        const file = (name, category, folder = false, size = 1024) => ({
            name, path: `C:\\Users\\demo\\Desktop\\${name}`, category, is_folder: folder,
            size, extension: folder ? '' : name.split('.').pop(), modified_time: 1,
            accessed_time: 2, children: folder ? [{ name: 'brief.md', path: `C:\\Users\\demo\\Desktop\\${name}\\brief.md`,
                category: 'document', is_folder: false, size: 512, extension: 'md', modified_time: 1,
                accessed_time: 1, children: null, children_truncated: false, icon: null }] : null,
            children_truncated: folder, icon: null
        });
        const cached = file('cached-notes.txt', 'document', false, 2048);
        localStorage.setItem('dtkit_desktop_snapshot_v1', JSON.stringify({
            version: 1,
            capturedAt: Date.now(),
            files: { recent: [cached], documents: [cached], images: [], videos: [], audios: [],
                archives: [], programs: [], folders: [], others: [], total_count: 1 }
        }));
        window.__bindings = [];
        window.__calls = [];
        window.__TAURI__ = {
            core: { invoke: async (command, args = {}) => {
                window.__calls.push({ command, args });
                if (command === 'take_missed_alarm_triggers') return [];
                if (command === 'get_shortcut_bindings') return window.__bindings;
                if (command === 'replace_shortcut_bindings') { window.__bindings = args.bindings; return window.__bindings; }
                if (command === 'desktop_scan') {
                    const doc = file('roadmap.pdf', 'document', false, 245760);
                    const image = file('design.png', 'image', false, 1048576);
                    const folder = file('Current Project', 'folder', true, 0);
                    return new Promise(resolve => {
                        window.__resolveDesktopScan = () => resolve({
                            recent: [doc, image], documents: [doc], images: [image], videos: [], audios: [],
                            archives: [], programs: [], folders: [folder], others: [], total_count: 3
                        });
                    });
                }
                if (command === 'desktop_list_folder') {
                    const child = file('brief.md', 'document', false, 512);
                    child.path = `${args.path}/brief.md`;
                    const nested = file('Reference', 'folder', true, 0);
                    nested.path = `${args.path}/Reference`;
                    nested.children = null;
                    nested.children_truncated = false;
                    return { path: args.path, name: args.path.split(/[\\/]/).pop(), items: [nested, child], total_count: 2, truncated: false };
                }
                if (command === 'desktop_search') return [file('roadmap.pdf', 'document', false, 245760)];
                if (command === 'get_screen_bounds') return { x: 0, y: 0, width: 1366, height: 768, virtualWidth: 1366, virtualHeight: 768 };
                return null;
            }},
            window: { getCurrentWindow: () => ({
                innerSize: async () => ({ width: 550, height: 450 }), innerPosition: async () => ({ x: 1350, y: 10 }),
                setSize: async () => {}, setPosition: async () => {}
            })}
        };
    """)

    errors = []
    organizer = context.new_page()
    organizer.set_viewport_size({"width": 550, "height": 450})
    organizer.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    organizer.on("pageerror", lambda error: errors.append(str(error)))
    organizer.goto(f"{BASE_URL}/desktop-organizer/index.html", wait_until="networkidle")
    organizer.wait_for_function("document.querySelector('[data-name=\"cached-notes.txt\"]') !== null")
    assert organizer.locator('[data-name="cached-notes.txt"]').count() >= 1
    organizer.evaluate("window.__resolveDesktopScan()")
    organizer.wait_for_function("document.querySelectorAll('.category-item').length >= 3")
    organizer.wait_for_function("document.querySelector('[data-name=\"roadmap.pdf\"]') !== null")
    assert organizer.locator('[data-name="cached-notes.txt"]').count() == 0
    assert organizer.evaluate("window.__calls.some(call => call.command === 'clamp_desktop_organizer_window')")
    assert organizer.locator(".organizer-brand h1").text_content() == "桌面整理"
    assert "共 3 个项目" in organizer.locator("#statusText").text_content()
    assert organizer.locator(".category-item").count() >= 3
    assert organizer.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")

    organizer.locator('[data-category="folder"] .category-header').click()
    organizer.locator('[data-name="Current Project"]').click()
    organizer.locator(".folder-browser").wait_for(state="visible")
    assert "brief.md" in organizer.locator(".folder-browser__list").inner_text()
    assert "Reference" in organizer.locator(".folder-browser__list").inner_text()
    assert organizer.locator(".folder-children").count() == 0
    assert organizer.evaluate("window.__calls.some(call => call.command === 'desktop_list_folder')")
    assert organizer.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    organizer.screenshot(path=str(ORGANIZER_SCREENSHOT))
    organizer.locator("[data-folder-back]").click()
    assert organizer.locator(".folder-browser").count() == 0
    assert organizer.locator('[data-name="Current Project"]').count() == 1

    organizer.locator("#searchInput").fill("road")
    organizer.wait_for_function("document.querySelectorAll('#searchResultsList .file-item').length === 1")
    assert "roadmap.pdf" in organizer.locator("#searchResultsList").inner_text()
    organizer.locator("#searchClear").click()
    organizer.locator(".file-item").first.click(button="right")
    assert organizer.locator("#contextMenu").is_visible()
    organizer.locator('#contextMenu [data-action="rename"]').click()
    assert organizer.locator("#renameDialog").is_visible()
    organizer.locator("#renameCancelBtn").click()
    assert not errors, errors
    organizer.close()

    app_errors = []
    app = context.new_page()
    app.set_viewport_size({"width": 1280, "height": 850})
    app.on("console", lambda message: app_errors.append(message.text) if message.type == "error" else None)
    app.on("pageerror", lambda error: app_errors.append(str(error)))
    app.goto(BASE_URL, wait_until="networkidle")
    app.locator('[data-tool-id="timestamp-converter"]').click()
    shortcut = app.locator(".tool-shortcut-slot .shortcut-binding__record")
    shortcut.wait_for(state="visible")
    assert "专属快捷键" in app.locator(".tool-shortcut-slot").inner_text()
    shortcut.click()
    app.keyboard.press("Control+Alt+T")
    app.wait_for_function("window.__bindings.some(item => item.target.toolId === 'timestamp-converter')")
    assert "Ctrl" in shortcut.inner_text()
    app.screenshot(path=str(SHORTCUT_SCREENSHOT), full_page=True)
    app.locator('[data-view="settings"]').click()
    app.locator("#shortcutBindings .shortcut-binding").wait_for(state="visible")
    assert app.locator("#shortcutBindings .shortcut-binding").count() == 1
    assert "万能命令面板" in app.locator("#shortcutBindings").inner_text()
    assert not app_errors, app_errors
    app.close()
    context.close()
    browser.close()

print(f"desktop organizer + tool shortcut UI passed; screenshots={ORGANIZER_SCREENSHOT}, {SHORTCUT_SCREENSHOT}")
