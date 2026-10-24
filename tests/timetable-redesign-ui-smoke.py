"""Production-CSP regression checks for the redesigned timetable and widget.

Uses a fresh browser profile and generated schedules. Native commands are mocked.
Run after npm run build; DTKIT_TEST_BASE_URL may select an existing preview server.
"""
import importlib.util
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
OUT = Path(__file__).resolve().parents[1] / '.tmp' / 'timetable-redesign'
OUT.mkdir(parents=True, exist_ok=True)
KEY = 'dtkit_timetable_v1'
CLOCK = r"""
(() => {
 const OriginalDate = Date;
 window.__ttNow = '2026-10-08T08:20:00+08:00';
 window.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [window.__ttNow])); }
  static now() { return new OriginalDate(window.__ttNow).getTime(); }
 };
})();
"""
GATE = r"""
window.__ttHoldWrites = false;
Object.defineProperty(navigator, 'locks', {configurable:true,value:{request:async (_name,callback) => {
 if (window.__ttHoldWrites) await new Promise(resolve => {window.__ttReleaseWrite = resolve});
 return callback();
}}});
"""


def fixture():
    periods = [
        ['08:00', '08:45'], ['08:55', '09:40'], ['10:00', '10:45'], ['10:55', '11:40'],
        ['14:00', '14:45'], ['14:55', '15:40'], ['16:00', '16:45'], ['16:55', '17:40'],
        ['19:00', '19:45'], ['19:55', '20:40'], ['20:50', '21:35'], ['21:45', '22:30']]

    def course(identifier, name, day, start, end, color, room, teacher, weeks=None):
        return dict(id=identifier, name=name, day=day, start=start, end=end, color=color,
                    room=room, teacher=teacher, notes='携带教材与笔记本', weeks=weeks or list(range(1, 21)))

    return dict(version=1, revision=1, settings=dict(
        showWeekend=True, showOtherWeeks=False, weekStartsOn=1, education='本科', density='compact',
        background=dict(preset='paper', image='', imageName='', fit='contain', dim=85),
        widgetMode='today', widgetPinned=False), semester=dict(
            id='generated-semester', name='秋日学习计划', startDate='2026-10-05', totalWeeks=20,
            periods=[dict(start=start, end=end) for start, end in periods], courses=[
                course('math', '高等数学', 4, 1, 2, 'blue', '理学楼 A-201', '陈老师'),
                course('physics', '大学物理', 4, 3, 4, 'purple', '实验楼 B-305', '李老师'),
                course('design', '交互设计', 4, 5, 6, 'green', '设计楼 C-108', '周老师'),
                course('coding', '程序设计', 2, 5, 6, 'orange', '机房 D-302', '林老师'),
                course('lab', '物理实验', 5, 7, 8, 'cyan', '实验楼 B-305', '李老师', list(range(1, 21, 2))),
                course('sport', '体育', 6, 3, 4, 'rose', '体育馆', '赵老师')]), archives=[])


def context_for(browser, base, viewport=None, reduced=False):
    context = browser.new_context(viewport=viewport or {'width': 1440, 'height': 960},
                                  timezone_id='Asia/Shanghai', reduced_motion='reduce' if reduced else 'no-preference')
    context.add_init_script(multi.MOCK)
    context.add_init_script(CLOCK)
    context.add_init_script(GATE)
    context.add_init_script(f"if (!localStorage.getItem('{KEY}')) localStorage.setItem('{KEY}', {json.dumps(json.dumps(fixture(), ensure_ascii=False))});")

    def csp(route):
        response = route.fetch()
        headers = dict(response.headers)
        if 'text/html' in headers.get('content-type', ''):
            headers['content-security-policy'] = multi.CSP
        route.fulfill(response=response, headers=headers)

    context.route(base + '/**', csp)
    return context


def monitor(page, errors):
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)


