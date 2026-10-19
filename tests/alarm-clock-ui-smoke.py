"""Alarm workflows against IPC/audio mocks; never runs programs or power actions.

Run after npm run build. Also checks the real embedded tool page and narrow windows.
"""
import importlib.util
import os
import re
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
OUT = Path(os.environ.get('DTKIT_ALARM_SCREENSHOT_DIR', tempfile.gettempdir()))
MOCK = multi.MOCK + r"""
window.__alarmFiles = [];
const originalInvoke = window.__TAURI__.core.invoke;
window.__TAURI__.core.invoke = async (command, args) => {
    if (command === 'scan_audio_files') return window.__alarmFiles;
    return originalInvoke(command, args);
};
window.__TAURI__.dialog.open = async () => 'C:\\Tools\\reminder.cmd';
window.Audio = class extends EventTarget {
    constructor() { super(); this.readyState = 2; }
    async play() { this.playing = true; }
    pause() { this.playing = false; }
    load() {}
};
window.__alarmEmit = task => {
    for (const listener of window.__multiListeners['alarm-triggered'] || []) {
        listener({payload:{...task,triggerId:crypto.randomUUID(),triggeredAt:Date.now()}});
    }
};
"""


def stored(page):
    return page.evaluate("JSON.parse(localStorage.getItem('alarm_clock_data') || '{}')")


def open_alarm(browser, base, errors, *, embedded=False, width=1440, height=1000):
    context = browser.new_context(viewport={'width':width, 'height':height}, timezone_id='Asia/Shanghai')
    page = context.new_page()
    page.add_init_script(MOCK)
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    page.goto(base + ('/' if embedded else '/quick.html?kind=tool&toolId=alarm-clock'), wait_until='networkidle')
    frame = page
    if embedded:
        page.locator('#toolLibraryView [data-tool-id="alarm-clock"] .tool-card__title').click()
        frame = multi.active_tool_frame(page, '.alarm-clock-view')
    expect(frame.locator('.alarm-clock-view')).to_be_visible()
    expect(frame.locator('#addTaskBtn')).to_be_enabled()
    return page, frame


def card(frame, name):
    return frame.locator('.alarm-task-card').filter(has=frame.locator('.alarm-task-name', has_text=name))


def create(frame, name, kind='countdown', action='notify'):
    frame.locator(f'[data-alarm-type="{kind}"]').click()
    frame.locator('#alarmTaskName').fill(name)
    frame.locator('#alarmActionType').select_option(action)
    frame.locator('#addTaskBtn').click()
    if action != 'run':
        expect(card(frame, name)).to_be_visible()


