"""Check packaged URL, Cron and unit tools; no native process or user files.

Build first: npm run build. DTKIT_TEST_BASE_URL may reuse a preview server.
"""

import importlib.util
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location("multi_page", Path(__file__).with_name("multi-page-ui-smoke.py"))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
ARTIFACTS = Path(__file__).resolve().parents[1] / ".tmp" / "utility-tools-ui"
TOOLS = {"url-encoder": "#urlInput", "crontab-explainer": "#cronInput", "unit-converter": "#unitInput"}


def open_tool(context, base_url, tool_id, errors, embedded=False):
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    if embedded:
        page.goto(base_url, wait_until="networkidle")
        page.locator('[data-view="toolLibrary"]').click()
        page.locator(f'[data-tool-id="{tool_id}"] .tool-card__title').click()
        frame = multi.active_tool_frame(page, TOOLS[tool_id])
    else:
        page.goto(base_url + f"/quick.html?kind=tool&toolId={tool_id}&instanceId=utility-test-{tool_id}", wait_until="networkidle")
        frame = page
    frame.wait_for_function("window.__DTKIT_TOOL_PAGE__?.ready")
    expect(frame.locator(TOOLS[tool_id])).to_be_visible()
    return page, frame


def assert_no_overflow(frame):
    metrics = frame.evaluate("""() => ({viewport:document.documentElement.clientWidth,
      document:document.documentElement.scrollWidth,body:document.body.scrollWidth})""")
    assert metrics["document"] <= metrics["viewport"] + 1, metrics
    assert metrics["body"] <= metrics["viewport"] + 1, metrics


def clipboard(page):
    return page.evaluate("window.__utilityClipboard.at(-1)")


def surface_color(locator):
    return locator.evaluate("""node => {
      for (let current=node; current; current=current.parentElement) {
        const color=getComputedStyle(current).backgroundColor;
        if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
      }
      return 'transparent';
    }""")


def assert_text_contrast(locator):
    foreground = locator.evaluate("node => getComputedStyle(node).color")
    background = surface_color(locator)
    import re
    def luminance(color):
        components = [float(value) / 255 for value in re.findall(r"[\d.]+", color)[:3]]
        assert len(components) == 3 and color.startswith("rgb"), color
        linear = [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in components]
        return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]
    levels = sorted([luminance(foreground), luminance(background)])
    ratio = (levels[1] + .05) / (levels[0] + .05)
    assert ratio >= 4.5, (foreground, background, ratio)


def restore_after_reload(page, snapshot):
    page.reload(wait_until="networkidle")
    page.wait_for_function("window.__DTKIT_TOOL_PAGE__?.ready")
    page.evaluate("saved => window.__DTKIT_TOOL_PAGE__.restore(saved)", snapshot)