def widget_checks(browser, base):
    context = context_for(browser, base, {'width': 390, 'height': 800})
    page = context.new_page()
    errors = []
    monitor(page, errors)
    try:
        page.goto(base + '/timetable-widget.html', wait_until='networkidle')
        expect(page.locator('#ttWidgetCurrent')).to_have_text('高等数学')
        expect(page.locator('#ttWidgetPhase')).to_have_text('正在上课')
        expect(page.locator('#ttWidgetCountdown')).to_contain_text('25 分钟')
        expect(page.locator('#ttWidgetAgenda .tt-agenda-card')).to_have_count(3)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.evaluate("window.__agendaNode = document.querySelector('#ttWidgetAgenda').firstElementChild; dispatchEvent(new Event('focus'))")
        assert page.evaluate("window.__agendaNode === document.querySelector('#ttWidgetAgenda').firstElementChild")

        # Intent is immediate, even when a previous storage transaction is waiting.
        page.evaluate("window.__ttHoldWrites=true; document.querySelector('#ttWidgetMode').click()")
        expect(page.locator('#ttWidgetBoard')).to_be_visible()
        page.evaluate("document.querySelector('#ttWidgetMode').click();document.querySelector('#ttWidgetMode').click();document.querySelector('#ttWidgetMode').click()")
        expect(page.locator('#ttWidgetAgenda')).to_be_visible()
        page.evaluate("window.__ttHoldWrites=false;window.__ttReleaseWrite()")
        page.wait_for_function(f"()=>JSON.parse(localStorage.getItem('{KEY}')).revision >= 3")
        assert page.evaluate(f"JSON.parse(localStorage.getItem('{KEY}')).settings.widgetMode") == 'today'

        page.locator('#ttWidgetMode').click()
        expect(page.locator('#ttWidgetBoard')).to_be_visible()
        scroll = page.locator('#ttWidgetBoard .tt-board-scroll')
        scroll.evaluate('node=>{node.scrollLeft=100;node.scrollTop=80;window.__scroll=[node.scrollLeft,node.scrollTop];window.__gridFirst=document.querySelector("#ttWidgetGrid").firstElementChild}')
        scroll.focus()
        page.evaluate("dispatchEvent(new Event('focus'))")
        assert page.evaluate("window.__gridFirst===document.querySelector('#ttWidgetGrid').firstElementChild")
        assert scroll.evaluate('node=>node===document.activeElement')
        assert scroll.evaluate('node=>node.scrollLeft') == page.evaluate('__scroll[0]')
        # A real external data change redraws the courses while preserving the viewport.
        page.evaluate(f"""() => {{const data=JSON.parse(localStorage.getItem('{KEY}'));data.revision++;data.semester.courses[0].name='高等数学 · 修订';localStorage.setItem('{KEY}',JSON.stringify(data));dispatchEvent(new Event('dtkit:timetable-changed'));}}""")
        expect(page.locator('#ttWidgetGrid .tt-course').filter(has_text='高等数学 · 修订')).to_have_count(1)
        assert scroll.evaluate('node=>node.scrollLeft') == page.evaluate('__scroll[0]')

        # A short teaching break must not be reported as an ongoing lesson.
        page.evaluate("window.__ttNow='2026-10-08T08:50:00+08:00';dispatchEvent(new Event('focus'))")
        expect(page.locator('#ttWidgetPhase')).to_have_text('下一节课')
        expect(page.locator('#ttWidgetCountdown')).to_contain_text('5 分钟')
        page.locator('#ttWidgetPin').click()
        expect(page.locator('#ttWidgetPin')).to_have_attribute('aria-pressed', 'true')
        page.wait_for_function("()=>window.__multiCalls.some(call=>call.command==='pin_timetable_widget'&&call.args.pinned===true)")
        page.locator('#ttWidgetMode').click()
        expect(page.locator('#ttWidgetAgenda')).to_be_visible()
        page.screenshot(path=str(OUT / 'widget-390.png'), full_page=True)
        page.wait_for_function("()=>document.querySelector('#ttWidgetViews').getAnimations({subtree:true}).length===0")
        assert page.locator('#ttWidgetViews [data-tt-snapshot]').count() == 0
        # Closing waits for a last toggle queued behind the storage lock.
        page.evaluate("window.__ttHoldWrites=true;document.querySelector('#ttWidgetPin').click();document.querySelector('#ttWidgetClose').click()")
        assert page.evaluate("window.__multiCalls.filter(call=>call.command==='close_timetable_widget').length") == 0
        page.evaluate("window.__ttHoldWrites=false;window.__ttReleaseWrite()")
        page.wait_for_function("()=>window.__multiCalls.some(call=>call.command==='close_timetable_widget')")
        assert page.evaluate(f"JSON.parse(localStorage.getItem('{KEY}')).settings.widgetPinned") is False
        assert not errors, errors
        print('PASS widget: live teaching gaps, queued reversals, persistent settings, scroll/focus continuity and 390 px layout', flush=True)
    finally:
        context.close()


