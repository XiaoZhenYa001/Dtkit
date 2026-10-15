"""Exercise desktop presentation choices through the real DOM and native HTML drag.

Run after npm run build. DTKIT_TEST_BASE_URL can point at an existing preview;
otherwise this test serves dist on an isolated ephemeral port. Tauri commands are
mocked and all browser storage stays in a disposable Playwright context.
"""

import functools
import http.server
import json
import os
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = Path(tempfile.mkdtemp(prefix="dtkit-desktop-presentation-"))


def local_test_url():
    configured = os.environ.get("DTKIT_TEST_BASE_URL")
    if configured:
        return configured.rstrip("/"), lambda: None
    dist = PROJECT_ROOT / "dist"
    if not dist.is_dir():
        raise RuntimeError("dist is missing; run npm run build first")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(dist))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def close():
        server.shutdown()
        server.server_close()

    return f"http://127.0.0.1:{server.server_port}", close


MOCK_TAURI = r"""
(() => {
    // Playwright installs this script in child documents as well. User HTML
    // previews intentionally have an opaque sandbox origin and cannot use
    // storage or the native bridge; only skip our mock in those documents.
    window.__dtkitMockScope = {url: location.href, origin: location.origin, topLevel: window === window.top};
    let testStorage;
    try {
        testStorage = window.localStorage;
        testStorage.getItem('dtkit_desktop_organizer');
        window.__dtkitMockScope.storageAvailable = true;
    } catch (error) {
        window.__dtkitMockScope.storageAvailable = false;
        window.__dtkitMockScope.reason = error.message;
        return;
    }
    const entry = (name, category, folder = false) => ({
        name, path: `C:/Desktop/${name}`, category, is_folder: folder,
        size: folder ? 0 : 1024, extension: folder ? '' : name.split('.').pop(),
        modified_time: 1, accessed_time: 2, children: null,
        children_truncated: false, icon: null, app_id: null, app_category: null,
        app_manual: false
    });
    const docs = Array.from({length: 10}, (_, index) => entry(`doc-${index + 1}.txt`, 'document'));
    const images = Array.from({length: 4}, (_, index) => entry(`image-${index + 1}.png`, 'image'));
    const folder = entry('Project Folder', 'folder', true);
    const application = {...entry('Real Tool', 'program'), path: 'C:/Tools/real-tool.exe',
        app_id: 'real-tool', app_category: 'program', app_manual: true};
    const files = {recent: [docs[0], images[0]], documents: docs, images, videos: [],
        audios: [], archives: [], programs: [], applications: [application],
        folders: [folder], others: [], total_count: 16};
    if (!testStorage.getItem('dtkit_desktop_organizer')) {
        testStorage.setItem('dtkit_desktop_organizer', JSON.stringify({enabled: true, autoAnalyze: false}));
    }
    if (!testStorage.getItem('desktop_organizer_custom_categories')) {
        testStorage.setItem('desktop_organizer_custom_categories', JSON.stringify([
            {key: 'custom_1', name: 'Working', icon: '💼'}
        ]));
    }
    window.__calls = [];
    window.__nativeGeometry = [];
    window.__eventListeners = {};
    const channel = new BroadcastChannel('dtkit-desktop-presentation-smoke');
    const dispatch = (name, payload) => {
        for (const callback of window.__eventListeners[name] || []) callback({event: name, payload});
    };
    channel.onmessage = event => dispatch(event.data.name, event.data.payload);
    window.__TAURI__ = {
        core: {invoke: async (command, args = {}) => {
            window.__calls.push({command, args});
            if (command === 'desktop_scan') return structuredClone(files);
            if (command === 'desktop_get_app_icon') return null;
            if (command === 'desktop_list_folder') {
                const child = {...entry('brief.md', 'document'), path: `${args.path}/brief.md`};
                return {path: args.path, name: 'Project Folder', items: [child], total_count: 1, truncated: false};
            }
            if (command === 'get_screen_bounds') return {x: 0, y: 0, width: 1366, height: 768,
                virtualWidth: 1366, virtualHeight: 768};
            if (command === 'get_storage_layout') return {root: 'D:/DtKit-Test', downloads: 'D:/DtKit-Test/Downloads', writable: true, warning: null};
            if (command === 'get_shortcut_bindings' || command === 'take_missed_alarm_triggers') return [];
            if (command === 'get_cleanup_status') return {policy: {automaticEnabled: false, lastAutomaticRunAt: null},
                usage: {cacheBytes: 0, logBytes: 0, recoveryBytes: 0, tempTransferBytes: 0, jobBytes: 0},
                latestRecoveryBatchId: null, running: false, cacheRetentionDays: 7, logRetentionDays: 7};
            return null;
        }},
        event: {
            listen: async (name, callback) => {
                (window.__eventListeners[name] ||= []).push(callback);
                return () => {window.__eventListeners[name] = window.__eventListeners[name].filter(item => item !== callback);};
            },
            emit: async (name, payload) => {dispatch(name, payload); channel.postMessage({name, payload});},
            emitTo: async (target, name, payload) => {dispatch(name, payload); channel.postMessage({name, payload});}
        },
        window: {getCurrentWindow: () => ({
            label: location.pathname.includes('desktop-organizer') ? 'desktop-organizer' : 'main',
            innerSize: async () => ({width: 550, height: 450}),
            innerPosition: async () => ({x: 800, y: 12}),
            setSize: async value => {window.__nativeGeometry.push({type: 'size', value});},
            setPosition: async value => {window.__nativeGeometry.push({type: 'position', value});},
            isVisible: async () => true,
            onFocusChanged: async () => () => {}, onResized: async () => () => {}
        })}
    };
})();
"""