def test_original_behaviors(context, base_url, errors):
    for embedded in (False, True):
        page, frame = open_tool(context, base_url, "url-encoder", errors, embedded)
        source = "https://example.com/搜索?q=桌面 工具&lang=zh-CN"
        frame.locator("#urlMode").select_option("full")
        frame.locator("#urlInput").fill(source)
        frame.locator("#urlEncodeBtn").click()
        encoded = frame.locator("#urlOutput").input_value()
        assert encoded.startswith("https://example.com/") and "%E6%90%9C%E7%B4%A2" in encoded
        frame.locator("#urlSwapBtn").click()
        frame.locator("#urlDecodeBtn").click()
        expect(frame.locator("#urlOutput")).to_have_value(source)
        frame.locator("#urlCopyBtn").click()
        assert clipboard(page) == source
        page.close()

        page, frame = open_tool(context, base_url, "crontab-explainer", errors, embedded)
        frame.locator("#cronInput").fill("0 9 * * MON-FRI")
        frame.locator("#cronExplainBtn").click()
        expect(frame.locator("#cronSummary")).to_contain_text("周一")
        expect(frame.locator("#cronFieldGrid .cron-field-card")).to_have_count(5)
        expect(frame.locator("#cronUpcoming li")).to_have_count(5)
        frame.locator("#cronInput").fill("60 * * * *")
        frame.locator("#cronExplainBtn").click()
        expect(frame.locator("#cronError")).to_be_visible()
        expect(frame.locator("#cronError")).to_contain_text("超出范围")
        page.close()

        page, frame = open_tool(context, base_url, "unit-converter", errors, embedded)
        frame.locator('[data-unit-category="temperature"]').click()
        source_combo = frame.locator('[data-unit-combobox="unitFrom"]')
        source_combo.locator(".unit-combobox__trigger").click()
        expect(source_combo.locator("[data-unit-option]")).to_have_count(3)
        source_combo.locator('[data-unit-option="c"]').click()
        target_combo = frame.locator('[data-unit-combobox="unitTo"]')
        target_combo.locator(".unit-combobox__trigger").click()
        target_combo.locator(".unit-combobox__search input").fill("华氏")
        expect(target_combo.locator("[data-unit-option]")).to_have_count(1)
        target_combo.locator('[data-unit-option="f"]').click()
        frame.locator("#unitInput").fill("100")
        expect(frame.locator("#unitOutput")).to_have_value("212")
        expect(frame.locator("#unitEquation")).to_contain_text("100 °C = 212 °F")
        expect(frame.locator("#unitOverviewList .unit-overview-item")).to_have_count(3)
        frame.locator('[data-unit-target="k"]').click()
        expect(frame.locator("#unitOutput")).to_have_value("373.15")
        page.close()


def test_layout(context, base_url, errors):
    for tool_id in TOOLS:
        page, frame = open_tool(context, base_url, tool_id, errors)
        if tool_id == "url-encoder":
            frame.locator("#urlMode").select_option("full")
            frame.locator("#urlInput").fill("https://example.com/搜索?q=桌面 工具&lang=zh-CN")
            frame.locator("#urlEncodeBtn").click()
        elif tool_id == "crontab-explainer":
            frame.locator("#cronTimeZone").select_option("utc")
            frame.locator("#cronFrom").fill("2026-10-28T08:59")
            frame.locator("#cronInput").fill("0 9 * * MON-FRI")
            frame.locator("#cronExplainBtn").click()
        else:
            frame.locator('[data-unit-category="volume"]').click()
            choose_unit(frame, "unitFrom", "l")
            choose_unit(frame, "unitTo", "ml")
            frame.locator("#unitInput").fill("2.5")
        for width, height in ((1366, 900), (760, 800), (390, 844)):
            page.set_viewport_size({"width": width, "height": height})
            colors = {}
            for scheme in ("light", "dark"):
                page.emulate_media(color_scheme=scheme, reduced_motion="reduce")
                expect(frame.locator(TOOLS[tool_id])).to_be_visible()
                assert_no_overflow(frame)
                contrast_targets = {
                    "url-encoder": ("#urlModeHint", "#urlStatus"),
                    "crontab-explainer": ("#cronDayRule", "#cronScheduleNote"),
                    "unit-converter": ("#unitEquation", "#unitFormula"),
                }
                for selector in contrast_targets[tool_id]:
                    assert_text_contrast(frame.locator(selector))
                colors[scheme] = {
                    "input": surface_color(frame.locator(TOOLS[tool_id])),
                    "titlebar": surface_color(frame.locator(".quick-titlebar")),
                }
                page.evaluate("document.getElementById('quickContent').scrollTop=0")
                page.screenshot(path=str(ARTIFACTS / f"{tool_id}-{scheme}-{width}.png"))
                if tool_id == "crontab-explainer" and width == 1366:
                    result = frame.locator("#cronResult").bounding_box()
                    upcoming = frame.locator(".cron-upcoming-card").bounding_box()
                    assert upcoming["x"] >= result["x"] + result["width"], (result, upcoming)
                    final_time = frame.locator("#cronUpcoming li").last.bounding_box()
                    footer = frame.locator(".quick-footer").bounding_box()
                    assert final_time["y"] + final_time["height"] <= footer["y"] + 1, (final_time, footer)
            for surface in ("input", "titlebar"):
                assert colors["light"][surface] != colors["dark"][surface], (tool_id, surface, colors)
            for explicit, system in (("light", "dark"), ("dark", "light")):
                page.emulate_media(color_scheme=system)
                page.evaluate("scheme => document.documentElement.dataset.theme=scheme", explicit)
                actual = surface_color(frame.locator(TOOLS[tool_id]))
                assert actual == colors[explicit]["input"], (tool_id, explicit, colors, actual)
                assert surface_color(frame.locator(".quick-titlebar")) == colors[explicit]["titlebar"], (tool_id, explicit, colors)
            page.evaluate("delete document.documentElement.dataset.theme")
        page.close()


