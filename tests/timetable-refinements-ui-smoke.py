"""Verify course groups, live preview, linked periods, details and sticky navigation."""
import importlib.util
import json
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
OUT = Path(__file__).parent / 'artifacts' / 'timetable-refinements'
OUT.mkdir(parents=True, exist_ok=True)
FIXED_DATE = r"""const OriginalDate=Date;window.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:['2026-10-09T08:20:00+08:00']))}static now(){return new OriginalDate('2026-10-09T08:20:00+08:00').getTime()}};"""


def action(page, name):
    page.locator('[data-tool-page-toggle]').click()
    page.locator(f'[data-tool-action="{name}"]').click()


def close(frame):
    frame.locator('[data-tt-action="close"]').first.click()


def saved(page):
    return page.evaluate("JSON.parse(localStorage.getItem('dtkit_timetable_v1'))")


def run(base):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1536, 'height': 800}, timezone_id='Asia/Shanghai')
        context.add_init_script(multi.MOCK)
        context.add_init_script(FIXED_DATE)
        def csp(route):
            response = route.fetch(); headers = dict(response.headers)
            if 'text/html' in headers.get('content-type', ''):
                headers['content-security-policy'] = multi.CSP
            route.fulfill(response=response, headers=headers)
        context.route(base + '/**', csp)
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        try:
            page.goto(base, wait_until='networkidle')
            page.locator('[data-tool-id="timetable"] .tool-card__title').click()
            frame = multi.active_tool_frame(page, '.tt-shell')
            csv = '课程名称,星期,开始节,结束节,周次,教室,教师,颜色,备注\n数学基础,5,1,2,1-20,A-201,李老师,blue,带教材\n数学基础,3,5,6,1-20,实验楼 B-305,王老师,green,带电脑\n物理,5,3,4,1-20,C-405,张老师,purple,预习第二章\n'
            frame.locator('#ttImportFile').set_input_files({'name': '安排.csv', 'mimeType': 'text/csv', 'buffer': csv.encode()})
            frame.get_by_role('button', name='确认导入', exact=True).click()
            expect(frame.locator('#ttDialog')).not_to_be_visible()
            expect(frame.locator('.tt-course[data-status="正在上课"]')).to_contain_text('数学基础')
            expect(frame.locator('.tt-course[data-status="下一节"]')).to_contain_text('物理')
            current = frame.locator('.tt-course[data-status="正在上课"]')
            current.hover()
            expect(frame.locator('#ttCourseDetail')).to_be_visible()
            expect(frame.locator('#ttCourseDetail')).to_contain_text('带教材')
            expect(frame.locator('#ttCourseDetail')).to_contain_text('A-201')
            page.screenshot(path=str(OUT / 'reading.png'))
            page.keyboard.press('Escape')
            expect(frame.locator('#ttCourseDetail')).to_be_hidden()
            current.focus()
            expect(frame.locator('#ttCourseDetail')).to_be_visible()
            frame.locator('#ttWeek').focus()
            expect(frame.locator('#ttCourseDetail')).to_be_hidden()
            frame.locator('#ttWeek').select_option('2')
            expect(frame.locator('.tt-course[data-status="正在上课"]')).to_have_count(0)
            frame.locator('[data-tt-action="today"]').click()
            action(page, 'manage')
            expect(frame.locator('.tt-course-group')).to_have_count(2)
            group = frame.locator('.tt-course-group').filter(has_text='数学基础')
            group.locator('summary').click()
            expect(group.locator('.tt-course-row')).to_have_count(2)
            page.screenshot(path=str(OUT / 'groups.png'))
            group.locator('[data-tt-action="edit-group"]').click()
            expect(frame.locator('.tt-extra-arrangement')).to_have_count(1)
            frame.locator('#ttCourseName').fill('高等数学')
            frame.locator('#ttCourseTeacher').fill('陈老师')
            frame.locator('[name="ttCourseColor"][value="rose"]').check()
            frame.get_by_role('button', name='保存课程', exact=True).click()
            expect(frame.locator('#ttDialog')).not_to_be_visible()
            records = [r for r in saved(page)['semester']['courses'] if r['name'] == '高等数学']
            assert len(records) == 2 and all(r['teacher'] == '陈老师' and r['color'] == 'rose' for r in records)
            assert {r['room'] for r in records} == {'A-201', '实验楼 B-305'}
            assert {r['notes'] for r in records} == {'带教材', '带电脑'}
            frame.locator('[data-tt-action="add"]').first.click()
            frame.locator('#ttCourseStart').select_option('5')
            expect(frame.locator('#ttCourseEnd')).to_have_value('6')
            frame.locator('#ttCourseStart').select_option('12')
            expect(frame.locator('#ttCourseEnd')).to_have_value('12')
            frame.locator('[data-tt-action="add-arrangement"]').click()
            row = frame.locator('.tt-extra-arrangement')
            row.locator('[data-schedule="start"]').select_option('3')
            expect(row.locator('[data-schedule="end"]')).to_have_value('3')
            row.locator('[data-schedule="end"]').select_option('2')
            expect(row.locator('[data-schedule="start"]')).to_have_value('2')
            close(frame)
            action(page, 'settings')
            frame.locator('[data-tab="features"]').click()
            before = json.dumps(saved(page), sort_keys=True)
            frame.locator('#ttBackground').select_option('lavender')
            expect(frame.locator('#ttAppearancePreview')).to_have_attribute('data-background', 'lavender')
            frame.locator('#ttBackgroundDim').evaluate("n=>{n.value='60';n.dispatchEvent(new Event('input',{bubbles:true}))}")
            expect(frame.locator('#ttBackgroundDimValue')).to_have_text('60%')
            frame.locator('#ttDensity').select_option('comfortable')
            expect(frame.locator('#ttAppearancePreview')).to_have_attribute('data-density', 'comfortable')
            page.screenshot(path=str(OUT / 'appearance.png'))
            close(frame)
            assert json.dumps(saved(page), sort_keys=True) == before
            action(page, 'settings'); frame.locator('[data-tab="features"]').click()
            frame.locator('#ttDensity').select_option('comfortable')
            frame.get_by_role('button', name='保存设置', exact=True).click()
            expect(frame.locator('#ttDialog')).not_to_be_visible()
            expect(frame.locator('#ttGrid')).to_have_attribute('data-density', 'comfortable')
            page.set_viewport_size({'width': 480, 'height': 700})
            scroll = frame.locator('.tt-board-scroll')
            expect(frame.locator('#ttScrollHint')).to_be_visible()
            heads = frame.locator('.tt-day-head').first
            initial_y = heads.bounding_box()['y']
            scroll.evaluate('n=>{n.scrollTop=250;n.scrollLeft=200}')
            assert abs(heads.bounding_box()['y'] - initial_y) <= 1
            ruler = frame.locator('.tt-ruler').bounding_box(); board = scroll.bounding_box()
            assert abs(ruler['x'] - board['x']) <= 1
            page.screenshot(path=str(OUT / 'narrow.png'))
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.reload(wait_until='networkidle')
            frame = multi.active_tool_frame(page, '.tt-shell')
            expect(frame.locator('#ttGrid')).to_have_attribute('data-density', 'comfortable')
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(OUT / 'failure.png'))
            raise
        finally:
            context.close(); browser.close()


if __name__ == '__main__':
    with multi.production_url() as base:
        run(base)
    print('PASS: grouped edits, independent rooms, linked periods, details, live preview, markers, density and sticky navigation')