def settle(page):
    page.wait_for_function("document.querySelectorAll('[data-presentation-ghost]').length === 0")
    page.wait_for_timeout(40)
    assert page.evaluate("""() => {
        const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
        return ids.length === new Set(ids).size;
    }"""), "A transition left duplicate element IDs"


def choose(page, kind, value):
    panel = page.locator("#appearancePanel")
    if not panel.is_visible():
        open_tools(page)
        page.locator("#appearanceBtn").click()
    page.locator(f'[data-{kind}-choice="{value}"]').click()


def open_tools(page):
    dial=page.locator('#desktopToolsToggle')
    if dial.count() and dial.is_visible() and dial.get_attribute('aria-expanded')!='true':
        dial.click()
        page.wait_for_timeout(370)


def grid_order(grid):
    return grid.locator("[data-space-id]").evaluate_all("nodes => nodes.map(node => node.dataset.spaceId)")


def assert_native_interacting(page, active):
    page.wait_for_function("""active => {
        const call = window.__calls.filter(item => item.command === 'set_user_interacting').at(-1);
        return window.__userInteracting === active && call?.args.interacting === active;
    }""", arg=active)


def native_drag(page, source, target, release_delay=40):
    """Retain node identity and physical slots, including an unfinished hover FLIP."""
    source.scroll_into_view_if_needed()
    start, end = source.bounding_box(), target.bounding_box()
    assert start and end
    page.evaluate("""() => {
        window.__dropAudit = null;
        const capture = event => {
            const placeholder = document.querySelector('.space-drop-placeholder');
            if (!placeholder) return;
            const grid = placeholder.parentElement;
            const neighbors = [...document.querySelectorAll('.space-file[data-space-id]')]
                .filter(node => !node.classList.contains('is-drag-source'))
                .map(node => ({node, id: node.dataset.spaceId, x: node.offsetLeft, y: node.offsetTop}));
            const slot = {x: placeholder.offsetLeft, y: placeholder.offsetTop};
            const beforeId = placeholder.nextElementSibling?.dataset.spaceId || null;
            const targetKey = grid.dataset.spaceDrop;
            const scroll = grid.scrollTop;
            setTimeout(() => {
                const source = grid.querySelector('.space-file.selected[data-space-id]');
                window.__dropAudit = {
                    targetKey, beforeId,
                    moved: source?.dataset.spaceId,
                    sameNeighbors: neighbors.every(item => item.node.isConnected),
                    stableSlots: neighbors.every(item => item.node.offsetLeft === item.x && item.node.offsetTop === item.y),
                    filledSlot: !!source && source.offsetLeft === slot.x && source.offsetTop === slot.y,
                    stableScroll: grid.scrollTop === scroll
                };
            }, 80);
        };
        document.addEventListener('drop', capture, {capture: true, once: true});
    }""")
    page.mouse.move(start["x"] + start["width"] / 2, start["y"] + start["height"] / 2)
    page.mouse.down()
    page.mouse.move(start["x"] + start["width"] / 2 + 12, start["y"] + start["height"] / 2 + 9, steps=5)
    page.mouse.move(end["x"] + end["width"] / 2, end["y"] + end["height"] / 2, steps=16)
    page.mouse.move(end["x"] + end["width"] / 2 + 1, end["y"] + end["height"] / 2, steps=2)
    page.locator(".space-drop-placeholder").wait_for(state="visible")
    assert_native_interacting(page, True)
    if release_delay:
        page.wait_for_timeout(release_delay)
    page.mouse.up()
    page.wait_for_function("window.__dropAudit !== null")
    audit = page.evaluate("window.__dropAudit")
    assert audit["sameNeighbors"] and audit["stableSlots"] and audit["filledSlot"] and audit["stableScroll"], audit
    assert page.locator(".space-drop-placeholder,.space-dragging,.is-drag-source").count() == 0
    assert_native_interacting(page, False)
    assert "已调整文件顺序" not in page.locator("body").inner_text()
    return audit