def test_url_features(context, base_url, errors):
    page, frame = open_tool(context, base_url, "url-encoder", errors)
    frame.locator("#urlMode").select_option("form")
    frame.locator("#urlInput").fill("a+b c~!")
    frame.locator("#urlEncodeBtn").click()
    expect(frame.locator("#urlOutput")).to_have_value("a%2Bb+c%7E%21")
    frame.locator("#urlInput").fill("a%2Bb+c%7E%21")
    expect(frame.locator("#urlCopyBtn")).to_be_disabled()
    frame.locator("#urlDecodeBtn").click()
    expect(frame.locator("#urlOutput")).to_have_value("a+b c~!")

    frame.locator("#urlBatchMode").check()
    frame.locator("#urlInput").fill("first+line\n%E4%B8\nthird%2Bline")
    frame.locator("#urlDecodeBtn").click()
    expect(frame.locator("#urlErrors")).to_be_visible()
    expect(frame.locator("#urlErrors")).to_contain_text("2")
    expect(frame.locator("#urlCopyBtn")).to_be_disabled()
    expect(frame.locator("#urlOutput")).to_have_value("")
    frame.locator("#urlInput").fill("first+line\n\nthird%2Bline")
    frame.locator("#urlDecodeBtn").click()
    expect(frame.locator("#urlOutput")).to_have_value("first line\n\nthird+line")
    frame.locator("#urlCopyBtn").click()
    assert clipboard(page) == "first line\n\nthird+line"

    frame.locator("#urlBatchMode").uncheck()
    query = "https://example.com/path?q=a+b&q=%2B&empty=&flag&%3Ctag%3E=%3Cimg%20src=x%3E#section"
    frame.locator("#urlInput").fill(query)
    frame.locator("#urlInspectBtn").click()
    expect(frame.locator("#urlQueryPanel")).to_be_visible()
    expect(frame.locator("#urlQueryRows")).to_contain_text("a b")
    expect(frame.locator("#urlQueryRows")).to_contain_text("<img src=x>")
    expect(frame.locator("#urlQueryRows img")).to_have_count(0)
    expect(frame.locator("#urlQueryMeta")).to_contain_text("section")
    saved = frame.evaluate("window.__DTKIT_TOOL_PAGE__.snapshot()")
    assert saved["state"] is not None and saved["canRelease"] is True
    frame.locator("#urlInput").fill("x=changed")
    frame.locator("#urlMode").select_option("component")
    frame.evaluate("saved => window.__DTKIT_TOOL_PAGE__.restore(saved)", saved)
    expect(frame.locator("#urlInput")).to_have_value(query)
    expect(frame.locator("#urlMode")).to_have_value("form")
    expect(frame.locator("#urlQueryRows")).to_contain_text("a b")
    restore_after_reload(page, saved)
    expect(frame.locator("#urlMode")).to_have_value("form")
    expect(frame.locator("#urlInput")).to_have_value(query)
    expect(frame.locator("#urlQueryRows")).to_contain_text("a b")

    frame.locator("#urlInput").fill("x=%E4%B8")
    frame.locator("#urlInspectBtn").click()
    expect(frame.locator("#urlQueryStatus")).to_contain_text("无效")
    page.close()


