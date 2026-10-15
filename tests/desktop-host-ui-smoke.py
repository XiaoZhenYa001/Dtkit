"""Regression for furniture on the actual desktop host, with a disposable bridge.

Run after npm run build. The normal production CSP applies to every document;
native lifecycle/window shaping calls are recorded without modifying Windows.
"""

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("presentation_smoke", ROOT / "tests/desktop-presentation-ui-smoke.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
SCREENSHOTS = Path(tempfile.mkdtemp(prefix="dtkit-desktop-host-"))
helper.SCREENSHOTS = SCREENSHOTS
HOST_PATH = "/desktop-organizer/index.html?host=desktop"

SEED = r"""
localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({
    enabled: true, presentation: 'space', layout: 'islands', appearance: 'liquid', reducedMotion: false
}));
if (!localStorage.getItem('dtkit_desktop_space_v1')) {
    localStorage.setItem('dtkit_desktop_space_v1', JSON.stringify({version: 1, groups: {
        document: {name: 'Documents', size: 'small'},
        image: {name: 'Images', size: 'quad'},
        folder: {name: 'Folders', size: 'nine'}
    }, orders: {}}));
}
window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push({
    directive: event.violatedDirective, uri: event.blockedURI, sample: event.sample
}));
"""


def region_calls(page):
    return page.evaluate("window.__calls.filter(call => call.command === 'desktop_space_set_regions')")


def latest_regions(page):
    return region_calls(page)[-1]["args"]["regions"]


def contains(regions, x, y):
    return any(rect["x"] <= x < rect["x"] + rect["width"] and rect["y"] <= y < rect["y"] + rect["height"] for rect in regions)


def assert_surface_region(page, selector):
    box = page.locator(selector).bounding_box()
    assert box, f"Missing surface: {selector}"
    page.wait_for_function("""point => {
        const regions = window.__calls.filter(call => call.command === 'desktop_space_set_regions').at(-1)?.args.regions || [];
        return regions.some(r => point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height);
    }""", arg={"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2})
    assert not contains(latest_regions(page), 100, 200), "An empty desktop point was captured by a transparent ancestor"
    return box


def close_appearance(page):
    if page.locator("#appearancePanel").is_visible():
        page.locator("[data-appearance-close]").click()


def settle(page):
    # Explicit functions avoid Playwright's string-evaluation path under CSP.
    page.wait_for_function("() => document.querySelectorAll('[data-presentation-ghost]').length === 0")
    page.wait_for_function("""() => document.getAnimations().every(animation =>
        !animation.effect?.target?.matches?.('#desktopSpaceView,#categoryList,#searchResults') || animation.playState !== 'running')""")
    page.wait_for_timeout(40)
    assert page.evaluate("""() => {
        const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
        return ids.length === new Set(ids).size;
    }"""), "A transition left duplicate element IDs"


def idle_regions(page):
    page.wait_for_timeout(550)
    before = len(region_calls(page))
    page.wait_for_timeout(700)
    assert len(region_calls(page)) == before, "The idle desktop continues sending geometry IPC"


def drag_furniture(page, selector, dx, dy, layout, key):
    element = page.locator(selector)
    before = element.bounding_box()
    handle = element.locator(".space-caption,.space-zone-head").bounding_box()
    assert before and handle
    x, y = handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx, y + dy, steps=18)
    page.mouse.up()
    page.wait_for_function("""({layout,key}) => !!JSON.parse(localStorage.getItem('dtkit_desktop_space_positions_v1') || '{}')[layout]?.[key]""", arg={"layout": layout, "key": key})
    after = element.bounding_box()
    assert abs(after["x"] - before["x"] - dx) <= 1 and abs(after["y"] - before["y"] - dy) <= 1, (before, after)
    assert before["width"] == after["width"] and before["height"] == after["height"]
    assert page.locator(".space-popup").is_hidden(), "Dragging the caption also opened the cabinet"
    saved = page.evaluate("""({layout,key}) => JSON.parse(localStorage.getItem('dtkit_desktop_space_positions_v1'))[layout][key]""", {"layout": layout, "key": key})
    assert abs(saved["x"] * 1440 - after["x"]) <= 1 and abs(saved["y"] * 900 - after["y"]) <= 1
    assert_surface_region(page, selector)
    return after


def assert_position(page, selector, expected):
    actual = page.locator(selector).bounding_box()
    assert actual and abs(actual["x"] - expected["x"]) <= 1 and abs(actual["y"] - expected["y"]) <= 1, (actual, expected)


def drag_file(page, source, target):
    source.scroll_into_view_if_needed()
    start, end = source.bounding_box(), target.bounding_box()
    assert start and end
    page.evaluate("""() => {
        window.__dropAudit = null;
        document.addEventListener('drop', () => {
            const placeholder = document.querySelector('.space-drop-placeholder');
            if (!placeholder) return;
            const grid = placeholder.parentElement;
            const slot = {x: placeholder.offsetLeft, y: placeholder.offsetTop};
            const nodes = [...document.querySelectorAll('.space-file[data-space-id]')]
                .filter(node => !node.classList.contains('is-drag-source'))
                .map(node => ({node, x: node.offsetLeft, y: node.offsetTop}));
            setTimeout(() => {
                const moved = grid.querySelector('.space-file.selected');
                window.__dropAudit = {
                    filledSlot: !!moved && moved.offsetLeft === slot.x && moved.offsetTop === slot.y,
                    stableNeighbors: nodes.every(item => item.node.isConnected && item.node.offsetLeft === item.x && item.node.offsetTop === item.y)
                };
            }, 100);
        }, {capture: true, once: true});
    }""")
    page.mouse.move(start["x"] + start["width"] / 2, start["y"] + start["height"] / 2)
    page.mouse.down()
    page.mouse.move(start["x"] + start["width"] / 2 + 12, start["y"] + start["height"] / 2 + 9, steps=5)
    page.mouse.move(end["x"] + end["width"] / 2, end["y"] + end["height"] / 2, steps=18)
    page.mouse.move(end["x"] + end["width"] / 2 + 1, end["y"] + end["height"] / 2, steps=2)
    page.locator(".space-drop-placeholder").wait_for(state="visible")
    page.mouse.up()
    page.wait_for_function("() => window.__dropAudit !== null")
    audit = page.evaluate("window.__dropAudit")
    assert audit["filledSlot"] and audit["stableNeighbors"], audit
    assert page.locator(".space-drop-placeholder,.is-drag-source").count() == 0
    assert "已调整文件顺序" not in page.locator("body").inner_text()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    base, close_server = helper.local_test_url()
    pages, errors, console_errors = [], [], []
    production_csp = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["app"]["security"]["csp"]
    try:
        with sync_playwright() as playwright, helper.capture_failures(pages, errors, console_errors):
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            context.set_default_timeout(10_000)
            context.add_init_script(helper.MOCK_TAURI + "\n" + SEED)

            def production_policy(route):
                response = route.fetch()
                headers = dict(response.headers)
                headers["content-security-policy"] = production_csp
                route.fulfill(response=response, headers=headers)

            context.route("**/desktop-organizer/index.html*", production_policy)
            page = context.new_page()
            pages.append(page)
            page.on("pageerror", lambda error: errors.append({"url": page.url, "message": str(error)}))
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            page.goto(base + HOST_PATH, wait_until="networkidle")
            page.wait_for_function("() => window.__calls.some(call => call.command === 'desktop_space_set_regions')")
            page.wait_for_function("() => Number(getComputedStyle(document.querySelector('#panel')).opacity) === 1")
            assert not page.locator("#panel").evaluate("panel => panel.inert"), "Entering host never enabled furniture interaction"
            assert page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgba(0, 0, 0, 0)"
            assert page.evaluate("getComputedStyle(document.querySelector('#desktopSpaceView')).backgroundImage") == "none"
            for selector in (".organizer-header", ".status-bar", "#dragHandle", ".resize-handle", "#categoryList", ".search-container"):
                expect(page.locator(selector).first).to_be_hidden()
            expect(page.locator("#desktopTools")).to_be_visible()
            calls = page.evaluate("window.__calls")
            assert next(i for i, call in enumerate(calls) if call["command"] == "desktop_space_ready") < next(i for i, call in enumerate(calls) if call["command"] == "desktop_space_set_regions")
            forbidden = {"set_user_interacting", "get_screen_bounds", "update_hotzone_position"}
            assert not any(call["command"] in forbidden for call in calls)
            assert not page.evaluate("window.__nativeGeometry")

            # The three cabinet shapes share the same glass perimeter.
            shells = [page.locator(f'.space-block[data-space-group="{key}"] .space-folder-shell').bounding_box() for key in ("document", "image", "folder")]
            assert len({(box["width"], box["height"]) for box in shells}) == 1, shells
            assert page.locator('.space-block[data-space-group="document"] .space-face > .space-face-cell').count() == 9
            assert page.locator('.space-block[data-space-group="image"] .space-face > .space-face-cell').count() == 3
            assert page.locator('.space-block[data-space-group="folder"] .space-face > .space-face-cell').count() == 8
            block_selector = '.space-block[data-space-group="document"]'
            island_position = drag_furniture(page, block_selector, -350, 65, "islands", "document")
            page.reload(wait_until="networkidle")
            page.wait_for_function("() => window.__calls.some(call => call.command === 'desktop_space_set_regions')")
            page.wait_for_function("() => Number(getComputedStyle(document.querySelector('#panel')).opacity) === 1")
            assert_position(page, block_selector, island_position)

            # The popup renders actual scan records and reserves its complete spring envelope.
            page.locator(block_selector + " .space-folder-surface").click()
            expect(page.locator(".space-popup")).to_be_visible()
            popup_box = assert_surface_region(page, ".space-popup")
            expect(page.locator(".space-popup .space-file")).to_have_count(10)
            page.wait_for_timeout(450)
            page.locator(".space-popup .space-file").first.dblclick()
            page.wait_for_function("() => window.__calls.some(call => call.command === 'desktop_open_file' && call.args.path === 'C:/Desktop/doc-1.txt')")
            page.locator(".space-popup [data-space-close]").click()
            expect(page.locator(".space-popup")).to_be_hidden()
            page.wait_for_timeout(150)
            assert not contains(latest_regions(page), popup_box["x"] + 12, popup_box["y"] + 12), "Closed popup kept capturing desktop input"

            # Transparent full-window dialog parents must never claim Explorer space.
            page.locator(block_selector).click(button="right")
            page.locator(".space-context [data-space-edit]").click()
            expect(page.locator("#spaceEditorName")).to_be_visible()
            assert_surface_region(page, ".space-editor")
            page.locator("#spaceEditorName").fill("My documents")
            page.locator('[data-space-size="nine"]').click()
            expect(page.locator(".space-editor-preview .space-face--nine")).to_be_visible()
            assert page.locator(".space-editor-preview [data-space-icon]").count() == 10
            page.locator('.space-editor button[type="submit"]').click()
            expect(page.locator(".space-overlay")).to_be_hidden()
            expect(page.locator(block_selector + " .space-caption strong")).to_have_text("My documents")
            assert_position(page, block_selector, island_position)

            helper.open_tools(page)
            page.locator("#desktopSearchButton").click()
            page.locator("#searchInput").fill("doc-")
            expect(page.locator("#searchResultsList .file-item")).to_have_count(10)
            expect(page.locator("#desktopSpaceView")).to_be_visible()
            assert_surface_region(page, ".search-container")
            assert_surface_region(page, "#searchResults")
            page.locator("#searchInput").press("Escape")
            expect(page.locator(".search-container")).to_be_hidden()
            expect(page.locator("#searchResults")).to_be_hidden()

            page.locator('.space-block[data-space-group="folder"] .space-folder-surface').click()
            page.locator('.space-popup .space-file[data-is-folder="true"]').dblclick()
            expect(page.locator(".folder-browser")).to_be_visible()
            expect(page.locator("#desktopSpaceView")).to_be_visible()
            assert_surface_region(page, "#categoryList")
            assert "brief.md" in page.locator(".folder-browser").inner_text()
            page.locator("[data-folder-back]").click()
            expect(page.locator("#categoryList")).to_be_hidden()

            # Interrupt material and layout changes while animations are in flight.
            helper.open_tools(page)
            page.locator("#appearanceBtn").click()
            page.evaluate("""async () => {
                const choices = [['layout','zones'], ['appearance','warm'], ['layout','drawer'],
                    ['appearance','liquid'], ['layout','islands'], ['layout','zones']];
                for (const [kind,value] of choices) {
                    document.querySelector(`[data-${kind}-choice="${value}"]`).click();
                    await new Promise(resolve => setTimeout(resolve,35));
                    if ([...document.querySelectorAll('[data-presentation-ghost]')].some(node => !node.inert || node.getAttribute('aria-hidden') !== 'true'))
                        throw new Error('Transition snapshot accepted desktop input');
                }
            }""")
            settle(page)
            expect(page.locator("#desktopSpaceView")).to_have_attribute("data-layout", "zones")
            expect(page.locator("#desktopSpaceView")).to_have_attribute("data-appearance", "liquid")
            close_appearance(page)
            assert not page.evaluate("window.__nativeGeometry")

            grid = page.locator('.space-zone[data-space-group="document"] .space-file-grid')
            before_order = helper.grid_order(grid)
            drag_file(page, grid.locator(".space-file").nth(1), grid.locator(".space-file").first)
            assert helper.grid_order(grid) == [before_order[1], before_order[0], *before_order[2:]]
            before_count = grid.locator(".space-file").count()
            working = page.locator('.space-zone[data-space-group="custom_1"] .space-file-grid')
            moved_path = grid.locator(".space-file").first.get_attribute("data-path")
            drag_file(page, grid.locator(".space-file").first, working)
            expect(grid.locator(".space-file")).to_have_count(before_count - 1)
            expect(working.locator(".space-file")).to_have_count(1)
            assert page.evaluate("JSON.parse(localStorage.getItem('desktop_organizer_file_categories'))")[moved_path] == "custom_1"
            zone_position = drag_furniture(page, '.space-zone[data-space-group="document"]', -50, 15, "zones", "document")
            helper.choose(page, "layout", "islands")
            close_appearance(page)
            settle(page)
            assert_position(page, block_selector, island_position)
            helper.choose(page, "layout", "zones")
            close_appearance(page)
            settle(page)
            assert_position(page, '.space-zone[data-space-group="document"]', zone_position)
            page.screenshot(path=str(SCREENSHOTS / "desktop-zones.png"))

            helper.choose(page, "layout", "drawer")
            close_appearance(page)
            settle(page)
            expect(page.locator(".space-stage")).to_be_hidden()
            body_box = page.locator("body").bounding_box()
            geometry = page.evaluate("({width: innerWidth, height: innerHeight, x: scrollX, y: scrollY})")
            handle_box = page.locator(".space-drawer-handle").bounding_box()
            target_point = {"x": 1440 - 400, "y": 70}
            for _ in range(3):
                page.locator(".space-drawer-handle").click()
                expect(page.locator(".space-drawer")).to_be_visible()
                page.wait_for_function("""point => window.__calls.filter(call => call.command === 'desktop_space_set_regions').at(-1).args.regions.some(r => point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height)""", arg=target_point)
                assert_surface_region(page, ".space-drawer")
                page.wait_for_timeout(440)
                page.locator(".space-drawer [data-space-close]").click()
                expect(page.locator(".space-drawer")).to_be_hidden()
                page.wait_for_timeout(150)
                assert not contains(latest_regions(page), **target_point), "Closed drawer kept its full input reservation"
                assert page.locator("body").bounding_box() == body_box
                after_handle = page.locator(".space-drawer-handle").bounding_box()
                assert after_handle == handle_box, (handle_box, after_handle)
                assert page.evaluate("({width: innerWidth, height: innerHeight, x: scrollX, y: scrollY})") == geometry
            idle_regions(page)
            page.screenshot(path=str(SCREENSHOTS / "desktop-drawer-closed.png"))

            helper.choose(page, "presentation", "classic")
            settle(page)
            # Persisting classic starts native retirement; the desktop WebView
            # must keep its last space composition until the host is destroyed.
            expect(page.locator("#desktopSpaceView")).to_be_visible()
            expect(page.locator("#categoryList")).to_be_hidden()
            expect(page.locator("body")).to_have_attribute("data-presentation", "space")
            assert page.evaluate("window.__calls.some(call => call.command === 'set_desktop_organizer_mode' && call.args.presentation === 'classic')")
            assert page.evaluate("JSON.parse(localStorage.getItem('dtkit_desktop_organizer')).presentation") == "classic"
            page.evaluate("() => window.__TAURI__.event.emit('desktop-space-hiding', null)")
            page.wait_for_function("() => document.querySelector('#panel').inert")
            page.wait_for_function("() => Number(getComputedStyle(document.querySelector('#panel')).opacity) === 0")
            expect(page.locator("#categoryList")).to_be_hidden()
            expect(page.locator("body")).to_have_attribute("data-presentation", "space")
            retirement_calls = len(region_calls(page))
            page.wait_for_timeout(450)
            assert len(region_calls(page)) == retirement_calls, "Retiring host kept reporting input geometry"
            assert page.locator("#panel").evaluate("panel => panel.inert && Number(getComputedStyle(panel).opacity) === 0")
            assert not any(call["command"] in forbidden for call in page.evaluate("window.__calls"))
            assert not errors, errors
            assert not page.evaluate("window.__cspViolations"), page.evaluate("window.__cspViolations")
            assert not console_errors, console_errors

            # A mode change while enter is still revealing must retire from the
            # current opacity, without a stale enter completion revealing it again.
            interrupted_context = browser.new_context(viewport={"width": 1440, "height": 900})
            interrupted_context.set_default_timeout(10_000)
            interrupted_context.route("**/desktop-organizer/index.html*", production_policy)
            interrupted_context.add_init_script(helper.MOCK_TAURI + "\n" + SEED + r"""
            (() => {
                const invoke = window.__TAURI__.core.invoke;
                let scheduled = false;
                window.__TAURI__.core.invoke = async (command, args) => {
                    const result = await invoke(command, args);
                    if (command === 'desktop_space_set_regions' && !scheduled) {
                        scheduled = true;
                        setTimeout(() => {
                            const panel = document.querySelector('#panel');
                            window.__enterInterrupted = {before: Number(getComputedStyle(panel).opacity), samples: []};
                            for (const listener of window.__eventListeners['desktop-space-hiding'] || []) listener({event: 'desktop-space-hiding', payload: null});
                            const start = performance.now();
                            const sample = () => {
                                window.__enterInterrupted.samples.push(Number(getComputedStyle(panel).opacity));
                                if (performance.now() - start < 550) requestAnimationFrame(sample);
                                else window.__enterInterrupted.done = true;
                            };
                            requestAnimationFrame(sample);
                        }, 80);
                    }
                    return result;
                };
            })();
            """)
            interrupted = interrupted_context.new_page()
            pages.append(interrupted)
            interrupted.on("pageerror", lambda error: errors.append({"url": interrupted.url, "message": str(error)}))
            interrupted.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            interrupted.goto(base + HOST_PATH, wait_until="networkidle")
            interrupted.wait_for_function("() => window.__enterInterrupted?.done")
            interrupted_audit = interrupted.evaluate("window.__enterInterrupted")
            assert 0 < interrupted_audit["before"] < 1, interrupted_audit
            assert max(interrupted_audit["samples"]) <= interrupted_audit["before"] + 0.03, interrupted_audit
            assert interrupted_audit["samples"][-1] == 0, interrupted_audit
            assert interrupted.locator("#panel").evaluate("panel => panel.inert")
            expect(interrupted.locator("#categoryList")).to_be_hidden()
            expect(interrupted.locator("body")).to_have_attribute("data-presentation", "space")
            idle_regions(interrupted)
            assert not errors, errors
            assert not interrupted.evaluate("window.__cspViolations"), interrupted.evaluate("window.__cspViolations")
            assert not console_errors, console_errors
            interrupted_context.close()
            context.close()
            browser.close()
    finally:
        close_server()
    print(f"Desktop host UI passed; screenshots={SCREENSHOTS}")


if __name__ == "__main__":
    main()
