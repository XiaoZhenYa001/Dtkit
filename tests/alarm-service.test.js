import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    getCountdownRemainingSeconds,
    pauseAlarmTaskSchedule,
    prepareAlarmTaskSchedule
} from '../src/core/alarmService.js';

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

test('alarm tool contains only the visible countdown refresh interval', async () => {
    const source = await readFile(new URL('../src/tools/alarm-clock/index.js', import.meta.url), 'utf8');
    const intervals = source.match(/setInterval\s*\(/g) || [];

    assert.equal(intervals.length, 1);
    assert.equal(source.includes('alarmState.timers'), false);
    assert.match(source, /syncAlarmTasks\(alarmState\.tasks\)/);
    assert.match(source, /dtkit:power-state/);
    assert.match(source, /clearInterval\(alarmState\.countdownInterval\)/);
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

test('deep sleep keeps alarm completion events for the recreated frontend', async () => {
    const rustSource = await readFile(new URL('../src-tauri/src/alarm_scheduler.rs', import.meta.url), 'utf8');
    const frontendSource = await readFile(new URL('../src/core/alarmService.js', import.meta.url), 'utf8');

    assert.match(rustSource, /missed_triggers/);
    assert.match(rustSource, /take_missed_alarm_triggers/);
    assert.match(frontendSource, /take_missed_alarm_triggers/);
});
