import { currentWeek, dateKey, nextBoundary } from '../tools/timetable/model.js';
import { readState, updateState, STORAGE_KEY, CHANGED_EVENT } from '../tools/timetable/store.js';
import { summary, renderGrid, renderAgenda, applyBackground } from '../tools/timetable/view.js';
const api = window.__TAURI__;
const byId = id => document.getElementById(id);
let state, timer, suspended = false, pinned, busy = false, disposed = false;
const disposers = [];
function notice(message = '', error = false) { byId('ttWidgetNotice').textContent = message; byId('ttWidgetNotice').classList.toggle('is-error', error); }
async function syncPin() {
    if (!api?.core?.invoke || pinned === state.settings.widgetPinned) return;
    const next = state.settings.widgetPinned;
    await api.core.invoke('pin_timetable_widget', { pinned: next }); pinned = next;
}
function render() {
    clearTimeout(timer); if (disposed || !state || suspended || document.hidden) return;
    const week = currentWeek(state), mode = state.settings.widgetMode;
    byId('ttWidgetTitle').textContent = state.semester.name;
    byId('ttWidgetDate').textContent = `${dateKey()} · ${week < 1 ? '尚未开学' : week > state.semester.totalWeeks ? '学期已结束' : `第 ${week} 周`}`;
    byId('ttWidgetSummary').textContent = summary(state);
    byId('ttWidgetMode').textContent = mode === 'today' ? '本周' : '今日';
    byId('ttWidgetPin').setAttribute('aria-pressed', String(state.settings.widgetPinned));
    byId('ttWidgetPin').title = state.settings.widgetPinned ? '取消置顶' : '置顶小部件';
    byId('ttWidgetAgenda').hidden = mode !== 'today'; byId('ttWidgetBoard').hidden = mode !== 'week';
    if (mode === 'today') renderAgenda(byId('ttWidgetAgenda'), state);
    else { renderGrid(byId('ttWidgetGrid'), state, Math.max(1, Math.min(state.semester.totalWeeks, week)), false); applyBackground(byId('ttWidgetBoard'), state.settings.background); }
    syncPin().catch(error => notice(String(error), true));
    timer = setTimeout(render, nextBoundary(state));
}
function refresh() { if (disposed || busy) return; try { state = readState(); notice(); render(); } catch (error) { clearTimeout(timer); notice(error.message, true); } }
async function changeSetting(name, value) {
    if (busy || !state) return;
    busy = true;
    try { state = await updateState(data => { data.settings[name] = value; }); notice(); render(); }
    catch (error) { notice(error.message, true); }
    finally { busy = false; }
}
byId('ttWidgetMode').addEventListener('click', () => changeSetting('widgetMode', state?.settings.widgetMode === 'today' ? 'week' : 'today'));
byId('ttWidgetPin').addEventListener('click', () => changeSetting('widgetPinned', !state?.settings.widgetPinned));
byId('ttWidgetClose').addEventListener('click', async () => { try { await api?.core?.invoke('close_timetable_widget'); } catch (error) { notice(String(error), true); } });
byId('ttWidgetDrag').addEventListener('pointerdown', event => { if (event.button === 0) api?.window?.getCurrentWindow().startDragging().catch(error => notice(String(error), true)); });
window.addEventListener('storage', event => { if (event.key === STORAGE_KEY || event.key === null) refresh(); });
window.addEventListener(CHANGED_EVENT, refresh);
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(timer); disposers.forEach(dispose => dispose()); });
if (api?.event?.listen) {
    api.event.listen('timetable-widget-power', event => { suspended = Boolean(event.payload?.suspended); if (suspended) clearTimeout(timer); else refresh(); }).then(dispose => { if (disposed) dispose(); else disposers.push(dispose); }).catch(error => notice(String(error), true));
} else { byId('ttWidgetPin').disabled = true; byId('ttWidgetClose').disabled = true; }
refresh();