def test_workflows(browser, base, errors):
    page, frame = open_alarm(browser, base, errors)
    expect(frame.locator('#emptyListHint')).to_be_visible()
    frame.locator('.alarm-empty-create').click()
    expect(frame.locator('#alarmTaskName')).to_be_focused()
    frame.locator('#addTaskBtn').click()
    expect(frame.locator('#alarmFormStatus')).to_have_text('请输入任务名称')
    frame.locator('#alarmTaskName').fill('无效时长')
    frame.locator('#countdownMinutes').fill('0')
    frame.locator('#addTaskBtn').click()
    expect(frame.locator('#alarmFormStatus')).to_have_text('请设置有效的倒计时时长')
    frame.locator('#countdownHours').fill('24')
    frame.locator('#addTaskBtn').click()
    expect(frame.locator('#alarmFormStatus')).to_have_text('倒计时时间超出有效范围')
    frame.locator('[data-duration="1500"]').click()
    expect(frame.locator('#countdownMinutes')).to_have_value('25')
    frame.locator('#alarmTaskName').fill('专注一会儿')
    frame.locator('#alarmTaskName').press('Enter')
    expect(frame.locator('.alarm-task-card')).to_have_count(1)
    expect(frame.locator('#nextAlarmName')).to_have_text('专注一会儿')
    expect(frame.locator('#activeTaskCount')).to_have_text('1')

    # Pause is reflected in the next reminder, active count, filters and saved state.
    card(frame, '专注一会儿').locator('.alarm-task-btn--pause').click()
    expect(frame.locator('#activeTaskCount')).to_have_text('0')
    expect(frame.locator('#nextAlarmCountdown')).to_have_text('--:--:--')
    frame.locator('[data-filter="active"]').click()
    expect(frame.locator('.alarm-task-card')).to_have_count(0)
    frame.locator('[data-filter="paused"]').click()
    expect(frame.locator('.alarm-task-card')).to_have_count(1)
    card(frame, '专注一会儿').locator('.alarm-task-btn--edit').click()
    frame.locator('#alarmTaskName').fill('专注与休息')
    frame.locator('[data-duration="900"]').click()
    frame.locator('#addTaskBtn').click()
    expect(frame.locator('[data-filter="all"]')).to_have_attribute('aria-pressed', 'true')
    expect(card(frame, '专注与休息')).to_have_class(re.compile('paused'))
    task = stored(page)['tasks'][0]
    assert task['paused'] and task['config']['remainingSeconds'] == 900
    card(frame, '专注与休息').locator('.alarm-task-btn--resume').click()
    expect(frame.locator('#activeTaskCount')).to_have_text('1')

    # A fixed one-time reminder resets its repeat controls after saving.
    frame.locator('[data-alarm-type="fixed"]').click()
    frame.locator('#alarmTaskName').fill('下班打卡')
    frame.locator('#alarmTimeInput').fill('23:59')
    for checkbox in frame.locator('[name="repeatDay"]').all():
        checkbox.uncheck()
    frame.locator('#addTaskBtn').click()
    expect(frame.locator('#alarmFormStatus')).to_have_text('重复提醒至少选择一天')
    frame.locator('#repeatEnabled').uncheck()
    expect(frame.locator('#repeatDaysGroup')).to_be_hidden()
    frame.locator('#addTaskBtn').click()
    expect(card(frame, '下班打卡')).to_be_visible()
    task = stored(page)['tasks'][0]
    assert task['config']['repeatEnabled'] is False
    frame.locator('[data-alarm-type="fixed"]').click()
    expect(frame.locator('#repeatEnabled')).to_be_checked()
    expect(frame.locator('#repeatDaysGroup')).to_be_visible()
    page.evaluate('task => window.__alarmEmit(task)', task)
    expect(card(frame, '下班打卡')).to_have_class(re.compile('disabled'))
    expect(frame.locator('#completedTodayCount')).to_have_text('1')
    frame.locator('[data-filter="completed"]').click()
    expect(frame.locator('.alarm-task-card')).to_have_count(1)
    frame.locator('[data-filter="all"]').click()

    create(frame, '每个整点，抬头看看', 'hourly')
    create(frame, '记得喝水', 'interval')
    create(frame, '运行我的提醒', action='run')
    # Program configuration must be explicitly chosen.
    expect(frame.locator('#alarmFormStatus')).to_have_text('请选择要运行的程序')
    frame.locator('#selectFileBtn').click()
    frame.locator('#addTaskBtn').click()
    expect(card(frame, '运行我的提醒')).to_be_visible()
    assert stored(page)['tasks'][0]['config']['filePath'].endswith('reminder.cmd')
    create(frame, '锁屏提醒', action='lock')
    create(frame, '关机提醒', action='shutdown')

    # Only the mocked native trigger executes here; no operating system action is run.
    frame.locator('#alarmActionType').select_option('sound')
    expect(frame.locator('#addTaskBtn')).to_be_disabled()
    expect(frame.locator('.alarm-no-audio')).to_contain_text('未找到音频文件')
    page.evaluate("""window.__alarmFiles = [
        {name:'轻柔铃声',path:'tone-1.wav',size:1024},
        {name:'清晨',path:'tone-2.wav',size:2048}
    ]""")
    frame.get_by_role('button', name='刷新提示音列表').click()
    expect(frame.locator('.alarm-audio-item')).to_have_count(2)
    frame.locator('.alarm-audio-item').first.focus()
    page.keyboard.press('ArrowDown')
    expect(frame.locator('.alarm-audio-item').last).to_have_attribute('aria-checked', 'true')
    frame.locator('#alarmTaskName').fill('轻柔提醒')
    frame.locator('#addTaskBtn').click()
    expect(card(frame, '轻柔提醒')).to_be_visible()
    task = stored(page)['tasks'][0]
    assert task['config']['audioPath'] == 'tone-2.wav'
    frame.locator('#alarmTaskName').focus()
    page.evaluate('task => window.__alarmEmit(task)', task)
    expect(frame.locator('.dtkit-toast--alarm')).to_be_visible()
    expect(frame.locator('.alarm-dismiss-btn')).to_be_focused()
    page.keyboard.press('Escape')
    expect(frame.locator('.dtkit-toast--alarm')).to_have_count(0)
    expect(frame.locator('#alarmTaskName')).to_be_focused()
    card(frame, '轻柔提醒').locator('.alarm-task-btn--restart').click()
    expect(card(frame, '轻柔提醒')).not_to_have_class(re.compile('disabled'))

    # Keyboard reordering is persisted and keeps focus on the moved handle.
    before = [task['id'] for task in stored(page)['tasks']]
    frame.locator('.alarm-task-drag-handle').first.focus()
    page.keyboard.press('ArrowDown')
    page.wait_for_function("ids => JSON.parse(localStorage.getItem('alarm_clock_data')).tasks[0].id !== ids[0]", arg=before)
    after = [task['id'] for task in stored(page)['tasks']]
    assert after[1] == before[0]
    expect(frame.locator('.alarm-task-drag-handle').nth(1)).to_be_focused()
    page.evaluate("""() => {
        const panel = document.getElementById('taskListPanel');
        const cards = panel.querySelectorAll('.alarm-task-card');
        cards[0].querySelector('.alarm-task-drag-handle')
            .dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
        const transfer = new DataTransfer();
        cards[0].dispatchEvent(new DragEvent('dragstart', {bubbles:true,dataTransfer:transfer}));
        const rect = cards[2].getBoundingClientRect();
        cards[2].dispatchEvent(new DragEvent('dragover', {bubbles:true,cancelable:true,clientY:rect.bottom,dataTransfer:transfer}));
        panel.dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:transfer}));
        cards[0].dispatchEvent(new DragEvent('dragend', {bubbles:true,dataTransfer:transfer}));
    }""")
    page.wait_for_function("id => JSON.parse(localStorage.getItem('alarm_clock_data')).tasks[2].id === id", arg=after[0])

    # User text remains text in task cards.
    create(frame, '<img src=x onerror=alert(1)>')
    expect(frame.locator('.alarm-task-name img')).to_have_count(0)
    card(frame, '<img src=x onerror=alert(1)>').locator('.alarm-task-btn--delete').click()
    expect(card(frame, '<img src=x onerror=alert(1)>')).to_have_count(0)

    # A save waiting on a shared-data lock must not erase a newer draft.
    page.evaluate("""() => { navigator.locks.request('dtkit-alarm-data', () =>
        new Promise(resolve => {window.__releaseAlarmLock = resolve;})); }""")
    page.wait_for_function('Boolean(window.__releaseAlarmLock)')
    frame.locator('#alarmTaskName').fill('保存中的提醒')
    frame.locator('#addTaskBtn').click()
    expect(frame.locator('#addTaskBtn')).to_be_disabled()
    frame.locator('#alarmTaskName').fill('不要清空的新草稿')
    page.evaluate('window.__releaseAlarmLock()')
    expect(card(frame, '保存中的提醒')).to_be_visible()
    expect(frame.locator('#alarmTaskName')).to_have_value('不要清空的新草稿')

    # Persist the draft, active filter, selected type, repeat days and editing mode.
    card(frame, '专注与休息').locator('.alarm-task-btn--edit').click()
    frame.locator('#alarmTaskName').fill('未保存的编辑')
    frame.locator('[data-filter="paused"]').click()
    offsets = page.evaluate("""() => {
        const workspace = document.querySelector('.alarm-clock-view');
        const outer = document.getElementById('quickContent');
        workspace.scrollTop = 120;
        if (!workspace.scrollTop) outer.scrollTop = 120;
        return {workspace:workspace.scrollTop, outer:outer.scrollTop};
    }""")
    snapshot = page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot()')
    assert offsets['workspace'] > 0 or offsets['outer'] > 0
    assert snapshot['state']['workspaceScrollTop'] == offsets['workspace']
    assert snapshot['scrollTop'] == offsets['outer']
    frame.locator('#cancelAlarmEditBtn').click()
    page.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', snapshot)
    expect(frame.locator('#alarmFormTitle')).to_have_text('编辑提醒')
    expect(frame.locator('#alarmTaskName')).to_have_value('未保存的编辑')
    expect(frame.locator('[data-filter="paused"]')).to_have_attribute('aria-pressed', 'true')
    assert frame.locator('.alarm-clock-view').evaluate('node => node.scrollTop') == offsets['workspace']
    assert page.locator('#quickContent').evaluate('node => node.scrollTop') == offsets['outer']
    frame.locator('#cancelAlarmEditBtn').click()
    frame.locator('[data-filter="all"]').click()

    # Screenshot a real populated interface and verify compact layouts remain usable.
    for width, height in [(900,700), (680,480), (390,700)]:
        page.set_viewport_size({'width':width, 'height':height})
        # A resize can interrupt a running FLIP transform. Check the settled layout.
        frame.wait_for_function("""() => {
            const node = document.querySelector('.alarm-clock-view');
            return node.scrollWidth <= node.clientWidth + 1;
        }""")
        frame.locator('[data-alarm-type="interval"]').click()
        frame.locator('#addTaskBtn').scroll_into_view_if_needed()
        expect(frame.locator('#addTaskBtn')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(OUT / 'dtkit-alarm-mobile.png'), full_page=True)
    page.emulate_media(color_scheme='dark', reduced_motion='reduce')
    page.screenshot(path=str(OUT / 'dtkit-alarm-dark.png'), full_page=True)
    page.close()