def test_cron_features(context, base_url, errors):
    page, frame = open_tool(context, base_url, "crontab-explainer", errors)
    frame.locator("#cronTimeZone").select_option("utc")
    frame.locator("#cronFrom").fill("2026-10-28T08:59")
    frame.locator("#cronCount").select_option("10")
    frame.locator("#cronInput").fill("0 9 1-31 * MON")
    frame.locator("#cronExplainBtn").click()
    expect(frame.locator("#cronUpcoming li")).to_have_count(10)

    # A fully enumerated date field is restricted, so its OR with Monday
    # matches October 28 (Wednesday), rather than skipping to next Monday.
    expect(frame.locator("#cronUpcoming li").first).to_contain_text("10")
    expect(frame.locator("#cronUpcoming li").first).to_contain_text("28")
    expect(frame.locator("#cronSummary")).to_contain_text("或")
    frame.locator("#cronCopyBtn").click()
    assert clipboard(page) == "0 9 1-31 * MON"
    frame.locator("#cronCopyScheduleBtn").click()
    assert "2026" in clipboard(page) and any(zone in clipboard(page) for zone in ("UTC", "GMT"))
    saved = frame.evaluate("window.__DTKIT_TOOL_PAGE__.snapshot()")
    assert saved["state"] is not None
    frame.locator("#cronInput").fill("@daily")
    frame.locator("#cronTimeZone").select_option("local")
    frame.locator("#cronCount").select_option("5")
    frame.evaluate("saved => window.__DTKIT_TOOL_PAGE__.restore(saved)", saved)
    expect(frame.locator("#cronInput")).to_have_value("0 9 1-31 * MON")
    expect(frame.locator("#cronTimeZone")).to_have_value("utc")
    expect(frame.locator("#cronCount")).to_have_value("10")
    expect(frame.locator("#cronUpcoming li")).to_have_count(10)
    restore_after_reload(page, saved)
    expect(frame.locator("#cronInput")).to_have_value("0 9 1-31 * MON")
    expect(frame.locator("#cronTimeZone")).to_have_value("utc")
    expect(frame.locator("#cronFrom")).to_have_value("2026-10-28T08:59")
    expect(frame.locator("#cronUpcoming li")).to_have_count(10)

    frame.locator("#cronInput").fill("*/35 * * * *")
    frame.locator("#cronExplainBtn").click()
    expect(frame.locator("#cronSummary")).not_to_have_text("每 35 分钟")
    frame.locator("#cronInput").fill("0 0 31 2 *")
    frame.locator("#cronExplainBtn").click()
    expect(frame.locator("#cronScheduleNote")).to_contain_text("没有找到")
    expect(frame.locator("#cronUpcoming li")).to_have_count(0)
    expect(frame.locator("#cronCopyScheduleBtn")).to_be_disabled()
    frame.locator("#cronInput").fill("0x10 * * * *")
    frame.locator("#cronExplainBtn").click()
    expect(frame.locator("#cronError")).to_be_visible()
    page.close()


def choose_unit(frame, field_id, unit_id):
    combo = frame.locator(f'[data-unit-combobox="{field_id}"]')
    combo.locator(".unit-combobox__trigger").click()
    combo.locator(f'[data-unit-option="{unit_id}"]').click()


