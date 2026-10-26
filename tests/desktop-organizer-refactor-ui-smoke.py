import functools
import http.server
import os
import threading
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright


SCREENSHOTS = Path(tempfile.mkdtemp(prefix="dtkit-desktop-classic-"))
ORGANIZER_SCREENSHOT = SCREENSHOTS / "organizer.png"
SHORTCUT_SCREENSHOT = SCREENSHOTS / "shortcuts.png"
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def local_test_url():
    configured_url = os.environ.get("DTKIT_TEST_BASE_URL")
    if configured_url:
        return configured_url, lambda: None
    dist = PROJECT_ROOT / "dist"
    if not dist.is_dir():
        raise RuntimeError("dist 不存在，请先运行 npm run build")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(dist))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def close_server():
        server.shutdown()
        server.server_close()

    return f"http://127.0.0.1:{server.server_port}", close_server


BASE_URL, CLOSE_TEST_SERVER = local_test_url()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    context.add_init_script("""
        const desktopPath = name => ['C:', 'Users', 'demo', 'Desktop', name].join('\\\\');
        const file = (name, category, folder = false, size = 1024) => ({
            name, path: desktopPath(name), category, is_folder: folder,
            size, extension: folder ? '' : name.split('.').pop(), modified_time: 1,
            accessed_time: 2, children: folder ? [{ name: 'brief.md', path: desktopPath(`${name}/brief.md`),
                category: 'document', is_folder: false, size: 512, extension: 'md', modified_time: 1,
                accessed_time: 1, children: null, children_truncated: false, icon: null }] : null,
            children_truncated: folder, icon: null
        });
        const cached = file('cached-notes.txt', 'document', false, 2048);
        localStorage.setItem('dtkit_desktop_snapshot_v1', JSON.stringify({
            version: 3,
            capturedAt: Date.now(),
            files: { recent: [cached], documents: [cached], images: [], videos: [], audios: [],
                archives: [], programs: [], applications: [], folders: [], others: [], total_count: 1 }
        }));
        window.__bindings = [];
        window.__calls = [];
        window.__documentName = 'roadmap.pdf';
        const originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            if (window.__failClassicPreferences && key === 'dtkit_desktop_classic_categories_v1') throw new Error('mock quota exceeded');
            return originalSetItem.call(this, key, value);
        };
        window.__TAURI__ = {
            core: { invoke: async (command, args = {}) => {
                window.__calls.push({ command, args });
                if (command === 'take_missed_alarm_triggers') return [];
                if (command === 'get_shortcut_bindings') return window.__bindings;
                if (command === 'upsert_shortcut_binding') { window.__bindings = window.__bindings.filter(item => JSON.stringify(item.target) !== JSON.stringify(args.binding.target)); window.__bindings.push(args.binding); return window.__bindings; }
                if (command === 'remove_shortcut_binding') { window.__bindings = window.__bindings.filter(item => JSON.stringify(item.target) !== JSON.stringify(args.target)); return window.__bindings; }
                if (command === 'replace_shortcut_bindings') { window.__bindings = args.bindings; return window.__bindings; }
                if (command === 'set_desktop_organizer_mode' && args.enabled && args.presentation === 'space') {
                    if (!window.__bindings.some(item => item.target.kind === 'desktopSpace')) window.__bindings.push({accelerator:'Ctrl+Alt+D',target:{kind:'desktopSpace'},enabled:true});
                    return null;
                }
                if (command === 'desktop_scan') {
                    const doc = file(window.__documentName, 'document', false, 245760);
                    const image = file('design.png', 'image', false, 1048576);
                    const folder = file('Current Project', 'folder', true, 0);
                    const manualApp = file('Pinned Tool', 'program', false, 0);
                    manualApp.path = 'C:/Tools/pinned-tool.exe';
                    manualApp.app_id = 'app-pinned-tool';
                    manualApp.app_manual = true;
                    manualApp.app_category = 'program';
                    return new Promise(resolve => {
                        window.__resolveDesktopScan = () => resolve({
                            recent: [doc, image], documents: [doc], images: [image], videos: [], audios: [],
                            archives: [], programs: [], applications: [manualApp], folders: [folder], others: [], total_count: 3
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
                if (command === 'desktop_rename_file') {
                    window.__documentName = args.newName;
                    return desktopPath(args.newName);
                }
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
    dialogs = []
    organizer = context.new_page()
    organizer.set_viewport_size({"width": 550, "height": 450})
    organizer.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    organizer.on("pageerror", lambda error: errors.append(str(error)))
    organizer.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
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
    assert organizer.locator('[data-category="document"] .file-item').count() == 0
    assert organizer.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")

    organizer.locator('[data-category="managed-apps"] .category-header').click()
    assert organizer.locator('[data-category="managed-apps"] [data-name="Pinned Tool"]').count() == 1

    recent_items = organizer.locator('[data-category="recent"] .file-item')
    assert recent_items.first.evaluate("node => node.tagName") == "BUTTON"
    recent_items.first.focus()
    recent_items.first.press("ArrowDown")
    active_name = organizer.evaluate("document.activeElement?.dataset?.name || document.activeElement?.tagName")
    assert recent_items.nth(1).evaluate("node => node === document.activeElement"), active_name
    recent_items.first.focus()
    recent_items.first.press("Enter")
    open_calls = organizer.evaluate("window.__calls.filter(call => call.command.includes('open'))")
    assert organizer.evaluate("window.__calls.some(call => call.command === 'desktop_open_file' && call.args.path.endsWith('roadmap.pdf'))"), open_calls

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
    assert not organizer.evaluate("window.__calls.some(call => call.command === 'desktop_search')")
    organizer.locator("#searchInput").fill("/d")
    organizer.wait_for_function("document.querySelectorAll('#searchResultsList .file-item').length === 1")
    assert "roadmap.pdf" in organizer.locator("#searchResultsList").inner_text()
    organizer.locator("#searchClear").click()
    organizer.locator('[data-name="roadmap.pdf"]').first.click(button="right")
    assert organizer.locator("#contextMenu").is_visible()
    organizer.locator('#contextMenu [data-action="rename"]').click()
    assert organizer.locator("#renameDialog").is_visible()
    organizer.locator("#renameCancelBtn").click()
    organizer.locator("#renameDialog").wait_for(state="hidden")

    # Native rename success must survive malformed or unwritable UI metadata.
    organizer.evaluate("localStorage.setItem('dtkit_desktop_space_v2', '{broken')")
    organizer.locator('[data-name="roadmap.pdf"]').first.click(button="right")
    organizer.locator('#contextMenu [data-action="rename"]').click()
    organizer.locator('#renameInput').fill('renamed.pdf')
    organizer.locator('#renameConfirmBtn').click()
    organizer.wait_for_function("window.__calls.filter(call => call.command === 'desktop_scan').length === 2")
    organizer.evaluate('window.__resolveDesktopScan()')
    organizer.wait_for_function("document.querySelector('[data-name=\"renamed.pdf\"]') !== null")
    organizer.wait_for_function("document.querySelector('#statusText').textContent.startsWith('文件已重命名，固定/排序设置同步失败')")
    assert organizer.evaluate("localStorage.getItem('dtkit_desktop_space_v2')") == '{broken'
    assert organizer.locator('#categoryList .file-item[data-name="roadmap.pdf"]').count() == 0
    assert not dialogs, dialogs
    organizer.locator('#renameDialog').wait_for(state='hidden')

    organizer.evaluate("""() => {
        const path = window.__calls.find(call => call.command === 'desktop_rename_file').args.oldPath.replace('roadmap.pdf', 'renamed.pdf');
        localStorage.setItem('dtkit_desktop_space_v2', JSON.stringify({version:2,pinned:[{path,name:'renamed.pdf',category:'document',is_folder:false}],orders:{root:[]}}));
        window.__failClassicPreferences = true;
    }""")
    organizer.locator('[data-name="renamed.pdf"]').first.click(button='right')
    organizer.locator('#contextMenu [data-action="rename"]').click()
    organizer.locator('#renameInput').fill('final.pdf')
    organizer.locator('#renameConfirmBtn').click()
    organizer.wait_for_function("window.__calls.filter(call => call.command === 'desktop_scan').length === 3")
    organizer.evaluate('window.__resolveDesktopScan()')
    organizer.wait_for_function("document.querySelector('[data-name=\"final.pdf\"]') !== null")
    organizer.wait_for_function("document.querySelector('#statusText').textContent.includes('mock quota exceeded')")
    saved_pin = organizer.evaluate("JSON.parse(localStorage.getItem('dtkit_desktop_space_v2')).pinned[0]")
    assert saved_pin['path'].endswith('final.pdf') and saved_pin['name'] == 'final.pdf', saved_pin
    assert not dialogs, dialogs
    organizer.evaluate('window.__failClassicPreferences = false')
    # A parseable but unsupported schema must be preserved just like bad JSON.
    future_preferences = '{"version":3,"pinned":[{"name":"KEEP FUTURE METADATA"}],"orders":{}}'
    organizer.evaluate("value => localStorage.setItem('dtkit_desktop_space_v2', value)", future_preferences)
    scans_before = organizer.evaluate("window.__calls.filter(call => call.command === 'desktop_scan').length")
    organizer.locator('[data-name="final.pdf"]').first.click(button='right')
    organizer.locator('#contextMenu [data-action="rename"]').click()
    organizer.locator('#renameInput').fill('schema-protected.pdf')
    organizer.locator('#renameConfirmBtn').click()
    organizer.wait_for_function("count => window.__calls.filter(call => call.command === 'desktop_scan').length > count", arg=scans_before)
    organizer.evaluate('window.__resolveDesktopScan()')
    organizer.wait_for_function("document.querySelector('[data-name=\"schema-protected.pdf\"]') !== null")
    organizer.wait_for_function("document.querySelector('#statusText').textContent.includes('格式或版本无效')")
    assert organizer.evaluate("localStorage.getItem('dtkit_desktop_space_v2')") == future_preferences
    assert not dialogs, dialogs
    assert not errors, errors
    organizer.close()

    app_errors = []
    app = context.new_page()
    app.set_viewport_size({"width": 1280, "height": 850})
    app.on("console", lambda message: app_errors.append(message.text) if message.type == "error" else None)
    app.on("pageerror", lambda error: app_errors.append(str(error)))
    app.goto(BASE_URL, wait_until="networkidle")
    app.locator('[data-tool-id="timestamp-converter"]').click()
    app.locator('[data-tool-page-toggle]').click()
    shortcut = app.locator(".tool-page-shortcut .shortcut-binding__record")
    shortcut.wait_for(state="visible")
    assert "专属快捷键" in app.locator(".tool-page-shortcut").inner_text()
    shortcut.click()
    app.keyboard.press("Control+Alt+T")
    app.wait_for_function("window.__bindings.some(item => item.target.toolId === 'timestamp-converter')")
    assert "Ctrl" in shortcut.inner_text()
    app.screenshot(path=str(SHORTCUT_SCREENSHOT), full_page=True)
    app.locator('[data-view="settings"]').click()
    app.locator("#shortcutBindings .shortcut-binding").first.wait_for(state="visible")
    assert app.locator("#shortcutBindings .shortcut-binding").count() == 2
    assert "万能命令面板" in app.locator("#shortcutBindings").inner_text()
    app.locator('[data-organizer-presentation="space"]').check()
    app.locator('#desktopOrganizerToggle').check()
    app.locator('#confirmDesktopOrganizer').click()
    space_shortcut = app.locator('#desktopSpaceShortcut .shortcut-binding__record')
    space_shortcut.filter(has_text='D').wait_for()
    assert app.locator('[data-organizer-layout],[data-organizer-appearance]').count() == 0
    app.locator('#openDesktopSpace').click()
    app.wait_for_function("window.__calls.some(call => call.command === 'desktop_space_show')")
    space_shortcut.click()
    app.keyboard.press('Control+Alt+D')
    app.wait_for_function("window.__bindings.some(item => item.target.kind === 'desktopSpace' && item.accelerator === 'Ctrl+Alt+D')")
    assert app.evaluate("window.__bindings.some(item => item.target.toolId === 'timestamp-converter')")
    app.locator('#shortcutBindings button[aria-label="设置“桌面空间”的快捷键"]').filter(has_text='D').wait_for()
    assert not app_errors, app_errors
    app.close()
    context.close()
    browser.close()

CLOSE_TEST_SERVER()
print(f"desktop organizer + tool shortcut UI passed; screenshots={ORGANIZER_SCREENSHOT}, {SHORTCUT_SCREENSHOT}")
