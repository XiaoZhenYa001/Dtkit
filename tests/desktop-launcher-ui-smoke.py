"""Real-DOM launcher behavior smoke. Run after npm run build; no native apps open."""

import functools
import http.server
import os
import re
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(tempfile.mkdtemp(prefix="dtkit-desktop-launcher-"))
STORAGE_KEY = "dtkit_desktop_space_v2"
MOCK_TAURI = r"""
(() => {
    const listeners = new Map();
    const desktop = 'C:\\Users\\demo\\Desktop\\';
    const file = (name, category = 'document', options = {}) => ({
        name, path: desktop + name, category, is_folder: false, size: 1024,
        extension: name.split('.').pop(), modified_time: 1700000000,
        accessed_time: 1700000001, children: null, children_truncated: false,
        icon: null, ...options
    });
    const docs = ['Alpha.txt', 'Bravo.txt', 'Charlie.txt', 'Fast.txt',
        'Slow.txt', 'Unavailable.txt', 'hostile.html'].map(name => file(name));
    const image = file('Photo.png', 'image');
    const archive = file('Archive.bin', 'other');
    const pdf = file('Reference.pdf');
    const folder = file('Project', 'folder', { is_folder: true, size: 0, extension: '' });
    const app = file('Demo Tool', 'program', {
        path: 'C:\\Tools\\demo.exe', app_id: 'demo-managed-app', app_manual: true,
        app_category: 'program', extension: 'exe'
    });
    const nested = file('Child.md', 'document', { path: folder.path + '\\Notes\\Child.md' });
    const childFolder = file('Notes', 'folder', {
        path: folder.path + '\\Notes', is_folder: true, size: 0, extension: ''
    });
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=';
    const all = [...docs, image, archive, pdf, folder, app, nested, childFolder];
    const find = path => all.find(item => item.path.replaceAll('/', '\\').toLowerCase()
        === String(path).replaceAll('/', '\\').toLowerCase());
    const preview = path => {
        const item = find(path);
        if (!item) throw new Error('mock: missing preview file');
        const base = { name: item.name, path: item.path, extension: item.extension,
            size: item.size, modifiedTime: item.modified_time };
        if (item === image) return { ...base, kind: 'image', dataUrl: png };
        if (item === archive || item === app) return { ...base, kind: 'metadata',
            message: '<img src=x onerror="window.__previewInjected=1">请使用默认应用查看此格式' };
        if (item === pdf) return { ...base, kind: 'pdf',
            dataUrl: 'data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK' };
        return { ...base, kind: 'text', text: item.name === 'hostile.html'
            ? '<img src=x onerror="window.__previewInjected=1"><script>window.__previewInjected=2</script>'
            : 'SAFE-PREVIEW:' + item.name };
    };
    window.__calls = [];
    window.__previewInjected = 0;
    window.__pendingPreviews = new Map();
    window.__holdPreviewNames = new Set();
    window.__failOpen = false;
    window.__emit = async (name, payload = {}) => {
        await Promise.all([...(listeners.get(name) || [])].map(callback => callback({ event: name, payload })));
    };
    window.__releasePreview = name => {
        const pending = window.__pendingPreviews.get(name);
        if (!pending) throw new Error('mock: no pending preview for ' + name);
        window.__pendingPreviews.delete(name);
        pending.resolve(preview(pending.path));
    };
    window.__TAURI__ = {
        core: {
            convertFileSrc: path => path,
            invoke: async (command, args = {}) => {
                window.__calls.push({ command, args: structuredClone(args) });
                if (command === 'desktop_scan') {
                    const revision = Number(sessionStorage.getItem('launcher-smoke-scan') || 0) + 1;
                    sessionStorage.setItem('launcher-smoke-scan', String(revision));
                    return { documents: revision % 2 ? [...docs, pdf] : [pdf, ...docs].reverse(),
                        applications: [app], programs: [], images: [image], videos: [],
                        audios: [], archives: [], folders: [folder], others: [archive],
                        recent: [docs[2], image], total_count: docs.length + 5 };
                }
                if (command === 'desktop_list_folder') {
                    const isProject = args.path.replaceAll('/', '\\').toLowerCase() === folder.path.toLowerCase();
                    return { path: args.path, name: isProject ? 'Project' : 'Notes',
                        items: isProject ? [childFolder] : [nested], total_count: 1, truncated: false };
                }
                if (command === 'desktop_get_icon' || command === 'desktop_get_app_icon') return null;
                if (command === 'desktop_preview_file') {
                    const item = find(args.path);
                    if (window.__holdPreviewNames.has(item?.name)) {
                        return new Promise(resolve => window.__pendingPreviews.set(item.name, { resolve, path: args.path }));
                    }
                    return preview(args.path);
                }
                if (command === 'desktop_open_file' || command === 'desktop_open_app') {
                    if (window.__failOpen) throw new Error('mock: default app unavailable');
                    return null;
                }
                if (command === 'desktop_space_hide') return null;
                if (command === 'desktop_space_ready') return {
                    width: window.innerWidth, height: window.innerHeight,
                    scaleFactor: 1, scale_factor: 1
                };
                if (['desktop_locate_file', 'desktop_locate_app'].includes(command)) return null;
                throw new Error('unexpected mock command: ' + command);
            }
        },
        event: {
            listen: async (name, callback) => {
                if (!listeners.has(name)) listeners.set(name, new Set());
                listeners.get(name).add(callback);
                return () => listeners.get(name)?.delete(callback);
            },
            emit: async (name, payload) => window.__emit(name, payload)
        }
    };
})();
"""