@contextmanager
def capture_failures(pages, errors, console_errors):
    try:
        yield
    except Exception as error:
        diagnostics = {"failure": str(error), "pageErrors": errors, "consoleErrors": console_errors, "pages": []}
        for index, page in enumerate(pages):
            detail = {"url": page.url}
            try:
                page.screenshot(path=str(SCREENSHOTS / f"failure-{index}.png"), timeout=3000)
                detail["body"] = page.locator("body").inner_text(timeout=1500)
                detail["frames"] = []
                for frame in page.frames:
                    try:
                        detail["frames"].append({"url": frame.url, "mockScope": frame.evaluate("window.__dtkitMockScope || null")})
                    except Exception as frame_error:
                        detail["frames"].append({"url": frame.url, "captureError": str(frame_error)})
            except Exception as capture_error:
                detail["captureError"] = str(capture_error)
            diagnostics["pages"].append(detail)
        (SCREENSHOTS / "failure.json").write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Desktop presentation UI failure diagnostics: {SCREENSHOTS}", flush=True)
        raise


def main():
    """Each native host owns one presentation; settings hands off their lifetimes."""
    base, close_server = local_test_url()
    pages, errors, console_errors = [], [], []
    try:
        with sync_playwright() as playwright, capture_failures(pages, errors, console_errors):
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 550, "height": 450})
            context.set_default_timeout(10_000)
            context.add_init_script(MOCK_TAURI + r"""
            if (window.__dtkitMockScope?.storageAvailable && !localStorage.getItem('__dtkitDualHostSeeded')) {
                // A stale classic window may initialize while space is selected.
                localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({
                    enabled: true, presentation: 'space', layout: 'islands', appearance: 'warm', reducedMotion: false
                }));
                localStorage.setItem('__dtkitDualHostSeeded', 'true');
            }
            """)

            def observe(page):
                pages.append(page)
                page.on("pageerror", lambda error: errors.append({"url": page.url, "message": str(error), "stack": getattr(error, "stack", "")}))
                page.on("console", lambda message: console_errors.append({"url": page.url, "text": message.text}) if message.type == "error" else None)

            context.on("page", observe)

            def desktop_page():
                page = context.new_page()
                page.set_viewport_size({"width": 1440, "height": 900})
                page.goto(f"{base}/desktop-organizer/index.html?host=desktop", wait_until="networkidle")
                page.wait_for_function("() => window.__calls.some(call => call.command === 'desktop_space_set_regions')")
                page.wait_for_function("() => Number(getComputedStyle(document.querySelector('#panel')).opacity) === 1")
                expect(page.locator("#desktopSpaceView")).to_be_visible()
                expect(page.locator("#categoryList")).to_be_hidden()
                expect(page.locator(".organizer-header")).to_be_hidden()
                assert not page.evaluate("window.__nativeGeometry")
                return page

            def assert_classic(page):
                expect(page.locator("body")).to_have_attribute("data-presentation", "classic")
                expect(page.locator("#desktopSpaceView")).to_be_hidden()
                expect(page.locator("#desktopTools")).to_be_hidden()
                expect(page.locator(".organizer-header")).to_be_visible()

            def settings_choice(kind, value):
                settings.locator(f'[data-organizer-{kind}="{value}"]').locator("xpath=..").click()
                settings.wait_for_function("""({kind,value}) => JSON.parse(localStorage.getItem('dtkit_desktop_organizer'))[kind] === value""", arg={"kind": kind, "value": value})
                if kind == "presentation":
                    settings.wait_for_function("""value => window.__calls.filter(call => call.command === 'set_desktop_organizer_mode').at(-1)?.args.presentation === value""", arg=value)

            def retire_desktop(page):
                # Native retirement is mocked only at the lifetime boundary;
                # production DOM handlers perform the fade and disable input.
                page.evaluate("() => window.__TAURI__.event.emit('desktop-space-hiding', null)")
                page.wait_for_function("() => document.querySelector('#panel').inert && Number(getComputedStyle(document.querySelector('#panel')).opacity) === 0")
                expect(page.locator("#categoryList")).to_be_hidden()
                expect(page.locator("body")).to_have_attribute("data-presentation", "space")
                page.close()

            classic = context.new_page()
            classic.goto(f"{base}/desktop-organizer/index.html", wait_until="networkidle")
            classic.locator('[data-category="recent"] [data-name="doc-1.txt"]').wait_for()
            assert_classic(classic)
            expect(classic.locator("#categoryList")).to_be_visible()
            assert classic.evaluate("JSON.parse(localStorage.getItem('dtkit_desktop_organizer')).presentation") == "space"
            assert "16" in classic.locator("#statusText").inner_text()
            baseline_geometry = classic.evaluate("window.__nativeGeometry.length")
            baseline_scans = classic.evaluate("window.__calls.filter(call => call.command === 'desktop_scan').length")
            desktop = desktop_page()

            settings = context.new_page()
            settings.set_viewport_size({"width": 1280, "height": 850})
            settings.goto(base, wait_until="networkidle")
            settings.locator('[data-view="settings"]').click()
            settings.locator('.settings-side-nav__item[href="#configSection"]').click()
            expect(settings.locator('[data-organizer-presentation="space"]')).to_be_checked()

            # Classic search and selected real file survive both lifetime choices.
            classic.locator("#searchInput").fill("doc-")
            expect(classic.locator("#searchResultsList .file-item")).to_have_count(10)
            classic.locator('#searchResultsList [data-name="doc-3.txt"]').click()
            expect(classic.locator('#searchResultsList [data-name="doc-3.txt"]')).to_have_class("file-item selected")
            settings_choice("presentation", "classic")
            assert_classic(classic)
            expect(classic.locator("#searchInput")).to_have_value("doc-")
            expect(classic.locator("#searchResultsList .file-item")).to_have_count(10)
            expect(classic.locator("#searchResultsList .file-item.selected")).to_have_attribute("data-path", "C:/Desktop/doc-3.txt")
            # Space is retained until native retires it; it cannot become classic.
            expect(desktop.locator("#desktopSpaceView")).to_be_visible()
            expect(desktop.locator("#categoryList")).to_be_hidden()
            retire_desktop(desktop)

            settings_choice("presentation", "space")
            desktop = desktop_page()
            assert_classic(classic)
            expect(classic.locator("#searchInput")).to_have_value("doc-")
            expect(classic.locator("#searchResultsList .file-item.selected")).to_have_attribute("data-path", "C:/Desktop/doc-3.txt")
            classic.locator("#searchInput").press("Escape")
            expect(classic.locator("#categoryList")).to_be_visible()

            # Existing expanded groups, selection and scroll stay in their host.
            document_header = classic.locator('[data-category="document"] .category-header')
            document_header.click()
            classic.locator('#categoryList [data-category="document"] [data-name="doc-4.txt"]').click()
            classic.locator("#categoryList").evaluate("node => {node.scrollTop = 90;}")
            scroll_before = classic.locator("#categoryList").evaluate("node => node.scrollTop")
            assert scroll_before > 0
            settings_choice("presentation", "classic")
            retire_desktop(desktop)
            settings_choice("presentation", "space")
            desktop = desktop_page()
            assert_classic(classic)
            assert classic.locator("#categoryList").evaluate("node => node.scrollTop") == scroll_before
            expect(classic.locator('#categoryList [data-category="document"] [data-name="doc-4.txt"]')).to_have_class("file-item selected")

            # The bounded legacy folder browser remains usable through handoff.
            classic.locator('[data-category="folder"] .category-header').click()
            classic.locator('#categoryList [data-name="Project Folder"]').click()
            expect(classic.locator(".folder-browser")).to_be_visible()
            assert "brief.md" in classic.locator(".folder-browser__list").inner_text()
            settings_choice("presentation", "classic")
            retire_desktop(desktop)
            expect(classic.locator(".folder-browser")).to_be_visible()
            settings_choice("presentation", "space")
            desktop = desktop_page()
            expect(classic.locator(".folder-browser")).to_be_visible()
            assert_classic(classic)
            classic.locator("[data-folder-back]").click()
            expect(classic.locator(".folder-browser")).to_be_hidden()

            # The settings peer updates the actual desktop host, not the old side panel.
            settings_choice("layout", "drawer")
            expect(desktop.locator("#desktopSpaceView")).to_have_attribute("data-layout", "drawer")
            settings_choice("appearance", "liquid")
            expect(desktop.locator("#desktopSpaceView")).to_have_attribute("data-appearance", "liquid")
            settings.locator("#desktopReducedMotion").check(force=True)
            expect(desktop.locator("#desktopSpaceView")).to_have_attribute("data-reduced-motion", "true")
            settle(desktop)
            desktop.locator(".space-drawer-handle").click()
            expect(desktop.locator(".space-drawer")).to_be_visible()
            assert desktop.locator(".space-motion-material").count() == 0
            desktop.locator(".space-drawer [data-space-close]").click()
            expect(desktop.locator(".space-drawer")).to_be_hidden()
            assert_classic(classic)

            # Quick settings changes still converge on the complete latest preference.
            settings.evaluate("""async () => {
                const choices = [['layout','zones'], ['appearance','warm'], ['layout','islands'],
                    ['appearance','liquid'], ['layout','drawer']];
                for (const [kind,value] of choices) {
                    document.querySelector(`[data-organizer-${kind}="${value}"]`).closest('label').click();
                    await new Promise(resolve => setTimeout(resolve,35));
                }
            }""")
            expect(desktop.locator("#desktopSpaceView")).to_have_attribute("data-layout", "drawer")
            expect(desktop.locator("#desktopSpaceView")).to_have_attribute("data-appearance", "liquid")
            expect(settings.locator('[data-organizer-layout="drawer"]')).to_be_checked()
            assert_classic(classic)
            desktop.screenshot(path=str(SCREENSHOTS / "desktop-host-drawer.png"))

            # A reconstructed desktop host uses saved layout/material/reduced motion.
            retire_desktop(desktop)
            desktop = desktop_page()
            expect(desktop.locator("#desktopSpaceView")).to_have_attribute("data-layout", "drawer")
            expect(desktop.locator("#desktopSpaceView")).to_have_attribute("data-appearance", "liquid")
            expect(desktop.locator("#desktopSpaceView")).to_have_attribute("data-reduced-motion", "true")
            assert classic.evaluate("window.__nativeGeometry.length") == baseline_geometry
            assert classic.evaluate("window.__calls.filter(call => call.command === 'desktop_scan').length") == baseline_scans
            assert not desktop.evaluate("window.__calls.some(call => ['set_user_interacting','get_screen_bounds','update_hotzone_position'].includes(call.command))")
            settings.screenshot(path=str(SCREENSHOTS / "parallel-presentation-settings.png"))
            classic.screenshot(path=str(SCREENSHOTS / "classic-host-retained.png"))
            assert not errors, errors
            context.close()
            browser.close()
    finally:
        close_server()
    print(f"Desktop presentation dual-host UI passed; screenshots={SCREENSHOTS}")


if __name__ == "__main__":
    main()
