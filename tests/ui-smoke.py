"""Production-preview smoke test. Requires Python Playwright and Chromium."""

import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TAURI_CONFIG = json.loads(
    (PROJECT_ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
)
PRODUCTION_CSP = TAURI_CONFIG["app"]["security"]["csp"]
BASE_URL = os.environ.get("DTKIT_TEST_BASE_URL", "http://127.0.0.1:4173")


def apply_production_csp(route):
    response = route.fetch()
    headers = dict(response.headers)
    if "text/html" in headers.get("content-type", ""):
        headers["content-security-policy"] = PRODUCTION_CSP
    route.fulfill(response=response, headers=headers)


def assert_no_runtime_errors(errors):
    if errors:
        raise AssertionError("Browser runtime errors:\n" + "\n".join(errors))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    context.route(f"{BASE_URL}/**", apply_production_csp)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.on(
        "console",
        lambda message: errors.append(f"console.error: {message.text}")
        if message.type == "error"
        else None,
    )

    page.goto(BASE_URL, wait_until="networkidle")
    page.locator(".tool-card").first.wait_for(state="visible")

    cards = page.locator(".tool-card")
    if cards.count() != 17:
        raise AssertionError(f"Expected 17 tool cards, found {cards.count()}")

    icon_style = page.locator('[data-view="toolLibrary"] i').first.evaluate(
        "element => ({"
        "fontFamily: getComputedStyle(element).fontFamily, "
        "content: getComputedStyle(element, '::before').content"
        "})"
    )
    if "remixicon" not in icon_style["fontFamily"].lower():
        raise AssertionError(f"Subset icon font was not applied: {icon_style!r}")
    if icon_style["content"] in {"none", "normal", '""'}:
        raise AssertionError(f"Subset icon glyph is missing: {icon_style!r}")

    initial_resources = page.evaluate(
        "performance.getEntriesByType('resource').map(entry => entry.name)"
    )
    if not any("remixicon-subset" in resource for resource in initial_resources):
        raise AssertionError("Subset icon font was not loaded")
    if any("alarm-clock" in resource for resource in initial_resources):
        raise AssertionError("Alarm clock chunk was eagerly loaded")
    if any("html-preview" in resource for resource in initial_resources):
        raise AssertionError("HTML preview chunk was eagerly loaded")
    if any("settings-" in resource for resource in initial_resources):
        raise AssertionError("Settings assets were eagerly loaded")
    if page.locator('[data-view="downloads"]').count():
        raise AssertionError("Removed download manager is still present in the sidebar")

    ready_cards = page.locator(".tool-card:not(.tool-card--planned)")
    for index in range(min(5, ready_cards.count())):
        ready_cards.nth(index).locator(".tool-card__favorite").click()
    page.locator('[data-view="favorites"]').click()
    page.locator("#favoritesGrid .tool-card").first.wait_for(state="visible")
    first_frame_positions = page.locator("#favoritesGrid .tool-card").evaluate_all(
        """cards => cards.map(card => {
            const rect = card.getBoundingClientRect();
            return `${Math.round(rect.x)}:${Math.round(rect.y)}`;
        })"""
    )
    if len(set(first_frame_positions)) != len(first_frame_positions):
        raise AssertionError(f"Favorite cards overlapped on the first frame: {first_frame_positions!r}")

    page.locator('[data-view="settings"]').click()
    page.locator(".settings-content").wait_for(state="visible")
    if not page.locator("#downloadPathInput").input_value().strip():
        raise AssertionError("Lazy settings initialization did not populate download path")
    if page.locator("#shortcutBindings .shortcut-binding__record").count() != 1:
        raise AssertionError("Settings should retain only the command-palette shortcut")

    settings_resources = page.evaluate(
        "performance.getEntriesByType('resource').map(entry => entry.name)"
    )
    if not any("settings-" in resource for resource in settings_resources):
        raise AssertionError("Settings assets were not loaded on demand")
    for extension in (".css", ".js"):
        if not any(
            "settings-" in resource and resource.endswith(extension)
            for resource in settings_resources
        ):
            raise AssertionError(f"Settings {extension} chunk was not loaded")

    page.locator('[data-view="toolLibrary"]').click()
    page.locator(".tool-card").first.wait_for(state="visible")

    page.locator('#toolLibraryView [data-tool-id="html-preview"]').click()
    page.locator("#htmlEditor").wait_for(state="visible")
    if page.locator(".html-preview-container").evaluate(
        "element => getComputedStyle(element).display"
    ) != "flex":
        raise AssertionError("HTML preview external styles were not applied")

    loaded_resources = page.evaluate(
        "performance.getEntriesByType('resource').map(entry => entry.name)"
    )
    if not any("html-preview" in resource for resource in loaded_resources):
        raise AssertionError("HTML preview chunk was not loaded on demand")
    if not any(
        "html-preview" in resource and resource.endswith(".css")
        for resource in loaded_resources
    ):
        raise AssertionError("HTML preview CSS was not loaded as an external chunk")

    page.locator("#htmlEditor").fill(
        '<style>#preview-message { color: rgb(12, 34, 56); }</style>'
        '<div id="preview-message" style="font-weight: 700;">等待 JS</div>'
    )
    page.locator("#cssEditor").fill(
        "#preview-message { background-color: rgb(240, 241, 242); }"
    )
    page.locator("#jsEditor").fill(
        "document.getElementById('preview-message').textContent = 'JS 已执行';"
    )
    page.locator("#refreshPreviewBtn").click()

    preview = page.frame_locator("#previewFrame")
    message = preview.locator("#preview-message")
    try:
        expect(message).to_have_text("JS 已执行", timeout=10000)
    except Exception:
        assert_no_runtime_errors(errors)
        raise
    preview_style = message.evaluate(
        "element => ({"
        "color: getComputedStyle(element).color, "
        "fontWeight: getComputedStyle(element).fontWeight, "
        "backgroundColor: getComputedStyle(element).backgroundColor"
        "})"
    )
    if preview_style != {
        "color": "rgb(12, 34, 56)",
        "fontWeight": "700",
        "backgroundColor": "rgb(240, 241, 242)",
    }:
        raise AssertionError(f"Preview Blob CSS mismatch: {preview_style!r}")

    page.locator('[data-view="toolLibrary"]').click()
    page.locator('#toolLibraryView [data-tool-id="alarm-clock"]').click()
    page.locator(".alarm-clock-view").wait_for(state="visible")
    if page.locator(".alarm-clock-view").evaluate(
        "element => getComputedStyle(element).display"
    ) != "flex":
        raise AssertionError("Alarm clock external styles were not applied")

    final_resources = page.evaluate(
        "performance.getEntriesByType('resource').map(entry => entry.name)"
    )
    if not any("alarm-clock" in resource for resource in final_resources):
        raise AssertionError("Alarm clock chunk was not loaded on demand")
    if not any(
        "alarm-clock" in resource and resource.endswith(".css")
        for resource in final_resources
    ):
        raise AssertionError("Alarm clock CSS was not loaded as an external chunk")

    page.locator('[data-view="toolLibrary"]').click()
    page.locator('#toolLibraryView [data-tool-id="json-formatter"]').click()
    page.locator("#jsonInput").wait_for(state="visible")
    page.wait_for_timeout(100)
    page.locator("#jsonInput").fill('{"outer":{"inner":1}}')
    expect(page.locator("#jsonStatus")).to_contain_text("JSON 解析成功")
    json_output_lines = page.locator("#jsonOutput .json-output-line")
    json_output_lines.first.wait_for(state="visible", timeout=10000)
    output_paddings = json_output_lines.evaluate_all(
        "elements => elements.map(element => "
        "Number.parseFloat(getComputedStyle(element).paddingLeft))"
    )
    if not any(padding > 0 for padding in output_paddings):
        raise AssertionError("Dynamic JSON indentation was blocked by production CSP")

    assert_no_runtime_errors(errors)

    organizer_errors = []
    context.add_init_script(
        """
        window.__TAURI__ = {
            core: {
                invoke: async command => {
                    if (command === 'desktop_scan') {
                        return {
                            recent: [], documents: [], images: [], videos: [],
                            audios: [], archives: [], programs: [], folders: [], others: []
                        };
                    }
                    if (command === 'get_screen_bounds') {
                        return { width: 1920, height: 1080 };
                    }
                    return null;
                }
            },
            window: {
                getCurrentWindow: () => ({
                    innerSize: async () => ({ width: 550, height: 450 }),
                    innerPosition: async () => ({ x: 1350, y: 10 }),
                    setSize: async () => {},
                    setPosition: async () => {}
                })
            }
        };
        """
    )
    organizer_page = context.new_page()
    organizer_page.on("pageerror", lambda error: organizer_errors.append(f"pageerror: {error}"))
    organizer_page.on(
        "console",
        lambda message: organizer_errors.append(f"console.error: {message.text}")
        if message.type == "error"
        else None,
    )
    organizer_page.goto(
        f"{BASE_URL}/desktop-organizer/index.html",
        wait_until="networkidle",
    )
    organizer_page.locator(".panel").wait_for(state="visible")
    if organizer_page.locator("#renameDialog").evaluate(
        "element => getComputedStyle(element).display"
    ) != "none":
        raise AssertionError("Desktop organizer dialog was not initially hidden")
    assert_no_runtime_errors(organizer_errors)
    organizer_page.close()

    print(
        "UI smoke passed: 17 cards, stable favorites, lazy views/tools, subset icons, "
        "strict CSP, sandboxed preview JS."
    )
    context.close()
    browser.close()
