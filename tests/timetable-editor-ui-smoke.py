"""Exercise timetable editor previews, week selection and interruptible panels under production CSP."""
import importlib.util
import json
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
OUT = multi.ROOT / '.tmp' / 'timetable-editor-review'
OUT.mkdir(parents=True, exist_ok=True)
FIXED_DATE = r"""const OriginalDate=Date;window.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:['2026-10-05T08:20:00+08:00']))}static now(){return new OriginalDate('2026-10-05T08:20:00+08:00').getTime()}};"""


def action(page, name):
    page.locator('[data-tool-page-toggle]').click()
    page.locator(f'[data-tool-action="{name}"]').click()


def close(frame):
    frame.locator('#ttDialog [data-tt-action="close"]').first.click()
    expect(frame.locator('#ttDialog')).to_be_hidden()


def saved(page):
    return page.evaluate("JSON.parse(localStorage.getItem('dtkit_timetable_v1'))")


def settle(frame):
    frame.wait_for_function("() => !document.querySelector('[data-tt-snapshot]') && ![...document.getAnimations()].some(a=>a.playState==='running')")


def run(base, reduced=False):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Shanghai', reduced_motion='reduce' if reduced else 'no-preference')
        context.add_init_script(multi.MOCK)
        context.add_init_script(FIXED_DATE)
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
            page.locator('[data-tool-id="timetable"] .tool-card__title').click()
            frame = multi.active_tool_frame(page, '.tt-shell')
            odds = ','.join(str(week) for week in range(1, 21, 2))
            evens = ','.join(str(week) for week in range(2, 21, 2))
            csv = '课程名称,星期,开始节,结束节,周次,教室,教师,颜色,备注\n' + f'高等数学,1,1,2,"{odds}",A-201,李老师,blue,带教材\n高等数学,3,5,6,1-20,机房 B-305,王老师,green,带电脑\n物理,1,1,2,"{evens}",C-405,张老师,purple,预习第二章\n'
            frame.locator('#ttImportFile').set_input_files({'name': '编辑验证.csv', 'mimeType': 'text/csv', 'buffer': csv.encode()})
            frame.get_by_role('button', name='确认导入', exact=True).click()
            expect(frame.locator('#ttDialog')).to_be_hidden()

            action(page, 'manage')
            group = frame.locator('#ttCourseList .tt-course-group').filter(has_text='高等数学')
            group.locator('summary').click()
            group.locator('[data-tt-action="edit-group"]').click()
            form = frame.locator('#ttCourseForm')
            preview = form.locator('#ttCourseLivePreview')
            expect(preview).to_have_attribute('data-tone', 'success')
            expect(form.locator('.tt-extra-arrangement')).to_have_count(1)
            primary = form.locator('[data-week-picker]').first
            extra = form.locator('.tt-extra-arrangement').first
            secondary = extra.locator('[data-week-picker]')
            expect(primary.locator('[data-week-preset="odd"]')).to_have_attribute('aria-pressed', 'true')
            assert primary.locator('[data-week][tabindex="0"]').count() == 1
            # A grouped edit must not collide with the original records being replaced.
            primary.locator('[data-week-preset="odd"]').click()
            expect(form.locator('#ttCourseParity')).to_have_value('odd')
            expect(preview).to_have_attribute('data-tone', 'success')
            primary.locator('[data-week="2"]').click()
            expect(form.locator('#ttCourseParity')).to_have_value('all')
            expect(primary.locator('[data-week="2"]')).to_have_attribute('aria-pressed', 'true')
            expect(preview).to_have_attribute('data-tone', 'warning')
            expect(preview).to_contain_text('第 2 周，与「物理」冲突')
            primary.locator('[data-week="2"]').press('ArrowRight')
            expect(primary.locator('[data-week="3"]')).to_be_focused()
            primary.locator('[data-week="3"]').press('Space')
            expect(primary.locator('[data-week="3"]')).to_have_attribute('aria-pressed', 'false')
            expect(form.locator('#ttCourseWeeks')).to_have_value('1-2,5,7,9,11,13,15,17,19')
            primary.locator('[data-week="3"]').press('End')
            expect(primary.locator('[data-week="20"]')).to_be_focused()
            primary.locator('[data-week="20"]').press('Home')
            expect(primary.locator('[data-week="1"]')).to_be_focused()
            primary.locator('[data-week-preset="odd"]').click()
            secondary.locator('[data-week-preset="even"]').click()
            expect(form.locator('#ttCourseParity')).to_have_value('odd')
            expect(extra.locator('[data-schedule="parity"]')).to_have_value('even')
            expect(primary.locator('.tt-week-count')).to_contain_text('已选 10 / 20 周')
            expect(secondary.locator('.tt-week-count')).to_contain_text('已选 10 / 20 周')
            expect(preview).to_contain_text('全学期 20 次上课 · 40 节')
            form.locator('#ttCourseWeeks').fill('0')
            expect(preview).to_have_attribute('data-tone', 'error')
            expect(form.locator('#ttCourseWeeks')).to_have_attribute('aria-invalid', 'true')
            primary.locator('[data-week="5"]').click()
            expect(form.locator('#ttCourseWeeks')).to_have_value('5')
            expect(preview).to_have_attribute('data-tone', 'success')
            primary.locator('[data-week-preset="odd"]').click()
            # Preview updates do not replace the focused input or its caret selection.
            form.locator('#ttCourseName').focus()
            form.locator('#ttCourseName').evaluate("n=>{n.setSelectionRange(1,3);n.dispatchEvent(new Event('input',{bubbles:true}))}")
            expect(form.locator('#ttCourseName')).to_be_focused()
            assert form.locator('#ttCourseName').evaluate('n=>[n.selectionStart,n.selectionEnd]') == [1, 3]
            page.screenshot(path=str(OUT / ('editor-reduced.png' if reduced else 'editor-desktop.png')))
            form.get_by_role('button', name='保存课程', exact=True).click()
            expect(frame.locator('#ttDialog')).to_be_hidden()
            records = [course for course in saved(page)['semester']['courses'] if course['name'] == '高等数学']
            assert len(records) == 2
            assert next(course for course in records if course['day'] == 1)['weeks'] == list(range(1, 21, 2))
            assert next(course for course in records if course['day'] == 3)['weeks'] == list(range(2, 21, 2))
            assert {course['room'] for course in records} == {'A-201', '机房 B-305'}
            assert {course['teacher'] for course in records} == {'李老师', '王老师'}
            assert {course['notes'] for course in records} == {'带教材', '带电脑'}

            before = json.dumps(saved(page), sort_keys=True)
            frame.locator('.tt-header [data-tt-action="add"]').click()
            form = frame.locator('#ttCourseForm')
            form.locator('#ttCourseName').fill('草稿冲突验证')
            form.locator('#ttCourseDay').select_option('2')
            expect(form.locator('#ttCourseLivePreview')).to_have_attribute('data-tone', 'success')
            form.locator('[data-tt-action="add-arrangement"]').click()
            expect(form.locator('.tt-extra-arrangement')).to_have_count(1)
            expect(form.locator('#ttCourseLivePreview')).to_have_attribute('data-tone', 'warning')
            expect(form.locator('#ttCourseLivePreview')).to_contain_text('草稿冲突验证')
            form.locator('.tt-extra-arrangement [data-schedule="day"]').select_option('4')
            expect(form.locator('#ttCourseLivePreview')).to_have_attribute('data-tone', 'success')
            immediate_preview = form.locator('[data-tt-action="remove-arrangement"]').evaluate("""n=>{n.click();return new Promise(resolve=>queueMicrotask(()=>queueMicrotask(()=>resolve(document.querySelector('#ttCourseLivePreview small').textContent))))}""")
            assert '1 条安排' in immediate_preview, immediate_preview
            expect(form.locator('.tt-extra-arrangement')).to_have_count(0)
            expect(form.locator('#ttCourseLivePreview')).to_contain_text('1 条安排')
            close(frame)
            assert json.dumps(saved(page), sort_keys=True) == before

            action(page, 'settings')
            original_name = frame.locator('#ttSemesterName').input_value()
            frame.locator('#ttSemesterName').fill('尚未保存的学期名称')
            frame.locator('[data-tab="features"]').click()
            frame.locator('#ttBackground').select_option('lavender')
            # Rapid opposing intents must settle to one interactive panel.
            frame.evaluate("""() => {for(const tab of ['basic','features','transfer','other','features']) document.querySelector(`[data-tab="${tab}"]`).click()}""")
            settle(frame)
            expect(frame.locator('[data-tab="features"]')).to_have_attribute('aria-selected', 'true')
            expect(frame.locator('#ttSection-features')).to_be_visible()
            assert frame.locator('.tt-settings-section:not([hidden]):not([inert])').count() == 1
            assert frame.locator('#ttSemesterName').input_value() == '尚未保存的学期名称'
            expect(frame.locator('#ttBackground')).to_have_value('lavender')
            # Validation must reveal and focus an invalid field in a different tab.
            frame.locator('#ttSemesterName').evaluate("n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}))}")
            frame.get_by_role('button', name='保存设置', exact=True).click()
            expect(frame.locator('[data-tab="basic"]')).to_have_attribute('aria-selected', 'true')
            expect(frame.locator('#ttSemesterName')).to_be_focused()
            frame.locator('#ttSemesterName').fill(original_name)
            frame.locator('[data-tab="features"]').click()
            expect(frame.locator('#ttBackground')).to_have_value('lavender')
            close(frame)
            assert json.dumps(saved(page), sort_keys=True) == before

            frame.locator('.tt-header [data-tt-action="add"]').click()
            # A host action can reopen a panel while its close animation is still in progress.
            frame.evaluate("""() => {for(let i=0;i<6;i++){document.querySelector('#ttDialog [data-tt-action="close"]').click();document.querySelector('.tt-header [data-tt-action="add"]').click()}}""")
            settle(frame)
            expect(frame.locator('#ttDialog')).to_be_visible()
            expect(frame.locator('#ttCourseName')).to_be_focused()
            expect(frame.locator('#ttCourseForm')).to_have_count(1)
            assert frame.locator('[data-tt-snapshot]').count() == 0
            frame.locator('#ttCourseName').fill('窄窗口周次验证')
            page.set_viewport_size({'width': 390, 'height': 820})
            frame.evaluate('() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            form = frame.locator('#ttCourseForm')
            picker = form.locator('[data-week-picker]').first
            picker.locator('[data-week="1"]').focus()
            picker.locator('[data-week="1"]').press('ArrowDown')
            focused = picker.locator('[data-week]').evaluate_all("nodes=>nodes.find(n=>n===document.activeElement)?.dataset.week")
            assert focused and int(focused) > 1
            assert picker.locator('.tt-week-chips').evaluate('n=>n.scrollWidth<=n.clientWidth+1')
            assert frame.locator('#ttDialog').evaluate('n=>{const r=n.getBoundingClientRect();return r.left>=-1 && r.right<=innerWidth+1}')
            page.screenshot(path=str(OUT / ('editor-narrow-reduced.png' if reduced else 'editor-narrow.png')))
            close(frame)
            assert json.dumps(saved(page), sort_keys=True) == before
            assert not errors, errors
            print(f'PASS: timetable editor presets, keyboard, independent arrangements, precise conflicts, grouped edits, validation and reversible panels ({"reduced motion" if reduced else "motion"})')
        except Exception:
            page.screenshot(path=str(OUT / ('failure-reduced.png' if reduced else 'failure.png')))
            raise
        finally:
            context.close()
            browser.close()


if __name__ == '__main__':
    with multi.production_url() as base:
        run(base)
        run(base, reduced=True)