def main_checks(browser, base, reduced=False):
    context = context_for(browser, base, reduced=reduced)
    page = context.new_page()
    errors = []
    monitor(page, errors)
    try:
        page.goto(base + '/quick.html?kind=tool&toolId=timetable', wait_until='networkidle')
        expect(page.locator('#ttGrid .tt-course')).to_have_count(6)
        expect(page.locator('#ttLiveBadge')).to_have_text('正在上课')
        expect(page.locator('#ttLiveSummary')).to_have_text('高等数学')
        page.screenshot(path=str(OUT / ('main-reduced.png' if reduced else 'main-week.png')), full_page=True)
        search = page.locator('#ttSearch')
        search.fill('李老师')
        expect(page.locator('#ttSearchHint')).to_contain_text('2 条安排')
        expect(page.locator('#ttGrid .tt-course:not(.is-search-muted)')).to_have_count(2)
        search.evaluate("node=>{node.focus();node.setSelectionRange(1,2);window.__search=node;dispatchEvent(new Event('focus'))}")
        assert search.evaluate('node=>node===document.activeElement && node===window.__search && node.selectionStart===1 && node.selectionEnd===2')
        page.locator('#ttSearchClear').click()
        expect(search).to_have_value('')
        page.locator('[data-tt-action="view-agenda"]').click()
        expect(page.locator('#ttAgenda')).to_be_visible()
        expect(page.locator('#ttAgendaList .tt-agenda-entry')).to_have_count(6)
        page.locator('#ttDayPicker [data-tt-day="4"]').click()
        expect(page.locator('#ttAgendaList .tt-agenda-entry')).to_have_count(3)
        page.screenshot(path=str(OUT / 'main-agenda.png'), full_page=True)
        # Reversal uses one real surface, with no duplicate live IDs or actions.
        page.evaluate("""() => {for(let index=0;index<6;index++)document.querySelector(`[data-tt-action="${index%2?'view-agenda':'view-week'}"]`).click()}""")
        expect(page.locator('[data-tt-action="view-agenda"]')).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('#ttAgenda')).to_be_visible()
        page.wait_for_function("()=>document.querySelector('#ttViews').getAnimations({subtree:true}).length===0")
        assert page.locator('#ttViews [data-tt-snapshot]').count() == 0
        assert page.locator('#ttGrid').count() == 1 and page.locator('#ttAgendaList').count() == 1
        page.locator('#ttWeek').select_option('2')
        expect(page.locator('#ttAgendaList .tt-agenda-entry')).to_have_count(3)
        page.locator('#ttDayPicker [data-tt-day="0"]').click()
        expect(page.locator('#ttAgendaList .tt-agenda-entry')).to_have_count(5)
        search.fill('不存在的课程')
        expect(page.locator('#ttAgendaList')).to_contain_text('没有找到匹配的课程')
        page.locator('#ttAgendaList [data-tt-action="clear-search"]').click()
        expect(search).to_have_value('')
        page.locator('[data-tt-action="today"]').click()

        # Closing an unsaved edit returns keyboard focus to the same course.
        entry = page.locator('#ttAgendaList .tt-agenda-entry[data-id="math"]')
        entry.click()
        expect(page.locator('#ttCourseName')).to_have_value('高等数学')
        expect(page.locator('#ttCourseLivePreview')).to_have_attribute('data-tone', 'success')
        page.locator('#ttCourseName').fill('未保存的草稿')
        page.keyboard.press('Escape')
        expect(page.locator('#ttDialog')).not_to_be_visible()
        assert page.evaluate(f"JSON.parse(localStorage.getItem('{KEY}')).semester.courses[0].name") == '高等数学'
        assert entry.evaluate('node=>node===document.activeElement')

        page.locator('[data-tt-action="add"]').first.click()
        page.locator('#ttCourseName').fill('创意编程')
        picker = page.locator('#ttCourseForm > .tt-dialog-body [data-week-picker]').first
        picker.locator('[data-week-preset="odd"]').click()
        expect(page.locator('#ttCourseParity')).to_have_value('odd')
        expect(picker.locator('.tt-week-count')).to_contain_text('10 / 20')
        picker.locator('[data-week="2"]').click()
        expect(page.locator('#ttCourseParity')).to_have_value('all')
        expect(picker.locator('[data-week="2"]')).to_have_attribute('aria-pressed', 'true')
        expect(picker.locator('.tt-week-count')).to_contain_text('11 / 20')
        picker.locator('[data-week="2"]').focus()
        page.keyboard.press('ArrowRight')
        assert picker.locator('[data-week="3"]').evaluate('node=>node===document.activeElement')
        page.locator('#ttCourseDay').select_option('4')
        expect(page.locator('#ttCourseLivePreview')).to_have_attribute('data-tone', 'warning')
        expect(page.locator('#ttCourseLivePreview')).to_contain_text('高等数学')
        page.get_by_role('button', name='保存课程', exact=True).click()
        expect(page.locator('#ttPanelNotice')).to_contain_text('冲突')
        assert len(page.evaluate(f"JSON.parse(localStorage.getItem('{KEY}')).semester.courses")) == 6
        page.locator('#ttCourseDay').select_option('1')
        expect(page.locator('#ttCourseLivePreview')).to_have_attribute('data-tone', 'success')
        page.get_by_role('button', name='保存课程', exact=True).click()
        expect(page.locator('#ttDialog')).not_to_be_visible()
        expect(page.locator('#ttUndo')).to_be_enabled()
        page.locator('#ttUndo').click()
        page.wait_for_function(f"()=>JSON.parse(localStorage.getItem('{KEY}')).semester.courses.length===6")
        page.locator('#ttRedo').click()
        page.wait_for_function(f"()=>JSON.parse(localStorage.getItem('{KEY}')).semester.courses.length===7")

        page.locator('[data-tt-action="view-week"]').click()
        page.locator('#ttWeekendToggle').click()
        expect(page.locator('#ttGrid .tt-day-head')).to_have_count(5)
        expect(page.locator('#ttWeekCount')).to_contain_text('1 条周末课程已隐藏')
        page.locator('#ttUndo').click()
        expect(page.locator('#ttGrid .tt-day-head')).to_have_count(7)
        page.set_viewport_size({'width': 390, 'height': 800})
        page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        scroll = page.locator('#ttBoard .tt-board-scroll')
        scroll.evaluate('node=>{node.scrollLeft=130;node.scrollTop=100;window.__boardScroll=[node.scrollLeft,node.scrollTop]}')
        page.locator('[data-tt-action="next"]').click()
        assert scroll.evaluate('node=>node.scrollLeft') == page.evaluate('__boardScroll[0]')
        if not reduced:
            departing = page.locator('#ttViews [data-tt-snapshot] .tt-board-scroll')
            expect(departing).to_have_count(1)
            assert departing.evaluate('node=>node.scrollLeft') == page.evaluate('__boardScroll[0]')
            assert departing.evaluate('node=>node.scrollTop') == page.evaluate('__boardScroll[1]')
        page.screenshot(path=str(OUT / ('quick-390-reduced.png' if reduced else 'quick-390.png')), full_page=True)
        if reduced:
            assert page.locator('#ttViews [data-tt-snapshot]').count() == 0
            assert page.locator('#ttViews').evaluate('node=>node.getAnimations({subtree:true}).length') == 0
        assert not errors, errors
        print(f'PASS main ({"reduced motion" if reduced else "motion"}): search, agenda/day/week, fast reversal, focus, week chips, conflicts, save/undo/redo, weekend visibility and 390 px continuity', flush=True)
    except Exception:
        page.screenshot(path=str(OUT / 'failure.png'), full_page=True)
        raise
    finally:
        context.close()


