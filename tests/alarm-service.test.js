import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    getAlarmRemainingSeconds,
    getCountdownRemainingSeconds,
    normalizeAlarmTask,
    pauseAlarmTaskSchedule,
    prepareAlarmTaskSchedule
} from '../src/core/alarmService.js';
import { formatAlarmDuration } from '../src/tools/alarm-clock/taskListView.js';
import { createAlarmTask } from '../src/tools/alarm-clock/taskFactory.js';

function countdownTask(seconds = 60) {
    return {
        id: 'countdown-test',
        type: 'countdown',
        action: 'notify',
        enabled: true,
        paused: false,
        config: { totalSeconds: seconds, remainingSeconds: seconds }
    };
}

test('countdown scheduling uses an absolute deadline instead of a frontend interval', () => {
    const before = Date.now();
    const task = prepareAlarmTaskSchedule(countdownTask(90));
    const after = Date.now();

    assert.ok(task.config.deadlineAt >= before + 90_000);
    assert.ok(task.config.deadlineAt <= after + 90_000);
});

test('pausing a countdown preserves remaining time without keeping a timer alive', () => {
    const task = countdownTask(120);
    task.config.deadlineAt = Date.now() + 45_000;
    pauseAlarmTaskSchedule(task);

    assert.equal('deadlineAt' in task.config, false);
    assert.ok(task.config.remainingSeconds >= 44 && task.config.remainingSeconds <= 45);
    task.paused = true;
    assert.equal(getCountdownRemainingSeconds(task), task.config.remainingSeconds);
});

test('next alarm countdown covers fixed, interval and one-time schedules', () => {
    const now = new Date(2026, 7, 3, 10, 0, 0, 0).getTime(); // Monday
    const fixed = {
        type: 'fixed', enabled: true, paused: false,
        config: { time: '09:00', repeatEnabled: true, repeatDays: [2] }
    };
    const oneTime = {
        type: 'fixed', enabled: true, paused: false,
        config: { time: '11:00', repeatEnabled: false, repeatDays: [] }
    };
    const interval = {
        type: 'interval', enabled: true, paused: false,
        config: { intervalMs: 60_000, nextTriggerAt: now + 30_000 }
    };

    assert.equal(getAlarmRemainingSeconds(fixed, now), 23 * 60 * 60);
    assert.equal(getAlarmRemainingSeconds(oneTime, now), 60 * 60);
    assert.equal(getAlarmRemainingSeconds(interval, now), 30);

    interval.paused = true;
    interval.config.remainingIntervalMs = 12_000;
    assert.equal(getAlarmRemainingSeconds(interval, now), Infinity);
    assert.equal(getAlarmRemainingSeconds(interval, now, { includePaused: true }), 12);
});

test('legacy repeating alarms are migrated to an explicit all-days schedule', () => {
    const task = { type: 'fixed', config: { time: '09:00', repeatDays: [] } };
    normalizeAlarmTask(task);
    assert.equal(task.config.repeatEnabled, true);
    assert.deepEqual(task.config.repeatDays, [0, 1, 2, 3, 4, 5, 6]);
});

test('alarm duration formatting is stable for fractional and long durations', () => {
    assert.equal(formatAlarmDuration(0), '00:00:00');
    assert.equal(formatAlarmDuration(61.2), '00:01:02');
    assert.equal(formatAlarmDuration(100 * 60 * 60), '100:00:00');
});

test('alarm task factory validates schedules and produces serializable tasks', () => {
    const { task } = createAlarmTask({
        name: '喝水',
        type: 'interval',
        action: 'notify',
        intervalValue: '30',
        intervalUnit: 'minutes'
    }, { id: 'alarm-1', now: new Date('2026-08-08T00:00:00.000Z') });
    assert.deepEqual(task, {
        id: 'alarm-1',
        name: '喝水',
        type: 'interval',
        action: 'notify',
        enabled: true,
        paused: false,
        createdAt: '2026-08-08T00:00:00.000Z',
        config: { intervalValue: 30, intervalUnit: 'minutes', intervalMs: 1_800_000 }
    });

    assert.equal(createAlarmTask({
        name: '错误倒计时', type: 'countdown', action: 'notify', hours: 0, minutes: 60, seconds: 0
    }).error, '倒计时时间超出有效范围');
    assert.equal(createAlarmTask({
        name: '无重复日', type: 'fixed', action: 'notify', time: '09:00', repeatEnabled: true
    }).error, '重复提醒至少选择一天');
});