def test_unit_features(context, base_url, errors):
    page, frame = open_tool(context, base_url, "unit-converter", errors)
    frame.locator('[data-unit-category="length"]').click()
    choose_unit(frame, "unitFrom", "m")
    choose_unit(frame, "unitTo", "ft")
    frame.locator("#unitInput").fill("1")
    frame.locator("#unitPrecision").select_option("6")
    expect(frame.locator("#unitOutput")).to_have_value("3.28084")
    frame.locator("#unitCopyEquationBtn").click()
    assert "3.28084" in clipboard(page) and "ft" in clipboard(page)
    frame.locator("#unitSwapBtn").click()
    expect(frame.locator("#unitOutput")).to_have_value("1")

    for invalid in ("   ", "0x10", "1,2", "Infinity"):
        frame.locator("#unitInput").fill(invalid)
        expect(frame.locator("#unitOutput")).to_have_value("")
        expect(frame.locator("#unitCopyEquationBtn")).to_be_disabled()
    frame.locator("#unitInput").fill("1e2")
    assert frame.locator("#unitOutput").input_value()

    frame.locator('[data-unit-category="mass"]').click()
    choose_unit(frame, "unitFrom", "kg")
    choose_unit(frame, "unitTo", "kg")
    frame.locator("#unitInput").fill("1e308")
    assert frame.locator("#unitOutput").input_value(), "Overflow in an overview row hid a valid main result"
    expect(frame.locator("#unitOverviewList")).to_contain_text("超出")
    expect(frame.locator("#unitCopyEquationBtn")).to_be_enabled()

    frame.locator('[data-unit-category="volume"]').click()
    choose_unit(frame, "unitFrom", "l")
    choose_unit(frame, "unitTo", "ml")
    frame.locator("#unitInput").fill("2.5")
    frame.locator("#unitPrecision").select_option("15")
    expect(frame.locator("#unitOutput")).to_have_value("2500")
    expect(frame.locator("#unitFormula")).to_contain_text("1000")
    saved = frame.evaluate("window.__DTKIT_TOOL_PAGE__.snapshot()")
    assert saved["state"] is not None and saved["canRelease"] is True
    restore_after_reload(page, saved)
    expect(frame.locator("#unitInput")).to_have_value("2.5")
    expect(frame.locator("#unitPrecision")).to_have_value("15")
    expect(frame.locator("#unitOutput")).to_have_value("2500")
    expect(frame.locator('[data-unit-category="volume"]')).to_have_attribute("aria-selected", "true")

    # Search, arrow movement, Enter selection and Escape focus recovery.
    combo = frame.locator('[data-unit-combobox="unitTo"]')
    trigger = combo.locator(".unit-combobox__trigger")
    trigger.click()
    search = combo.locator(".unit-combobox__search input")
    search.fill("美制")
    expect(combo.locator("[data-unit-option]")).to_have_count(1)
    search.press("ArrowDown")
    page.keyboard.press("Enter")
    assert "gal" in frame.locator("#unitEquation").inner_text()
    trigger.click()
    search.press("Escape")
    expect(trigger).to_be_focused()
    page.close()


def run(base_url):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1366, "height": 900}, color_scheme="light", reduced_motion="reduce")
        context.add_init_script(multi.MOCK)
        context.add_init_script("""(() => {
          window.__utilityClipboard=[];
          Object.defineProperty(navigator,'clipboard',{configurable:true,
            value:{writeText:async value=>{window.__utilityClipboard.push(String(value));}}});
        })();""")

        def apply_csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if "text/html" in headers.get("content-type", ""):
                headers["content-security-policy"] = multi.CSP
            route.fulfill(response=response, headers=headers)

        context.route(base_url + "/**", apply_csp)
        try:
            print("Utility tools: original workflows in quick and embedded hosts", flush=True)
            test_original_behaviors(context, base_url, errors)
            print("Utility tools: form coding, line errors, query inspection and state restore", flush=True)
            test_url_features(context, base_url, errors)
            print("Utility tools: calendar matching, controlled schedules and invalid input", flush=True)
            test_cron_features(context, base_url, errors)
            print("Utility tools: precision, strict numbers, overflow, unit keyboard and cold restore", flush=True)
            test_unit_features(context, base_url, errors)
            print("Utility tools: responsive light and dark workspaces", flush=True)
            test_layout(context, base_url, errors)
            assert not errors, errors
        except Exception:
            for index, page in enumerate(context.pages):
                page.screenshot(path=str(ARTIFACTS / f"failure-{index}.png"), full_page=True)
            raise
        finally:
            context.close()
            browser.close()
    print(f"Utility tools UI smoke passed; screenshots={ARTIFACTS}", flush=True)


if __name__ == "__main__":
    with multi.production_url() as base_url:
        run(base_url)