def workspace_checks(browser, base):
    context = context_for(browser, base, {'width': 1200, 'height': 850})
    page = context.new_page()
    errors = []
    monitor(page, errors)

    def active():
        return multi.active_tool_frame(page, '.tt-shell')

    def reload_workspace():
        page.evaluate('()=>window.__DTKIT_TOOL_WORKSPACE__.persist()')
        page.reload(wait_until='networkidle')
        return active()

    def panel_action(name):
        toggle = page.locator('[data-tool-page-toggle]')
        if toggle.get_attribute('aria-expanded') == 'false':
            toggle.click()
        page.locator(f'[data-tool-action="{name}"]').click()

    try:
        page.goto(base, wait_until='networkidle')
        page.locator('[data-tool-id="timetable"] .tool-card__title').click()
        frame = active()
        frame.locator('#ttWeek').select_option('2')
        frame.locator('[data-tt-action="view-agenda"]').click()
        frame.locator('#ttDayPicker [data-tt-day="4"]').click()
        frame.locator('#ttSearch').fill('高等数学')
        expect(frame.locator('#ttAgendaList .tt-agenda-entry')).to_have_count(1)
        frame.locator('#ttAgendaList .tt-agenda-entry').click()
        frame.locator('#ttCourseName').fill('高等数学草稿')
        frame.locator('#ttCourseRoom').fill('尚未确认的教室')
        frame.locator('[data-tt-action="add-arrangement"]').click()
        extra = frame.locator('.tt-extra-arrangement')
        extra.locator('[data-schedule="day"]').select_option('2')
        extra.locator('[data-schedule="room"]').fill('第二次安排的地点')
        extra.locator('[data-schedule="weeks"]').fill('1-4,8-12')
        frame.locator('#ttCourseForm [data-week-picker]').first.locator('[data-week-preset="odd"]').click()
        notes = '尚未保存的课程笔记 📝\n' * 30
        frame.locator('#ttCourseNotes').fill(notes)
        frame.locator('#ttCourseNotes').evaluate('node=>{node.focus();node.setSelectionRange(7,13);node.scrollTop=80}')
        frame.locator('#ttDialog').evaluate('node=>node.scrollTop=130')
        snapshot = frame.evaluate('()=>window.__DTKIT_TOOL_PAGE__.snapshot()')
        draft = snapshot['state']['panelDraft']
        assert draft['form'] == 'ttCourseForm' and draft['revision'] == 1
        assert draft['focus']['id'] == 'ttCourseNotes' and draft['focus']['start'] == 7
        assert draft['arrangements'][0]['room'] == '第二次安排的地点'
        assert not any('html' in key.lower() for key in draft), draft.keys()
        frame = reload_workspace()
        expect(frame.locator('#ttWeek')).to_have_value('2')
        expect(frame.locator('[data-tt-action="view-agenda"]')).to_have_attribute('aria-pressed', 'true')
        expect(frame.locator('#ttDayPicker [data-tt-day="4"]')).to_have_attribute('aria-pressed', 'true')
        expect(frame.locator('#ttSearch')).to_have_value('高等数学')
        expect(frame.locator('#ttDialog')).to_be_visible()
        expect(frame.locator('#ttCourseName')).to_have_value('高等数学草稿')
        expect(frame.locator('#ttCourseRoom')).to_have_value('尚未确认的教室')
        expect(frame.locator('#ttCourseParity')).to_have_value('odd')
        expect(frame.locator('.tt-extra-arrangement')).to_have_count(1)
        expect(frame.locator('.tt-extra-arrangement [data-schedule="day"]')).to_have_value('2')
        expect(frame.locator('.tt-extra-arrangement [data-schedule="weeks"]')).to_have_value('1-4,8-12')
        expect(frame.locator('#ttCourseNotes')).to_have_value(notes)
        assert frame.locator('#ttCourseNotes').evaluate('node=>node===document.activeElement && node.selectionStart===7 && node.selectionEnd===13')
        assert frame.locator('#ttDialog').evaluate('node=>node.scrollTop') == draft['scrollTop']

        # Restoring a draft never resets its optimistic-concurrency guard.
        page.evaluate(f"""()=>{{const data=JSON.parse(localStorage.getItem('{KEY}'));data.revision++;data.semester.name='外部窗口已保存';localStorage.setItem('{KEY}',JSON.stringify(data))}}""")
        frame.get_by_role('button', name='保存课程', exact=True).click()
        expect(frame.locator('#ttPanelNotice')).to_contain_text('另一个窗口更新')
        assert page.evaluate(f"JSON.parse(localStorage.getItem('{KEY}')).semester.name") == '外部窗口已保存'
        assert page.evaluate(f"JSON.parse(localStorage.getItem('{KEY}')).semester.courses[0].name") == '高等数学'
        frame.locator('#ttCourseName').focus()
        page.keyboard.press('Escape')
        expect(frame.locator('#ttDialog')).not_to_be_visible()
        panel_action('settings')
        frame.locator('#ttSemesterName').fill('未保存的学期名称')
        frame.locator('[data-tab="features"]').click()
        frame.locator('#ttBackground').select_option('lavender')
        frame.locator('#ttDensity').select_option('comfortable')
        frame.locator('#ttWidgetMode').select_option('week')
        before = page.evaluate(f"localStorage.getItem('{KEY}')")
        frame = reload_workspace()
        expect(frame.locator('#ttDialog')).to_be_visible()
        expect(frame.locator('#ttSemesterName')).to_have_value('未保存的学期名称')
        expect(frame.locator('[data-tab="features"]')).to_have_attribute('aria-selected', 'true')
        expect(frame.locator('#ttBackground')).to_have_value('lavender')
        expect(frame.locator('#ttDensity')).to_have_value('comfortable')
        expect(frame.locator('#ttWidgetMode')).to_have_value('week')
        assert page.evaluate(f"localStorage.getItem('{KEY}')") == before
        frame.locator('#ttBackground').focus()
        page.keyboard.press('Escape')
        expect(frame.locator('#ttDialog')).not_to_be_visible()
        panel_action('settings')
        frame.locator('[data-tab="other"]').click()
        frame.locator('[data-tt-action="new-semester"]').click()
        frame.locator('#ttNewSemesterName').fill('下一段旅程的草稿')
        frame.locator('#ttNewSemesterWeeks').fill('18')
        frame.locator('#ttNewSemesterDate').fill('2027-02-22')
        frame = reload_workspace()
        expect(frame.locator('#ttNewSemesterName')).to_have_value('下一段旅程的草稿')
        expect(frame.locator('#ttNewSemesterWeeks')).to_have_value('18')
        expect(frame.locator('#ttNewSemesterDate')).to_have_value('2027-02-22')
        assert page.evaluate(f"localStorage.getItem('{KEY}')") == before
        assert not errors, errors
        print('PASS workspace: selected view/week/day/search, course fields/arrangements/caret/scroll, settings and new-semester drafts restore; stale revisions cannot overwrite external saves', flush=True)
    except Exception:
        page.screenshot(path=str(OUT / 'workspace-failure.png'), full_page=True)
        raise
    finally:
        context.close()


def run(base):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            widget_checks(browser, base)
            main_checks(browser, base)
            main_checks(browser, base, reduced=True)
            workspace_checks(browser, base)
        finally:
            browser.close()


if __name__ == '__main__':
    with multi.production_url() as base:
        run(base)
