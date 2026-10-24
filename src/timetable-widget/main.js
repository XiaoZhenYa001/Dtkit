import { currentWeek, dateKey, todayCourses } from '../tools/timetable/model.js';
import { liveContext, nextLiveRefresh } from '../tools/timetable/core.js';
import { readState, updateState, STORAGE_KEY, CHANGED_EVENT } from '../tools/timetable/store.js';
import { renderGrid, renderAgenda, applyBackground } from '../tools/timetable/view.js';
import { createTimetableMotion } from '../tools/timetable/motion.js';

const api = window.__TAURI__;
const byId = id => document.getElementById(id);
const controller = new AbortController(), { signal } = controller;
const motion = createTimetableMotion(signal);
const pendingSettings = new Map(), disposers = [];
const signatures = { today: '', week: '' };
let state, timer, suspended = false, pinned, pinning = false, busy = false;
let disposed = false, pendingRefresh = false, previousMode;
let settingJob = Promise.resolve();

function notice(message = '', error = false) {
    if (disposed) return;
    byId('ttWidgetNotice').textContent = message;
    byId('ttWidgetNotice').classList.toggle('is-error', error);
}
function on(target, name, handler) { target.addEventListener(name, handler, { signal }); }

// Native calls can resolve out of order if the user reverses a toggle quickly.
// Keep one in flight and always reconcile it with the latest visible intent.
async function syncPin() {
    if (!api?.core?.invoke || pinning || disposed) return;
    pinning = true;
    try {
        while (!disposed && pinned !== state.settings.widgetPinned) {
            const next = state.settings.widgetPinned;
            await api.core.invoke('pin_timetable_widget', { pinned: next });
            pinned = next;
        }
    } catch (error) { notice(`置顶状态同步失败：${String(error)}`, true); }
    finally { pinning = false; }
}

function render() {
    clearTimeout(timer);
    if (disposed || !state || suspended || document.hidden) return;
    const now = new Date(), today = dateKey(now), week = currentWeek(state, today);
    const mode = state.settings.widgetMode, context = liveContext(state, now), count = todayCourses(state, today).length;
    byId('ttWidgetTitle').textContent = state.semester.name;
    byId('ttWidgetDate').textContent = `${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now)} · ${week < 1 ? '尚未开学' : week > state.semester.totalWeeks ? '学期已结束' : `第 ${week} 周`}`;
    byId('ttWidgetPhase').textContent = context.label;
    byId('ttWidgetCount').textContent = count ? `今日 ${count} 堂课` : '留白的一天';
    byId('ttWidgetCurrent').textContent = context.course?.name || context.label;
    byId('ttWidgetSummary').textContent = context.detail;
    byId('ttWidgetCountdown').textContent = context.remainingMinutes ? `${context.phase === 'current' ? '距离下课' : '距离上课'} ${context.remainingMinutes} 分钟` : '';
    byId('ttWidgetFocus').dataset.phase = context.phase;
    const progress = byId('ttWidgetProgress');
    progress.hidden = context.phase !== 'current';
    progress.style.setProperty('--tt-progress', `${Math.round(context.progress * 100)}%`);
    progress.setAttribute('aria-valuenow', String(Math.round(context.progress * 100)));
    byId('ttWidgetMode').textContent = mode === 'today' ? '本周' : '今日';
    byId('ttWidgetMode').setAttribute('aria-label', mode === 'today' ? '切换为本周课表' : '切换为今日课程');
    byId('ttWidgetPin').setAttribute('aria-pressed', String(state.settings.widgetPinned));
    byId('ttWidgetPin').title = state.settings.widgetPinned ? '取消置顶' : '置顶小部件';

    const agenda = byId('ttWidgetAgenda'), board = byId('ttWidgetBoard');
    const active = mode === 'today' ? agenda : board;
    const signature = JSON.stringify([state.semester, today, context.phase, context.segment?.start, context.course?.id,
        mode === 'week' ? [state.settings.showWeekend, state.settings.showOtherWeeks, state.settings.weekStartsOn, state.settings.density] : null]);
    if (signature !== signatures[mode]) {
        const scroll = board.querySelector('.tt-board-scroll'), left = scroll.scrollLeft, top = scroll.scrollTop;
        motion.content(active, () => {
            if (mode === 'today') renderAgenda(agenda, state);
            else renderGrid(byId('ttWidgetGrid'), state, Math.max(1, Math.min(state.semester.totalWeeks, week)), false);
            scroll.scrollLeft = left; scroll.scrollTop = top;
        }, { animate: previousMode === mode });
        signatures[mode] = signature;
    }
    applyBackground(board, state.settings.background);
    if (previousMode !== mode) motion.show(byId('ttWidgetViews'), active, { animate: previousMode !== undefined });
    previousMode = mode;
    syncPin();
    timer = setTimeout(render, nextLiveRefresh(state, now));
}

function refresh() {
    if (disposed) return;
    if (busy) { pendingRefresh = true; return; }
    try { state = readState(); notice(); render(); }
    catch (error) { clearTimeout(timer); notice(error.message, true); }
}
async function drainSettings() {
    if (busy || disposed) return;
    busy = true;
    try {
        while (pendingSettings.size && !disposed) {
            const changes = [...pendingSettings]; pendingSettings.clear();
            const result = await updateState(data => { for (const [name, value] of changes) data.settings[name] = value; });
            if (disposed) return;
            state = result;
            // A second click is immediately visible while its write waits.
            for (const [name, value] of pendingSettings) state.settings[name] = value;
            notice(); render();
        }
    } catch (error) {
        pendingSettings.clear(); pendingRefresh = false;
        try { state = readState(); render(); } catch { /* Preserve the original save failure. */ }
        notice(error.message, true);
    } finally {
        busy = false;
        if (pendingRefresh) { pendingRefresh = false; refresh(); }
    }
}
function changeSetting(name, value) {
    if (!state || disposed) return;
    pendingSettings.set(name, value);
    state.settings[name] = value;
    render();
    if (!busy) settingJob = drainSettings();
}

on(byId('ttWidgetMode'), 'click', () => changeSetting('widgetMode', state?.settings.widgetMode === 'today' ? 'week' : 'today'));
on(byId('ttWidgetPin'), 'click', () => changeSetting('widgetPinned', !state?.settings.widgetPinned));
on(byId('ttWidgetClose'), 'click', async () => {
    try { await settingJob; if (!disposed) await api?.core?.invoke('close_timetable_widget'); }
    catch (error) { notice(String(error), true); }
});
on(byId('ttWidgetDrag'), 'pointerdown', event => {
    if (event.button === 0) api?.window?.getCurrentWindow().startDragging().catch(error => notice(String(error), true));
});
on(window, 'storage', event => { if (event.key === STORAGE_KEY || event.key === null) refresh(); });
on(window, CHANGED_EVENT, refresh);
on(window, 'focus', refresh);
on(document, 'visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
on(window, 'pagehide', () => {
    disposed = true; clearTimeout(timer); controller.abort(); motion.dispose();
    disposers.splice(0).forEach(dispose => dispose());
});
if (api?.event?.listen) {
    api.event.listen('timetable-widget-power', event => {
        suspended = Boolean(event.payload?.suspended);
        if (suspended) clearTimeout(timer); else refresh();
    }).then(dispose => { if (disposed) dispose(); else disposers.push(dispose); }).catch(error => notice(String(error), true));
} else { byId('ttWidgetPin').disabled = true; byId('ttWidgetClose').disabled = true; }
refresh();