def assert_sliding_indicator(frame, group_selector, button_selector):
    """Sample a real CSS transition halfway through its own timeline."""
    result = frame.evaluate("""async ({groupSelector, buttonSelector}) => {
        const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
        const group = document.querySelector(groupSelector);
        const indicator = group.querySelector('.tool-segment-indicator');
        for (const animation of indicator.getAnimations()) animation.finish();
        const start = indicator.getBoundingClientRect().left;
        const button = group.querySelector(buttonSelector);
        button.focus();
        button.click();
        await tick(); await tick();
        const animation = indicator.getAnimations().find(item => item.transitionProperty === 'transform');
        if (!animation) return {error:'Selected segment has no sliding transform transition'};
        animation.pause();
        animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
        const middle = indicator.getBoundingClientRect().left;
        animation.finish();
        for (const item of indicator.getAnimations()) item.finish();
        const end = indicator.getBoundingClientRect().left;
        return {start, middle, end, goal:button.getBoundingClientRect().left,
            focused:document.activeElement === button};
    }""", {'groupSelector':group_selector, 'buttonSelector':button_selector})
    assert 'error' not in result, result
    assert min(result['start'], result['end']) + .25 < result['middle'] < max(result['start'], result['end']) - .25, result
    assert abs(result['end'] - result['goal']) <= 1.5, result
    assert result['focused'], result


