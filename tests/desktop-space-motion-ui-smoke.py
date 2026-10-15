"""Production-CSP regression for continuous desktop motion and glass layout cost.

The comparison replays the same glass poses using the former animated layout
properties in a disposable page; it never changes application source or Windows.
Run after npm run build.
"""

import importlib.util
import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("host_smoke", ROOT / "tests/desktop-host-ui-smoke.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
OUT = Path(tempfile.mkdtemp(prefix="dtkit-desktop-motion-"))

PROBE = r"""
window.__glassAnimations = [];
const animate = Element.prototype.animate;
Element.prototype.animate = function(frames, timing) {
    if (this.classList.contains('space-motion-material')) {
        if (window.__layoutGlass) {
            const x = parseFloat(this.style.left), y = parseFloat(this.style.top);
            const width = parseFloat(this.style.width), height = parseFloat(this.style.height);
            frames = frames.map(frame => {
                const matrix = new DOMMatrix(frame.transform);
                return {offset: frame.offset, left: `${x + matrix.e}px`, top: `${y + matrix.f}px`,
                    width: `${width * matrix.a}px`, height: `${height * matrix.d}px`,
                    borderRadius: `${parseFloat(frame.borderRadius) * matrix.a}px`, opacity: frame.opacity};
            });
        }
        window.__glassAnimations.push({keys: Object.keys(frames[0]), duration: timing.duration});
    }
    return animate.call(this, frames, timing);
};
"""


def metrics(cdp):
    return {item["name"]: item["value"] for item in cdp.send("Performance.getMetrics")["metrics"]}


def main():
    base, close_server = host.helper.local_test_url()
    policy = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["app"]["security"]["csp"]
    errors, report = [], {}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)

            def open_page(layout_glass=False):
                context = browser.new_context(viewport={"width": 1440, "height": 900})
                context.add_init_script(host.helper.MOCK_TAURI + "\n" + host.SEED + "\n" + PROBE
                                        + f"\nwindow.__layoutGlass={str(layout_glass).lower()};")

                def production_policy(route):
                    response = route.fetch()
                    headers = dict(response.headers)
                    headers["content-security-policy"] = policy
                    route.fulfill(response=response, headers=headers)

                context.route("**/desktop-organizer/index.html*", production_policy)
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(base + host.HOST_PATH, wait_until="networkidle")
                page.wait_for_function("() => Number(getComputedStyle(document.querySelector('#panel')).opacity) === 1")
                page.wait_for_timeout(500)
                return context, page

            for mode in ("layout", "transform"):
                context, page = open_page(mode == "layout")
                cdp = context.new_cdp_session(page)
                cdp.send("Performance.enable")
                before = metrics(cdp)
                page.evaluate("""async () => {
                    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
                    const trigger = document.querySelector('.space-block[data-space-group="document"] .space-folder-surface');
                    for (let i = 0; i < 5; i++) {
                        trigger.click(); await wait(460);
                        document.querySelector('.space-popup [data-space-close]').click(); await wait(310);
                    }
                }""")
                after = metrics(cdp)
                report[mode] = {key: round((after[key] - before[key]) * (1000 if key.endswith("Duration") else 1), 3)
                                for key in ("LayoutCount", "LayoutDuration", "RecalcStyleCount", "RecalcStyleDuration")}
                animations = page.evaluate("() => window.__glassAnimations")
                assert len(animations) == 10, animations
                assert [item["duration"] for item in animations] == [420, 270] * 5, animations
                if mode == "transform":
                    assert all(not set(item["keys"]) & {"left", "top", "width", "height"} for item in animations)
                assert not page.evaluate("() => window.__cspViolations"), page.evaluate("() => window.__cspViolations")
                context.close()

            assert report["transform"]["LayoutCount"] <= report["layout"]["LayoutCount"] * .5, report
            context, page = open_page()
            continuity = page.evaluate("""async () => {
                const popup = document.querySelector('.space-popup');
                const trigger = document.querySelector('.space-block[data-space-group="document"] .space-folder-surface');
                const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
                const rect = node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
                const paint = () => ({rect:rect(document.querySelector('.space-motion-material') || popup),
                    opacity:Number(getComputedStyle(popup).opacity), contents:[...popup.children].map(node => ({
                        opacity:Number(getComputedStyle(node).opacity), rect:rect(node)}))});
                const pairs = [], scaled = [];
                let tracking = true;
                const sample = () => {
                    for (const node of [popup,...popup.children]) {
                        const transform = getComputedStyle(node).transform;
                        const matrix = new DOMMatrix(transform === 'none' ? undefined : transform);
                        if (Math.abs(matrix.a-1) > .0001 || Math.abs(matrix.d-1) > .0001 || matrix.b || matrix.c)
                            scaled.push({className:node.className,transform});
                    }
                    if (tracking) requestAnimationFrame(sample);
                };
                trigger.click();
                const immediate = !popup.hidden && !!document.querySelector('.space-motion-material');
                requestAnimationFrame(sample);
                await wait(110);
                const opening = paint(); popup.querySelector('[data-space-close]').click();
                pairs.push({action:'opening-to-close', before:opening, after:paint()});
                await wait(65);
                const closing = paint(), children = [...popup.children]; trigger.click();
                pairs.push({action:'closing-to-open', before:closing, after:paint()});
                const retainedContents = children.every((node,index) => popup.children[index] === node);
                await wait(80);
                const reopening = paint(); popup.querySelector('[data-space-close]').click();
                pairs.push({action:'reopening-to-close', before:reopening, after:paint()});
                await wait(320); tracking = false;
                return {immediate, retainedContents, scaled, pairs, hidden:popup.hidden,
                    orphanMaterials:document.querySelectorAll('.space-motion-material').length};
            }""")
            assert continuity["immediate"] and continuity["retainedContents"] and continuity["hidden"], continuity
            assert not continuity["scaled"] and not continuity["orphanMaterials"], continuity
            for pair in continuity["pairs"]:
                before, after = pair["before"], pair["after"]
                assert max(abs(before["rect"][key] - after["rect"][key]) for key in before["rect"]) < .5, pair
                assert abs(before["opacity"] - after["opacity"]) < .01, pair
                for old, new in zip(before["contents"], after["contents"]):
                    assert abs(old["opacity"] - new["opacity"]) < .01, pair
                    assert max(abs(old["rect"][key] - new["rect"][key]) for key in old["rect"]) < .5, pair
            report["interruptions"] = continuity

            switched = page.evaluate("""async () => {
                const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
                document.querySelector('.space-block[data-space-group="document"] .space-folder-surface').click(); await wait(460);
                const popup = document.querySelector('.space-popup'), before = popup.getBoundingClientRect().toJSON();
                document.querySelector('.space-block[data-space-group="image"] .space-folder-surface').click();
                const after = document.querySelector('.space-motion-material').getBoundingClientRect().toJSON();
                await wait(460); popup.querySelector('[data-space-close]').click(); await wait(310);
                return {before,after};
            }""")
            assert max(abs(switched["before"][key] - switched["after"][key]) for key in ("x", "y", "width", "height")) < .5, switched
            report["settledGroupSwitch"] = switched

            hover = []
            for block in page.locator(".space-block").all()[:3]:
                box = block.bounding_box()
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 40)
                assert "is-hovered" in block.get_attribute("class"), "Hover kept a dwell delay"
                page.wait_for_timeout(45)
                hover.append(block.locator(".space-folder-surface").evaluate("node => Number(getComputedStyle(node,'::after').opacity)"))
            page.mouse.move(40, 40)
            page.wait_for_timeout(280)
            assert not page.locator(".space-block.is-hovered").count()
            assert all(0 < opacity < .65 for opacity in hover), hover
            report["hoverOpacitiesAt45ms"] = hover

            host.helper.choose(page, "layout", "drawer")
            host.close_appearance(page)
            host.settle(page)
            drawer = page.evaluate("""async () => {
                const handle = document.querySelector('.space-drawer-handle'), drawer = document.querySelector('.space-drawer');
                const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
                handle.click(); await wait(90); drawer.querySelector('[data-space-close]').click(); await wait(65);
                const material = document.querySelector('.space-motion-material'), before = material.getBoundingClientRect().toJSON();
                const opacity = Number(getComputedStyle(drawer).opacity); handle.click();
                const after = document.querySelector('.space-motion-material').getBoundingClientRect().toJSON();
                const afterOpacity = Number(getComputedStyle(drawer).opacity); await wait(470);
                return {before,after,opacity,afterOpacity,visible:!drawer.hidden,
                    materialCount:document.querySelectorAll('.space-motion-material').length};
            }""")
            assert drawer["visible"] and drawer["materialCount"] == 0, drawer
            assert abs(drawer["opacity"] - drawer["afterOpacity"]) < .01, drawer
            assert max(abs(drawer["before"][key] - drawer["after"][key]) for key in ("x", "y", "width", "height")) < .5, drawer
            report["drawerInterruption"] = drawer
            assert not page.evaluate("() => window.__cspViolations"), page.evaluate("() => window.__cspViolations")
            assert not errors, errors
            page.screenshot(path=str(OUT / "drawer.png"), omit_background=True)
            context.close()
            browser.close()
    finally:
        close_server()
    (OUT / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Desktop motion UI passed; layout={report['layout']}; transform={report['transform']}")
    print(f"Continuity: 3 popup reversals and drawer reversal <0.5px; content matrices retained scale 1; hover={report['hoverOpacitiesAt45ms']}")
    print(f"MOTION_REPORT={OUT / 'report.json'}")


if __name__ == "__main__":
    main()
