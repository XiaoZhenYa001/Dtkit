import functools
import http.server
import os
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def local_test_url():
    configured_url = os.environ.get("DTKIT_TEST_BASE_URL")
    if configured_url:
        return configured_url, lambda: None
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(PROJECT_ROOT / "dist"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_port}", server.shutdown


BASE_URL, CLOSE_TEST_SERVER = local_test_url()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    context.set_default_timeout(10_000)
    context.add_init_script("""
        window.__appCategory = 'program';
        window.__eventListeners = {};
        localStorage.setItem('desktop_organizer_custom_categories', JSON.stringify([
            { key: 'custom_1', name: '工作', icon: '💼' }
        ]));
        localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({ enabled: true, autoAnalyze: false }));
        const desktopEntry = (name, category, isFolder = false) => ({
            name, path: `C:/Desktop/${name}`, category, is_folder: isFolder, size: 1,
            extension: '', modified_time: 0, accessed_time: 0, children: null,
            children_truncated: false, icon: null, app_id: null, app_category: null, app_manual: false
        });
        const desktopFiles = () => ({
            recent: [desktopEntry('recent.txt', 'document')], documents: [], images: [], videos: [], audios: [], archives: [], programs: [],
            applications: [{
                name: 'Steam', path: 'C:/Start Menu/Steam.lnk', category: 'program', is_folder: false,
                size: 0, extension: 'lnk', modified_time: 0, accessed_time: 0, children: null,
                children_truncated: false, icon: null, app_id: 'app-steam', app_category: window.__appCategory,
                app_manual: false
            }],
            folders: [desktopEntry('Folder', 'folder', true)], others: [desktopEntry('misc.bin', 'other')], total_count: 4
        });
        window.__TAURI__ = {
            core: { invoke: async command => {
                if (command === 'desktop_scan') return desktopFiles();
                if (command === 'desktop_list_apps') return [
                    { id: 'app-steam', name: 'Steam', path: 'C:/Start Menu/Steam.lnk', source: 'start-menu', category: '游戏', icon: null, hidden: false, manual: false },
                    { id: 'app-tool', name: 'Tool', path: 'D:/Apps/Tool.exe', source: 'manual', category: '开发', icon: null, hidden: false, manual: true }
                ];
                if (command === 'get_storage_layout') return { root: 'D:/DtKit', downloads: 'D:/DtKit/Downloads', writable: true, warning: null };
                if (command === 'get_shortcut_bindings') return [];
                if (command === 'get_cleanup_status') return { policy: { automaticEnabled: false, lastAutomaticRunAt: null }, usage: { cacheBytes: 0, logBytes: 0, recoveryBytes: 0, tempTransferBytes: 0, jobBytes: 0 }, latestRecoveryBatchId: null, running: false, cacheRetentionDays: 7, logRetentionDays: 7 };
                if (command === 'get_screen_bounds') return { x: 0, y: 0, width: 1366, height: 768, virtualWidth: 1366, virtualHeight: 768 };
                return null;
            }},
            event: { listen: async (name, callback) => {
                window.__eventListeners[name] = callback;
                return () => delete window.__eventListeners[name];
            }},
            window: { getCurrentWindow: () => ({
                innerSize: async () => ({ width: 550, height: 450 }),
                innerPosition: async () => ({ x: 800, y: 0 }),
                setSize: async () => {}, setPosition: async () => {}
            })}
        };
    """)

    organizer = context.new_page()
    organizer.goto(f"{BASE_URL}/desktop-organizer/index.html", wait_until="networkidle")
    organizer.locator('[data-category="program"] .category-header').click()
    assert organizer.locator('[data-category="program"] [data-name="Steam"]').count() == 1
    organizer.evaluate("window.__appCategory = '游戏'; window.__eventListeners['desktop-app-index-changed']()")
    game = organizer.locator('[data-category="app_category_%E6%B8%B8%E6%88%8F"] .category-header')
    game.wait_for(state="visible")
    game.click()
    assert organizer.locator('[data-category="app_category_%E6%B8%B8%E6%88%8F"] [data-name="Steam"]').count() == 1
    assert organizer.locator('[data-category="program"] [data-name="Steam"]').count() == 0
    organizer.close()

    manager = context.new_page()
    manager.goto(BASE_URL, wait_until="networkidle")
    manager.locator('[data-view="settings"]').click()
    manager.locator('.settings-side-nav__item[href="#configSection"]').click()
    manager.locator('#openDesktopAppManager').click()
    manager.locator('#appManagerList .app-manager-row').first.click()
    assert manager.locator('#appManagerCategory').input_value() == '游戏'
    manager.locator('#appManagerCategoryToggle').click()
    category_menu = manager.locator('#appManagerCategoryOptions')
    assert category_menu.is_visible()
    options = category_menu.locator('[role="option"]').evaluate_all(
        "nodes => nodes.map(node => node.dataset.categoryValue)"
    )
    assert options[0] == 'program'
    assert set(options) == {'program', '最近使用', '文件夹', '其他', '工作', '游戏', '开发'}
    category_menu.locator('[data-category-value="工作"]').click()
    assert manager.locator('#appManagerCategory').input_value() == '工作'
    manager.locator('#appManagerCategory').fill('媒体')
    assert manager.locator('#appManagerCategory').input_value() == '媒体'
    manager.close()
    context.close()
    browser.close()

CLOSE_TEST_SERVER()
print('desktop application category UI passed')