def test_motion(browser, base, errors):
    page, frame = open_alarm(browser, base, errors, height=1000)
    expect(frame.locator('.alarm-type-switch')).to_have_class(re.compile('tool-motion-ready'))
    expect(frame.locator('.alarm-filter-tabs')).to_have_class(re.compile('tool-motion-ready'))
    assert_sliding_indicator(frame, '.alarm-type-switch', '[data-alarm-type="interval"]')
    assert_sliding_indicator(frame, '.alarm-filter-tabs', '[data-filter="completed"]')

    frame.locator('#alarmTaskName').fill('快速切换后仍保留的草稿')
    for final_type in ['countdown', 'fixed', 'hourly', 'interval']:
        focus = frame.evaluate("""async finalType => {
            const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
            for (const type of ['hourly', 'countdown', 'fixed', 'interval', finalType]) {
                const button = document.querySelector('[data-alarm-type="' + type + '"]');
                button.focus(); button.click();
                await tick();
            }
            return document.activeElement?.dataset.alarmType;
        }""", final_type)
        assert focus == final_type
        expect(frame.locator('.alarm-type-switch [aria-pressed="true"]')).to_have_count(1)
        expect(frame.locator(f'[data-alarm-type="{final_type}"]')).to_have_attribute('aria-pressed', 'true')
        for selector, visible in [
            ('#countdownInputs', final_type == 'countdown'),
            ('#alarmQuickPresets', final_type == 'countdown'),
            ('#alarmTimeInput', final_type == 'fixed'),
            ('#alarmHourlyHint', final_type == 'hourly'),
            ('#intervalInputs', final_type == 'interval'),
            ('#repeatSettingsGroup', final_type in ('fixed', 'hourly')),
        ]:
            if visible:
                expect(frame.locator(selector)).to_be_visible()
            else:
                expect(frame.locator(selector)).to_be_hidden()
        expect(frame.locator('#alarmTaskName')).to_have_value('快速切换后仍保留的草稿')

    frame.locator('[data-filter="all"]').click()
    create(frame, '动效测试提醒一')
    create(frame, '动效测试提醒二')
    card(frame, '动效测试提醒一').locator('.alarm-task-btn--pause').click()
    for final_filter, count in [('paused', 1), ('active', 1), ('completed', 0), ('all', 2)]:
        focus = frame.evaluate("""async finalFilter => {
            const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
            for (const filter of ['active', 'all', 'paused', 'completed', finalFilter]) {
                const button = document.querySelector('[data-filter="' + filter + '"]');
                button.focus(); button.click();
                await tick();
            }
            return document.activeElement?.dataset.filter;
        }""", final_filter)
        assert focus == final_filter
        expect(frame.locator('.alarm-filter-tabs [aria-pressed="true"]')).to_have_count(1)
        expect(frame.locator('.alarm-task-card')).to_have_count(count)
    frame.wait_for_function("""() => !document.querySelector('.alarm-clock-view')
        .getAnimations({subtree:true}).some(animation => animation.playState === 'running')""")
    assert frame.locator('#alarmTaskForm').evaluate("node => !node.style.height")
    assert frame.locator('.alarm-task-card').evaluate_all("nodes => nodes.every(node => getComputedStyle(node).transform === 'none')")

    # Changing the operating system preference also stops motions already in flight.
    frame.locator('[data-alarm-type="fixed"]').evaluate('node => node.click()')
    page.emulate_media(reduced_motion='reduce')
    frame.locator('[data-alarm-type="hourly"]').click()
    frame.locator('[data-filter="paused"]').click()
    reduced = frame.evaluate("""async () => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));
        const root = document.querySelector('.alarm-clock-view');
        return {
            active:root.getAnimations({subtree:true}).filter(animation => animation.playState === 'running').length,
            durations:[...root.querySelectorAll('.tool-segment-indicator')]
                .flatMap(node => getComputedStyle(node).transitionDuration.split(',').map(parseFloat))
        };
    }""")
    assert reduced['active'] == 0, reduced
    assert all(duration <= .001 for duration in reduced['durations']), reduced
    expect(frame.locator('#alarmHourlyHint')).to_be_visible()
    expect(frame.locator('#repeatSettingsGroup')).to_be_visible()
    expect(frame.locator('.alarm-task-card')).to_have_count(1)

    page.emulate_media(reduced_motion='no-preference')
    teardown = frame.evaluate("""async () => {
        const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
        const root = document.querySelector('.alarm-clock-view');
        const indicators = [...root.querySelectorAll('.tool-segment-indicator')];
        document.querySelector('[data-alarm-type="countdown"]').click();
        document.querySelector('[data-filter="all"]').click();
        await tick(); await tick();
        const owned = root.getAnimations({subtree:true}).filter(animation =>
            !(animation instanceof CSSAnimation || animation instanceof CSSTransition)
            || indicators.includes(animation.effect?.target));
        const started = owned.some(animation => animation.playState === 'running');
        await window.__DTKIT_TOOL_PAGE__.dispose();
        await Promise.resolve();
        return {started, remaining:owned.filter(animation => ['running','paused'].includes(animation.playState)).length,
            indicators:root.querySelectorAll('.tool-segment-indicator').length};
    }""")
    assert teardown['started'], teardown
    assert teardown['remaining'] == 0 and teardown['indicators'] == 0, teardown
    page.context.close()


