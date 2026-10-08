"""Verify floating tool controls and the timetable's primary reading surface."""
import importlib.util
import re
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
OUT = multi.SCREENSHOTS

def run(base):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1536, 'height': 800}, timezone_id='Asia/Shanghai')
        context.add_init_script(multi.MOCK)
        def csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if 'text/html' in headers.get('content-type', ''):
                headers['content-security-policy'] = multi.CSP
            route.fulfill(response=response, headers=headers)
        context.route(base + '/**', csp)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        try:
            page.goto(base, wait_until='networkidle')
            toggle = page.locator('[data-tool-page-toggle]')
            panel = page.locator('.tool-page-toolbar')
            expect(toggle).to_be_hidden()
            page.locator('[data-tool-id="timetable"] .tool-card__title').click()
            frame = multi.active_tool_frame(page, '.tt-shell')
            surface = page.locator('iframe.tool-page-frame:not([hidden])')
            page.wait_for_timeout(350)
            expect(panel).to_be_hidden()
            for width, height in [(1920, 1080), (1536, 800), (1280, 720), (1000, 700), (760, 600), (480, 720), (390, 700)]:
                page.set_viewport_size({'width': width, 'height': height})
                page.wait_for_timeout(80)
                outer, inner = page.locator('#contentArea').bounding_box(), surface.bounding_box()
                board = frame.locator('#ttBoard').bounding_box()
                assert abs(outer['width'] - inner['width']) <= 1, (outer, inner)
                assert 0 <= board['y'] - inner['y'] <= 65, (board, inner)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                if height >= 800:
                    assert board['y'] + board['height'] <= inner['y'] + inner['height'] + 1, (board, inner)
                    footer = frame.locator('.tt-footer').bounding_box()
                    assert footer['y'] + footer['height'] <= inner['y'] + inner['height'] + 1
                toggle.click()
                expect(panel).to_be_visible()
                opened = surface.bounding_box()
                assert all(abs(opened[key] - inner[key]) <= 1 for key in ['x', 'y', 'width', 'height']), (inner, opened)
                expect(page.locator('[data-tool-action="import"]')).to_be_visible()
                expect(page.locator('[data-tool-action="settings"]')).to_be_visible()
                pbox = panel.bounding_box()
                assert pbox['x'] >= outer['x'] and pbox['x'] + pbox['width'] <= outer['x'] + outer['width']
                assert pbox['y'] + pbox['height'] <= outer['y'] + outer['height'] + 1
                page.keyboard.press('Escape')
                expect(panel).to_be_hidden()
                expect(toggle).to_be_focused()
            page.set_viewport_size({'width': 1536, 'height': 800})
            toggle.click()
            frame.locator('#ttWeek').click()
            expect(panel).to_be_hidden()
            page.keyboard.press('Escape')
            toggle.click()
            record = page.locator('.tool-page-shortcut .shortcut-binding__record')
            record.click()
            expect(record).to_have_class(re.compile('is-recording'))
            page.locator('.tool-page-toolbar__close').click()
            expect(record).not_to_have_class(re.compile('is-recording'))
            expect(panel).to_be_hidden()
            # The moved import control must retain file-picker user activation.
            toggle.click()
            with page.expect_file_chooser() as chooser:
                page.locator('[data-tool-action="import"]').click()
            csv = '课程名称,星期,开始节,结束节,周次,教室,教师,颜色,备注\n高等数学,1,1,2,1-20,A-302,李老师,blue,\n程序设计,2,3,4,1-20,机房201,张老师,purple,\n大学英语,3,1,2,1-20,B-201,王老师,green,\n线性代数,4,5,6,1-20,A-305,李老师,cyan,\n大学物理,5,3,4,1-20,C-406,陈老师,orange,\n体育,3,7,8,1-20,田径场,赵老师,rose,\n'
            chooser.value.set_files({'name': 'courses.csv', 'mimeType': 'text/csv', 'buffer': csv.encode('utf-8')})
            expect(panel).to_be_hidden()
            frame.locator('#ttDialog').wait_for(state='visible')
            expect(frame.locator('#ttDialogTitle')).to_have_text('导入预览')
            expect(frame.locator('.tt-course')).to_have_count(0)
            frame.get_by_role('button', name='确认导入', exact=True).click()
            expect(frame.locator('.tt-course')).to_have_count(6)
            expect(page.locator('.dtkit-toast')).to_be_hidden(timeout=5000)
            board = frame.locator('#ttBoard').bounding_box()
            viewport = surface.bounding_box()
            assert board['y'] - viewport['y'] <= 65
            assert board['y'] + board['height'] <= viewport['y'] + viewport['height'] + 1
            page.screenshot(path=str(OUT / 'dtkit-timetable-floating-closed.png'))
            toggle.click()
            page.screenshot(path=str(OUT / 'dtkit-timetable-floating-open.png'))
            page.keyboard.press('Escape')
            toggle.click()
            page.locator('[data-tool-action="manage"]').click()
            expect(frame.locator('#ttDialogTitle')).to_have_text('管理课程')
            frame.locator('[data-tt-action="close"]').first.click()
            frame.locator('[data-tt-action="add"]').first.click()
            expect(frame.locator('#ttDialog')).to_be_visible()
            page.screenshot(path=str(OUT / 'dtkit-timetable-floating-dialog.png'))
            frame.locator('[data-tt-action="close"]').first.click()
            toggle.click()
            page.locator('[data-tool-action="transfer"]').click()
            expect(frame.locator('#ttSection-transfer')).to_be_visible()
            frame.locator('[data-tt-action="close"]').first.click()
            multi.click_page_action(page, 'new')
            multi.active_tool_frame(page, '.tt-shell')
            expect(panel).to_be_hidden()
            page.locator('[data-view="toolLibrary"]').click()
            expect(toggle).to_be_hidden()
            # Standalone timetable uses the same compact content and a local panel.
            page.goto(base + '/quick.html?kind=tool&toolId=timetable', wait_until='networkidle')
            expect(page.locator('#ttLocalPanel')).to_be_hidden()
            page.locator('#ttToolsToggle').click()
            expect(page.locator('#ttLocalPanel')).to_be_visible()
            page.keyboard.press('Escape')
            expect(page.locator('#ttToolsToggle')).to_be_focused()
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(OUT / 'dtkit-floating-panel-failure.png'))
            raise
        finally:
            context.close()
            browser.close()

if __name__ == '__main__':
    with multi.production_url() as base:
        run(base)
    print('Floating panel UI: full-width content, seven viewport sizes, compact timetable, keyboard/outside dismissal, import, page actions and quick entry passed')