test('alarm tool contains only the visible countdown refresh interval', async () => {
    const source = await readFile(new URL('../src/tools/alarm-clock/index.js', import.meta.url), 'utf8');
    const intervals = source.match(/setInterval\s*\(/g) || [];

    assert.equal(intervals.length, 1);
    assert.equal(source.includes('alarmState.timers'), false);
    assert.match(source, /syncAlarmTasks\(alarmState\.tasks\)/);
    assert.match(source, /dtkit:power-state/);
    assert.match(source, /clearInterval\(alarmState\.countdownInterval\)/);
    assert.match(source, /getElementById\('taskListPanel'\)/);
    assert.match(source, /MAX_AUDIO_QUEUE_SIZE/);
    assert.match(source, /saveTasks\(\{ sync: false \}\)/);
    assert.doesNotMatch(source, /cdn\.jsdelivr\.net|window\.Sortable|preloadedAudios/);
});

test('desktop organizer webview is created lazily instead of at app startup', async () => {
    const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    const capability = JSON.parse(await readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
    const rustSource = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

    assert.deepEqual(config.app.windows.map(window => window.label || 'main'), ['main']);
    assert.ok(capability.permissions.includes('core:window:allow-minimize'));
    assert.ok(capability.permissions.includes('core:window:allow-unminimize'));
    assert.match(rustSource, /ensure_desktop_organizer_window/);
    assert.match(rustSource, /APP_SUSPENDED/);
    assert.match(rustSource, /"app-power-state"/);
    assert.match(rustSource, /SetMemoryUsageTargetLevel/);
    assert.match(rustSource, /MinimizeMode::Standard/);
    assert.match(rustSource, /MinimizeMode::Efficient/);
    assert.match(rustSource, /MinimizeMode::Deep/);
    assert.match(rustSource, /TrayIconBuilder/);
});

test('main window close routes to the tray and only the tray quit action exits', async () => {
    const rustSource = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

    assert.match(rustSource, /WindowEvent::CloseRequested\s*\{\s*api/);
    assert.match(rustSource, /api\.prevent_close\(\)/);
    assert.match(rustSource, /"quit"\s*=>\s*app\.exit\(0\)/);
    assert.doesNotMatch(rustSource, /std::process::exit\(0\)/);
});

test('a second app launch is intercepted before other plugins and restores the existing main window', async () => {
    const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
    const rustSource = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
    const singleInstanceIndex = rustSource.indexOf('.plugin(tauri_plugin_single_instance::init');
    const dialogIndex = rustSource.indexOf('.plugin(tauri_plugin_dialog::init())');

    assert.match(cargo, /tauri-plugin-single-instance/);
    assert.ok(singleInstanceIndex >= 0 && singleInstanceIndex < dialogIndex);
    assert.match(rustSource, /tauri_plugin_single_instance::init\(\|app, _args, _cwd\|[\s\S]*ensure_main_window\(app\)/);
});

test('restoring the main window resumes frontend rendering before it is shown', async () => {
    const rustSource = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
    const ensureMainWindow = rustSource.match(/fn ensure_main_window[\s\S]*?\n}\n\nfn setup_tray/)?.[0] || '';

    assert.match(ensureMainWindow, /emit_main_power_state\(window\.app_handle\(\), false, false\)/);
    assert.match(ensureMainWindow, /set_webview_memory_target\(&window, false\)/);
});

test('deep sleep keeps alarm completion events for the recreated frontend', async () => {
    const rustSource = await readFile(new URL('../src-tauri/src/alarm_scheduler.rs', import.meta.url), 'utf8');
    const frontendSource = await readFile(new URL('../src/core/alarmService.js', import.meta.url), 'utf8');

    assert.match(rustSource, /missed_triggers/);
    assert.match(rustSource, /take_missed_alarm_triggers/);
    assert.match(frontendSource, /take_missed_alarm_triggers/);
});