def capture_preview(browser, base, errors):
    page, frame = open_alarm(browser, base, errors, height=1120)
    frame.locator('[data-duration="1500"]').click()
    create(frame, '留一段时间，专注当下')
    create(frame, '起身走走，喝一杯水', 'interval')
    card(frame, '起身走走，喝一杯水').locator('.alarm-task-btn--pause').click()
    frame.locator('[data-alarm-type="fixed"]').click()
    frame.locator('#alarmTimeInput').fill('18:00')
    create(frame, '收个尾，准时下班', 'fixed')
    frame.locator('#alarmTaskName').fill('下一件重要的事')
    frame.locator('[data-duration="1500"]').click()
    frame.locator('.alarm-clock-view').evaluate('node => { node.scrollTop = 0; }')
    frame.locator('#alarmSyncStatus').scroll_into_view_if_needed()
    page.mouse.move(0, 0)
    expect(frame.locator('.dtkit-toast')).to_have_count(0)
    expect(frame.locator('.alarm-title')).to_be_visible()
    assert frame.locator('.alarm-title').evaluate('node => parseFloat(getComputedStyle(node).fontSize)') >= 28
    page.screenshot(path=str(OUT / 'dtkit-alarm-desktop.png'), full_page=True, animations='disabled')
    page.set_viewport_size({'width':390, 'height':844})
    frame.locator('.alarm-clock-view').evaluate('node => { node.scrollTop = 0; }')
    page.screenshot(path=str(OUT / 'dtkit-alarm-mobile.png'), full_page=True, animations='disabled')
    page.emulate_media(color_scheme='dark', reduced_motion='reduce')
    page.screenshot(path=str(OUT / 'dtkit-alarm-dark.png'), full_page=True, animations='disabled')
    page.context.close()