def local_test_url():
    configured = os.environ.get("DTKIT_TEST_BASE_URL")
    if configured:
        return configured.rstrip("/"), lambda: None
    dist = ROOT / "dist"
    if not (dist / "desktop-organizer" / "space.html").is_file():
        raise RuntimeError("dist/desktop-organizer/space.html 不存在，请先运行 npm run build")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(dist))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def close():
        server.shutdown()
        server.server_close()

    return f"http://127.0.0.1:{server.server_port}", close


def card(page, name, lane="#fileGrid"):
    return page.locator(f"{lane} .launcher-card[data-id]").filter(
        has=page.locator(".file-name", has_text=re.compile(r"^" + re.escape(name) + r"$"))
    )


def button(page, name, lane="#fileGrid"):
    return card(page, name, lane).locator("button.launcher-file")


def calls(page, *commands):
    return page.evaluate("commands => window.__calls.filter(call => commands.includes(call.command))", list(commands))


def open_panel(page):
    page.wait_for_function("window.__calls?.some(call => call.command === 'desktop_space_ready')")
    page.evaluate("window.__emit('desktop-space-opened')")
    expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "false")
    page.locator("#fileGrid button.launcher-file").first.wait_for(state="visible")


def idle(page):
    page.mouse.move(0, 0)
    page.wait_for_function("document.getAnimations().length === 0", timeout=4000)


def root_ids(page):
    return page.locator("#fileGrid .launcher-card[data-id]").evaluate_all("items => items.map(item => item.dataset.id)")


def saved(page):
    return page.evaluate("key => JSON.parse(localStorage.getItem(key))", STORAGE_KEY)


def preview_file(page, name):
    button(page, name).click()
    page.keyboard.press("Space")
    expect(page.locator("#filePreview")).to_be_visible()
    expect(page.locator("#previewName")).to_have_text(name)


def drag_before(page, source, target):
    card(page, source).drag_to(card(page, target), target_position={"x": 3, "y": 24})


