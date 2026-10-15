"""Browser regression for the transparent Windows desktop host (native bridge mocked)."""
import importlib.util
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("presentation_smoke", ROOT / "tests/desktop-presentation-ui-smoke.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def contains(regions, x, y):
    return any(r["x"] <= x < r["x"] + r["width"] and r["y"] <= y < r["y"] + r["height"] for r in regions)


def latest_regions(page):
    return page.evaluate("window.__calls.filter(c => c.command === 'desktop_space_set_regions').at(-1).args.regions")


def main():
    base, close = helper.local_test_url()
    errors = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            context.add_init_script(helper.MOCK_TAURI)
            context.add_init_script("""localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({enabled: true, presentation: 'space', layout: 'islands', appearance: 'liquid'}));""")
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(base + "/desktop-organizer/index.html?host=desktop", wait_until="networkidle")
            page.wait_for_function("window.__calls.some(c => c.command === 'desktop_space_set_regions')")
            page.wait_for_function("() => Number(getComputedStyle(document.querySelector('#panel')).opacity) === 1")
            assert not page.locator("#panel").evaluate("panel => panel.inert")
            assert page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgba(0, 0, 0, 0)"
            assert page.evaluate("getComputedStyle(document.querySelector('#desktopSpaceView')).backgroundImage") == "none"
            expect(page.locator(".organizer-header")).to_be_hidden()
            expect(page.locator(".status-bar")).to_be_hidden()
            expect(page.locator("#dragHandle")).to_be_hidden()
            expect(page.locator("#categoryList")).to_be_hidden()
            expect(page.locator(".search-container")).to_be_hidden()
            expect(page.locator("#desktopTools")).to_be_visible()
            calls = page.evaluate("window.__calls")
            assert next(i for i, c in enumerate(calls) if c["command"] == "desktop_space_ready") < next(i for i, c in enumerate(calls) if c["command"] == "desktop_space_set_regions")
            assert not any(c["command"] in ("set_user_interacting", "get_screen_bounds", "update_hotzone_position") for c in calls)
            assert not page.evaluate("window.__nativeGeometry")
            regions = latest_regions(page)
            assert not contains(regions, 100, 200), "Desktop blank space claimed by the host"
            block = page.locator('.space-block[data-space-group="document"]')
            rect = block.bounding_box()
            assert contains(regions, rect["x"] + rect["width"] / 2, rect["y"] + 50)
            caption = block.locator('.space-caption').bounding_box()
            page.mouse.move(caption['x'] + caption['width'] / 2, caption['y'] + caption['height'] / 2)
            page.mouse.down()
            page.mouse.move(caption['x'] + caption['width'] / 2 - 290, caption['y'] + caption['height'] / 2 + 150, steps=12)
            page.mouse.up()
            page.wait_for_timeout(120)
            moved = block.bounding_box()
            assert abs(moved['x'] - rect['x'] + 290) < 2 and abs(moved['y'] - rect['y'] - 150) < 2
            expect(page.locator('.space-popup')).to_be_hidden()
            page.reload(wait_until='networkidle')
            page.wait_for_function("window.__calls.some(c => c.command === 'desktop_space_set_regions')")
            restored = block.bounding_box()
            assert abs(restored['x'] - moved['x']) < 2 and abs(restored['y'] - moved['y']) < 2

            # New cabinets still operate on actual data, with an anchor-to-popup
            # region reservation that shrinks back once the closing spring finishes.
            block.locator(".space-folder-surface").click()
            popup = page.locator(".space-popup")
            expect(popup).to_be_visible()
            page.wait_for_timeout(90)
            popup_box = popup.bounding_box()
            assert contains(latest_regions(page), popup_box["x"] + popup_box["width"] / 2, popup_box["y"] + popup_box["height"] / 2)
            page.wait_for_timeout(430)
            popup.locator(".space-file").first.dblclick()
            page.wait_for_function("window.__calls.some(c => c.command === 'desktop_open_file')")
            popup.locator("[data-space-close]").click()
            expect(popup).to_be_hidden()
            page.wait_for_timeout(130)
            regions = latest_regions(page)
            assert not contains(regions, popup_box["x"] + 12, popup_box["y"] + 12), "Closed pop-up leaves a desktop input trap"

            # The block editor captures only its material, not its transparent
            # full-screen layout parent; left desktop space stays with Explorer.
            block.click(button="right")
            page.locator(".space-context [data-space-edit]").click()
            expect(page.locator("#spaceEditorName")).to_be_visible()
            page.wait_for_timeout(470)
            editor_box = page.locator(".space-editor").bounding_box()
            regions = latest_regions(page)
            assert contains(regions, editor_box["x"] + 100, editor_box["y"] + 100)
            assert not contains(regions, 100, 200)
            page.locator(".space-editor [data-space-editor-cancel]").first.click()
            expect(page.locator(".space-overlay")).to_be_hidden()

            helper.open_tools(page)
            page.locator("#desktopSearchButton").click()
            page.locator("#searchInput").fill("doc-")
            expect(page.locator("#searchResultsList .file-item")).to_have_count(10)
            expect(page.locator("#desktopSpaceView")).to_be_visible()
            expect(page.locator("#categoryList")).to_be_hidden()
            page.locator("#searchInput").press("Escape")
            expect(page.locator(".search-container")).to_be_hidden()
            expect(page.locator("#searchResults")).to_be_hidden()

            # Folder browsing remains a bounded desktop surface.
            folder_block = page.locator('.space-block[data-space-group="folder"]')
            folder_block.locator(".space-folder-surface").click()
            popup.locator(".space-file[data-is-folder='true']").dblclick()
            expect(page.locator(".folder-browser")).to_be_visible()
            expect(page.locator("#desktopSpaceView")).to_be_visible()
            page.wait_for_timeout(100)
            assert not contains(latest_regions(page), 100, 200)
            page.locator("[data-folder-back]").click()
            expect(page.locator("#categoryList")).to_be_hidden()

            helper.choose(page, "layout", "zones")
            expect(page.locator("#desktopSpaceView")).to_have_attribute("data-layout", "zones")
            page.locator("[data-appearance-close]").click()
            helper.settle(page)
            grid = page.locator('.space-zone[data-space-group="document"] .space-file-grid')
            items = grid.locator(".space-file")
            before = helper.grid_order(grid)
            items.first.drag_to(items.nth(2))
            page.wait_for_timeout(350)
            after = helper.grid_order(grid)
            assert before != after and sorted(before) == sorted(after)
            assert not contains(latest_regions(page), 100, 200)

            helper.choose(page, "layout", "drawer")
            page.locator("[data-appearance-close]").click()
            helper.settle(page)
            expect(page.locator(".space-stage")).to_be_hidden()
            expect(page.locator(".space-drawer-handle")).to_be_visible()
            body_rect = page.locator("body").bounding_box()
            for _ in range(3):
                page.locator(".space-drawer-handle").click()
                expect(page.locator(".space-drawer")).to_be_visible()
                page.wait_for_timeout(480)
                assert page.locator("body").bounding_box() == body_rect
                page.locator(".space-drawer [data-space-close]").click()
                expect(page.locator(".space-drawer")).to_be_hidden()
                page.wait_for_timeout(100)
            page.wait_for_timeout(100)
            count = page.evaluate("window.__calls.filter(c => c.command === 'desktop_space_set_regions').length")
            page.wait_for_timeout(700)
            assert page.evaluate("window.__calls.filter(c => c.command === 'desktop_space_set_regions').length") == count, "Idle desktop keeps sending regions"

            # Top-level presentation is handed to the native lifecycle; classic
            # never becomes a full-screen desktop UI. Keep the previous furniture
            # painted until native asks its old window to retire.
            helper.choose(page, "presentation", "classic")
            expect(page.locator("#desktopSpaceView")).to_be_visible()
            expect(page.locator("#categoryList")).to_be_hidden()
            expect(page.locator("body")).to_have_attribute("data-presentation", "space")
            assert page.evaluate("window.__calls.some(c => c.command === 'set_desktop_organizer_mode' && c.args.presentation === 'classic')")
            page.evaluate("() => window.__TAURI__.event.emit('desktop-space-hiding', null)")
            page.wait_for_function("() => document.querySelector('#panel').inert")
            page.wait_for_function("() => Number(getComputedStyle(document.querySelector('#panel')).opacity) === 0")
            expect(page.locator("#categoryList")).to_be_hidden()
            count = page.evaluate("window.__calls.filter(c => c.command === 'desktop_space_set_regions').length")
            page.wait_for_timeout(450)
            assert page.evaluate("window.__calls.filter(c => c.command === 'desktop_space_set_regions').length") == count
            assert page.locator("#panel").evaluate("panel => panel.inert && Number(getComputedStyle(panel).opacity) === 0")
            assert not page.evaluate("window.__calls.some(c => c.command === 'set_user_interacting')")
            assert not errors, errors
            context.close()
            browser.close()
    finally:
        close()
    print("Desktop space host UI passed")


if __name__ == "__main__":
    main()