def test_embedded_shared_data(browser, base, errors):
    page, frame = open_alarm(browser, base, errors, embedded=True)
    create(frame, '主窗口里的提醒')
    original = stored(page)['tasks'][0]
    # Another same-origin page can write without replacing the local pending draft.
    frame.locator('#alarmTaskName').fill('切换后保留的草稿')
    second = page.context.new_page()
    second.goto(base + '/quick.html?kind=tool&toolId=alarm-clock', wait_until='networkidle')
    expect(second.locator('.alarm-clock-view')).to_be_visible()
    second.locator('#alarmTaskName').fill('另一个页面的提醒')
    second.locator('#addTaskBtn').click()
    expect(card(frame, '另一个页面的提醒')).to_be_visible()
    expect(frame.locator('#alarmTaskName')).to_have_value('切换后保留的草稿')
    assert original['id'] in [task['id'] for task in stored(page)['tasks']]
    second.close()
    page.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    errors = []
    with multi.production_url() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            test_workflows(browser, base, errors)
            test_motion(browser, base, errors)
            test_embedded_shared_data(browser, base, errors)
            capture_preview(browser, base, errors)
        except Exception:
            for context in browser.contexts:
                for index, page in enumerate(context.pages):
                    page.screenshot(path=str(OUT / f'dtkit-alarm-failure-{index}.png'), full_page=True)
            raise
        finally:
            browser.close()
    assert not errors, 'Browser runtime errors:\n' + '\n'.join(errors)
    print('Alarm UI smoke passed: workflows, smooth segment interpolation, rapid switching, reduced motion, teardown, drafts, shared data and responsive layouts')