def main():
    base, close_server = local_test_url()
    errors, page_errors = [], []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 700})
                context.add_init_script(MOCK_TAURI)
                context.route("**/favicon.ico", lambda route: route.fulfill(status=204, body=""))
                page = context.new_page()
                page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.goto(f"{base}/desktop-organizer/space.html", wait_until="networkidle")
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "true")
                open_panel(page)

                # Click selects; native opening is reserved for double click and Enter.
                before = len(calls(page, "desktop_open_file", "desktop_open_app"))
                button(page, "Alpha.txt").click()
                expect(card(page, "Alpha.txt")).to_have_attribute("data-selected", "true")
                assert len(calls(page, "desktop_open_file", "desktop_open_app")) == before
                button(page, "Alpha.txt").dblclick()
                page.wait_for_function("window.__calls.some(call => call.command === 'desktop_space_hide')")
                assert calls(page, "desktop_open_file")[-1]["args"]["path"].endswith("Alpha.txt")
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "true")
                open_panel(page)
                hides = len(calls(page, "desktop_space_hide"))
                button(page, "Bravo.txt").click()
                page.keyboard.press("Enter")
                page.wait_for_function("count => window.__calls.filter(call => call.command === 'desktop_space_hide').length > count", arg=hides)
                assert calls(page, "desktop_open_file")[-1]["args"]["path"].endswith("Bravo.txt")
                open_panel(page)
                button(page, "Demo Tool").dblclick()
                page.wait_for_function("window.__calls.some(call => call.command === 'desktop_open_app')")
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "true")
                open_panel(page)

                page.evaluate("window.__failOpen = true")
                hides = len(calls(page, "desktop_space_hide"))
                button(page, "Unavailable.txt").dblclick()
                expect(page.locator("#spaceStatus")).to_have_attribute("data-error", "true")
                expect(page.locator("#spaceStatus")).to_contain_text("打开失败")
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "false")
                assert len(calls(page, "desktop_space_hide")) == hides
                page.evaluate("window.__failOpen = false")

                opens = len(calls(page, "desktop_open_file", "desktop_open_app"))
                previews = len(calls(page, "desktop_preview_file"))
                preview_file(page, "Alpha.txt")
                expect(page.locator("#previewContent")).to_contain_text("SAFE-PREVIEW:Alpha.txt")
                assert len(calls(page, "desktop_preview_file")) == previews + 1
                assert len(calls(page, "desktop_open_file", "desktop_open_app")) == opens
                assert page.locator('.launcher-inner').evaluate('node => node.inert')
                page.keyboard.press('Control+f')
                assert page.evaluate("document.querySelector('#filePreview').contains(document.activeElement)")
                page.locator('#previewClose').focus()
                page.keyboard.press('Tab')
                expect(page.locator('#previewOpen')).to_be_focused()
                page.keyboard.press('Shift+Tab')
                expect(page.locator('#previewClose')).to_be_focused()
                page.keyboard.press("Escape")
                expect(page.locator("#filePreview")).to_be_hidden()
                assert not page.locator('.launcher-inner').evaluate('node => node.inert')
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "false")
                assert len(calls(page, "desktop_space_hide")) == hides
                page.keyboard.press("Escape")
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "true")
                open_panel(page)

                # Keyboard navigation follows the card focused by Tab as well as clicks.
                button(page, 'Alpha.txt').click()
                button(page, 'Bravo.txt').focus()
                page.keyboard.press('ArrowRight')
                expect(button(page, 'Charlie.txt')).to_be_focused()
                preview_file(page, 'Alpha.txt')
                page.keyboard.press('Escape')
                page.emulate_media(reduced_motion='reduce')
                expect(page.locator('#filePreview')).to_be_hidden()
                assert page.locator('#previewContent').evaluate('node => node.childElementCount') == 0
                button(page, 'Bravo.txt').click()
                expect(card(page, 'Bravo.txt')).to_have_attribute('data-selected', 'true')
                page.emulate_media(reduced_motion='no-preference')

                # Text and unsupported-file metadata must remain inert text.
                preview_file(page, "hostile.html")
                expect(page.locator("#previewContent")).to_contain_text("<script>")
                assert page.locator("#previewContent script, #previewContent img[onerror]").count() == 0
                assert page.evaluate("window.__previewInjected") == 0
                page.keyboard.press("Escape")
                preview_file(page, "Archive.bin")
                expect(page.locator("#previewContent")).to_contain_text("请使用默认应用查看此格式")
                assert page.locator("#previewContent img[onerror]").count() == 0
                assert page.evaluate("window.__previewInjected") == 0
                page.keyboard.press("Escape")

                # An old asynchronous preview cannot replace a later preview.
                page.evaluate("window.__holdPreviewNames.add('Slow.txt')")
                preview_file(page, "Slow.txt")
                page.wait_for_function("window.__pendingPreviews.has('Slow.txt')")
                page.keyboard.press("Escape")
                preview_file(page, "Fast.txt")
                expect(page.locator("#previewContent")).to_contain_text("SAFE-PREVIEW:Fast.txt")
                page.evaluate("window.__releasePreview('Slow.txt')")
                page.wait_for_timeout(80)
                expect(page.locator("#previewName")).to_have_text("Fast.txt")
                expect(page.locator("#previewContent")).to_contain_text("SAFE-PREVIEW:Fast.txt")
                page.keyboard.press("Escape")

                # Folder activation stays inside the panel; deep pins survive reload.
                button(page, "Alpha.txt").click()
                card(page, "Alpha.txt").locator(".pin-button").click()
                expect(card(page, "Alpha.txt", "#pinnedGrid")).to_be_visible()
                hides = len(calls(page, "desktop_space_hide"))
                button(page, "Project").dblclick()
                button(page, "Notes").wait_for(state="visible")
                button(page, "Notes").dblclick()
                button(page, "Child.md").wait_for(state="visible")
                assert len(calls(page, "desktop_list_folder")) >= 2
                assert len(calls(page, "desktop_space_hide")) == hides
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "false")
                button(page, "Child.md").click()
                card(page, "Child.md").locator(".pin-button").click()
                page.locator("#folderRoot").click()
                expect(card(page, "Child.md", "#pinnedGrid")).to_be_visible()
                page.reload(wait_until="networkidle")
                open_panel(page)
                for name in ("Alpha.txt", "Child.md"):
                    expect(card(page, name, "#pinnedGrid")).to_be_visible()
                child_path = next(item["path"] for item in saved(page)["pinned"] if item["name"] == "Child.md")
                assert "Project" in child_path and "Notes" in child_path
                for name in ("Alpha.txt", "Child.md"):
                    card(page, name, "#pinnedGrid").locator(".pin-button").click()
                expect(page.locator("#pinnedSection")).to_be_hidden()

                # Drag is persisted; category filtering never discards hidden IDs.
                idle(page)
                drag_before(page, "Charlie.txt", "Alpha.txt")
                page.wait_for_function("key => JSON.parse(localStorage.getItem(key)).orders.root.length > 0", arg=STORAGE_KEY)
                reordered = root_ids(page)
                assert reordered.index("file:c:\\users\\demo\\desktop\\charlie.txt") < reordered.index("file:c:\\users\\demo\\desktop\\alpha.txt"), reordered
                page.reload(wait_until="networkidle")
                open_panel(page)
                assert root_ids(page) == reordered, {"before": reordered, "after": root_ids(page)}
                all_order = saved(page)["orders"]["root"]
                page.locator('[data-filter="document"]').click()
                expect(page.locator('[data-filter="document"]')).to_have_attribute("aria-pressed", "true")
                visible = set(root_ids(page))
                hidden_before = [item for item in all_order if item not in visible]
                assert hidden_before, all_order
                idle(page)
                drag_before(page, "Bravo.txt", "Charlie.txt")
                page.wait_for_function("key => { const ids = JSON.parse(localStorage.getItem(key)).orders.root; return ids.indexOf('file:c:\\\\users\\\\demo\\\\desktop\\\\bravo.txt') < ids.indexOf('file:c:\\\\users\\\\demo\\\\desktop\\\\charlie.txt'); }", arg=STORAGE_KEY)
                after_filter = saved(page)["orders"]["root"]
                assert [item for item in after_filter if item not in visible] == hidden_before
                assert set(after_filter) == set(all_order)
                page.locator('[data-filter="all"]').click()
                expect(page.locator('[data-filter="all"]')).to_have_attribute("aria-pressed", "true")
                assert root_ids(page) == after_filter
                page.reload(wait_until="networkidle")
                open_panel(page)
                assert root_ids(page) == after_filter

                page.locator("#spaceSearch").fill("Alp")
                page.locator("#spaceSearch").fill("Char")
                expect(page.locator("#fileGrid .launcher-card[data-id]")).to_have_count(1)
                expect(button(page, "Charlie.txt")).to_be_visible()
                page.locator("#spaceSearch").fill("Bravo")
                hides = len(calls(page, "desktop_space_hide"))
                page.locator("#spaceSearch").press("Enter")
                page.wait_for_function("count => window.__calls.filter(call => call.command === 'desktop_space_hide').length > count", arg=hides)
                assert calls(page, "desktop_open_file")[-1]["args"]["path"].endswith("Bravo.txt")
                open_panel(page)
                page.locator("#spaceSearch").fill("")
                assert root_ids(page) == after_filter

                # Closing may reverse into opening without a discontinuity or stale hide.
                idle(page)
                continuity = page.evaluate("""async () => {
                    const node = document.querySelector('#launcher');
                    await window.__emit('desktop-space-closing');
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    const exit = node.getAnimations().find(animation => animation.effect.target === node);
                    if (!exit) return {error:'The complete panel has no exit animation'};
                    exit.pause(); exit.currentTime = 90;
                    const before = Number(getComputedStyle(node).opacity);
                    const closing = { hidden:node.getAttribute('aria-hidden'),inert:node.inert,
                        animations:node.getAnimations().map(a=>({time:a.currentTime,state:a.playState})),
                        status:document.querySelector('#spaceStatus').textContent };
                    await window.__emit('desktop-space-opened');
                    const after = Number(getComputedStyle(node).opacity);
                    return { before, after, closing };
                }""")
                assert 0 < continuity.get("before",1) < 1, continuity
                assert abs(continuity["after"] - continuity["before"]) < .08, continuity
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "false")
                idle(page)

                # Native close events and frontend hide IPC belong to one show.
                page.evaluate("window.__emit('desktop-space-opened', {session: 40})")
                idle(page)
                hides = len(calls(page, "desktop_space_hide"))
                page.evaluate("window.__emit('desktop-space-closing', {session: 39})")
                idle(page)
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "false")
                assert len(calls(page, "desktop_space_hide")) == hides
                page.evaluate("window.__emit('desktop-space-closing', {session: 40})")
                page.wait_for_function("count => window.__calls.filter(call => call.command === 'desktop_space_hide').length > count", arg=hides)
                assert calls(page, "desktop_space_hide")[-1]["args"] == {"session": 40}
                page.evaluate("window.__emit('desktop-space-opened', {session: 42})")
                page.evaluate("window.__emit('desktop-space-closing', {session: 40})")
                idle(page)
                expect(page.locator("#launcher")).to_have_attribute("aria-hidden", "false")

                for width, height in ((800, 500), (1280, 700)):
                    page.set_viewport_size({"width": width, "height": height})
                    idle(page)
                    bounds = page.evaluate("""() => {
                        const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom }; };
                        return { width:innerWidth, height:innerHeight,
                            scrollWidth:document.documentElement.scrollWidth,
                            scrollHeight:document.documentElement.scrollHeight,
                            nodes:['#launcher','#spaceSearch','#closeSpace','#spaceStatus'].map(selector => ({selector,...rect(document.querySelector(selector))})) };
                    }""")
                    assert bounds["scrollWidth"] <= width and bounds["scrollHeight"] <= height, bounds
                    assert all(item["x"] >= -1 and item["y"] >= -1 and item["right"] <= width + 1
                               and item["bottom"] <= height + 1 for item in bounds["nodes"]), bounds
                    preview_file(page, "Alpha.txt")
                    preview_bounds = page.locator("#filePreview").bounding_box()
                    assert preview_bounds and preview_bounds["x"] >= 0 and preview_bounds["y"] >= 0
                    assert preview_bounds["x"] + preview_bounds["width"] <= width + 1
                    assert preview_bounds["y"] + preview_bounds["height"] <= height + 1
                    page.keyboard.press("Escape")
                    idle(page)
                    page.screenshot(path=str(OUT / f"launcher-{width}x{height}.png"))

                assert not page_errors, page_errors
                unexpected_errors = [error for error in errors if "mock: default app unavailable" not in error]
                assert not unexpected_errors, unexpected_errors
                context.close()
            finally:
                browser.close()
    finally:
        close_server()
    print(f"desktop launcher UI smoke passed; screenshots={OUT}")


if __name__ == "__main__":
    main()
