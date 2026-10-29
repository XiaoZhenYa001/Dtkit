import { registerTool } from '../toolRegistry.js';
import { explainCron, getNextOccurrences, parseCronStart } from './core.js';
import '../../css/tools/crontab-explainer.css';

let state = null;

function getTemplate() {
    return `
        <div class="cron-tool">
            <header class="cron-hero">
                <div><span class="cron-kicker">CRONTAB · 5 FIELDS</span><h2>读懂每一次执行</h2>
                    <p>把五段时间规则展开成说明，核对它将在哪些时刻执行。</p></div>
                <div class="cron-format" aria-label="字段顺序：分钟、小时、日期、月份、星期"><span>分</span><span>时</span><span>日</span><span>月</span><span>周</span></div>
            </header>
            <section class="cron-input-card" aria-labelledby="cronInputTitle">
                <div class="cron-section-heading"><label id="cronInputTitle" for="cronInput">Cron 表达式</label><span class="cron-tag">五段 UNIX 规则</span></div>
                <div class="cron-input-row">
                    <input id="cronInput" class="cron-expression-input" type="text" value="*/15 9-18 * * MON-FRI" maxlength="512" spellcheck="false" autocomplete="off" aria-describedby="cronSyntaxHint cronError">
                    <button id="cronExplainBtn" class="btn btn--primary" type="button"><i class="ri-terminal-box-line" aria-hidden="true"></i> 解释表达式</button>
                </div>
                <p id="cronSyntaxHint" class="cron-muted">支持 *、列表、范围、范围步长、月份 / 星期英文缩写和 @daily 等宏。Enter 立即解释。</p>
                <div class="cron-presets" role="group" aria-label="常用表达式">
                    <button type="button" data-cron-example="*/5 * * * *">每 5 分钟</button>
                    <button type="button" data-cron-example="0 9 * * MON-FRI">工作日 09:00</button>
                    <button type="button" data-cron-example="30 2 1 * *">每月 1 日</button>
                    <button type="button" data-cron-example="@daily">每天午夜</button>
                    <button type="button" data-cron-example="0 0 29 FEB *">闰年 2 月 29 日</button>
                </div>
                <div id="cronError" class="cron-error" role="alert" hidden></div>
            </section>
            <section id="cronResult" class="cron-result" aria-labelledby="cronResultTitle">
                <div class="cron-summary-card">
                    <span id="cronResultTitle" class="cron-kicker">规则说明</span><strong id="cronSummary">—</strong>
                    <div class="cron-normalized-row"><code id="cronNormalized">—</code><button id="cronCopyBtn" class="cron-button" type="button"><i class="ri-file-copy-line" aria-hidden="true"></i> 复制表达式</button></div>
                    <p id="cronDayRule" class="cron-muted"></p>
                </div>
                <div id="cronFieldGrid" class="cron-field-grid"></div>
            </section>
            <section class="cron-upcoming-card" aria-labelledby="cronUpcomingTitle">
                <div class="cron-section-heading"><h3 id="cronUpcomingTitle">接下来 5 次</h3><button id="cronCopyScheduleBtn" class="cron-button" type="button"><i class="ri-file-copy-line" aria-hidden="true"></i> 复制时间表</button></div>
                <div class="cron-calculation-settings">
                    <label>计算时区<select id="cronTimeZone"><option value="local">本地时间</option><option value="utc">UTC</option></select></label>
                    <label class="cron-from-field">从这个时刻之后<input id="cronFrom" type="datetime-local" min="0001-01-01T00:00" max="9969-12-31T23:59" aria-describedby="cronZoneHint"></label>
                    <label>显示次数<select id="cronCount"><option value="5">5 次</option><option value="10">10 次</option><option value="20">20 次</option></select></label>
                    <button id="cronNowBtn" class="cron-button" type="button">从现在算</button>
                </div>
                <p id="cronZoneHint" class="cron-muted"></p>
                <p id="cronScheduleNote" class="cron-schedule-note" role="status"></p>
                <ol id="cronUpcoming" class="cron-upcoming-list"></ol>
            </section>
            <div id="cronStatus" class="cron-status" role="status" aria-live="polite"></div>
            <details class="cron-help"><summary>语法与计算说明</summary><div>
                <p>只解析五段时间规则，不接受命令、秒 / 年字段，以及 Quartz 的 ?、L、W、#。单值步长请写成范围，例如 5-59/10。</p>
                <p>采用 Cronie 风格的日 / 周匹配：任一字段以 * 开头时，两项同时匹配；否则日期或星期任意一项匹配即可。步长只在当前字段内展开，例如 */35 分钟表示每小时的第 0、35 分钟。</p>
                <p>时间表严格晚于起算时刻，最多检索未来 30 个日历年。本地模式按实际分钟匹配：跳过夏令时不存在的时刻，回拨时保留两次匹配并显示 UTC 偏移。真实调度器可能另有补偿策略，请结合运行环境核对。</p>
                <p>起算时刻留空时使用点击计算的当前时间。切换本地 / UTC 后，同一输入按新时区重新解释；本地重复时刻按浏览器规则选择较早的一次。</p>
            </div></details>
        </div>`;
}

function node(view, id) { return view.root.querySelector('#' + id); }
function active(view) { return state === view && !view.controller.signal.aborted && view.root.isConnected; }
function selectedZone(view) { return node(view, 'cronTimeZone').value === 'utc' ? 'utc' : 'local'; }
function formatOccurrence(date, zone) {
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23', timeZone: zone === 'utc' ? 'UTC' : undefined, timeZoneName: 'longOffset'
    }).format(date);
}

function updateZoneHint(view) {
    const zone = selectedZone(view);
    const label = zone === 'utc' ? 'UTC（零时区）' : Intl.DateTimeFormat().resolvedOptions().timeZone;
    node(view, 'cronZoneHint').textContent = '按 ' + label + ' 解释起算时间与规则；起算时间留空时使用现在。';
    node(view, 'cronUpcomingTitle').textContent = '接下来 ' + node(view, 'cronCount').value + ' 次';
}

function invalidate(view) {
    view.revision++;
    view.attempted = false; view.expression = ''; view.scheduleText = '';
    node(view, 'cronResult').hidden = true;
    node(view, 'cronUpcoming').replaceChildren();
    node(view, 'cronCopyBtn').disabled = true; node(view, 'cronCopyScheduleBtn').disabled = true;
    node(view, 'cronInput').removeAttribute('aria-invalid'); node(view, 'cronError').hidden = true;
    node(view, 'cronScheduleNote').textContent = '输入已更新，点击“解释表达式”或按 Enter 计算。';
    node(view, 'cronStatus').textContent = '';
}

function render(view, savedBase = null) {
    if (!active(view)) return;
    view.revision++;
    view.attempted = true; view.expression = ''; view.scheduleText = '';
    node(view, 'cronCopyBtn').disabled = true; node(view, 'cronCopyScheduleBtn').disabled = true;
    node(view, 'cronUpcoming').replaceChildren(); node(view, 'cronStatus').textContent = '';
    const errorBanner = node(view, 'cronError'); errorBanner.hidden = true;
    node(view, 'cronInput').removeAttribute('aria-invalid');
    node(view, 'cronFrom').removeAttribute('aria-invalid'); updateZoneHint(view);
    let explanation;
    try { explanation = explainCron(node(view, 'cronInput').value); }
    catch (error) {
        errorBanner.textContent = error.message || '无法解析该表达式'; errorBanner.hidden = false;
        node(view, 'cronInput').setAttribute('aria-invalid', 'true'); node(view, 'cronResult').hidden = true;
        node(view, 'cronScheduleNote').textContent = '请先修正表达式，再查看执行时间。'; return;
    }
    view.expression = explanation.normalized;
    node(view, 'cronSummary').textContent = explanation.summary;
    node(view, 'cronNormalized').textContent = explanation.normalized;
    node(view, 'cronDayRule').textContent = explanation.dayRule;
    node(view, 'cronFieldGrid').replaceChildren(...explanation.details.map(detail => {
        const card = document.createElement('article'); card.className = 'cron-field-card'; card.dataset.cronField = detail.key;
        const label = document.createElement('span'); label.textContent = detail.label;
        const source = document.createElement('code'); source.textContent = detail.source;
        const description = document.createElement('strong'); description.textContent = detail.description;
        card.append(label, source, description); return card;
    }));
    node(view, 'cronResult').hidden = false; node(view, 'cronCopyBtn').disabled = false;
    const zone = selectedZone(view);
    let base;
    try {
        if (node(view, 'cronFrom').validity.badInput) throw new TypeError('请选择完整的起算日期与时间');
        base = node(view, 'cronFrom').value ? parseCronStart(node(view, 'cronFrom').value, zone) : new Date(savedBase ?? Date.now());
    } catch (error) {
        node(view, 'cronFrom').setAttribute('aria-invalid', 'true'); node(view, 'cronScheduleNote').textContent = error.message; return;
    }
    view.baseTime = base.getTime();
    try {
        const occurrences = getNextOccurrences(node(view, 'cronInput').value, Number(node(view, 'cronCount').value), base, { timeZone: zone });
        const texts = occurrences.map(date => formatOccurrence(date, zone));
        node(view, 'cronUpcoming').replaceChildren(...texts.map((text, index) => {
            const item = document.createElement('li');
            const number = document.createElement('span'); number.className = 'cron-occurrence-number'; number.textContent = String(index + 1).padStart(2, '0'); number.setAttribute('aria-hidden', 'true');
            const time = document.createElement('time'); time.dateTime = occurrences[index].toISOString(); time.textContent = text;
            item.append(number, time); return item;
        }));
        node(view, 'cronScheduleNote').textContent = '严格晚于 ' + formatOccurrence(base, zone) + '。';
        view.scheduleText = explanation.normalized + '\n' + node(view, 'cronScheduleNote').textContent + '\n' + texts.join('\n');
        node(view, 'cronCopyScheduleBtn').disabled = false;
        node(view, 'cronStatus').textContent = '已展开规则与执行时间。仅用于核对，不会创建定时任务。';
    } catch (error) { node(view, 'cronScheduleNote').textContent = error.message || '未找到执行时间'; }
}

async function copy(view, text) {
    if (!text || view.suspended) return;
    const revision = view.revision;
    const current = () => active(view) && !view.suspended && view.revision === revision;
    try { await navigator.clipboard.writeText(text); if (current()) node(view, 'cronStatus').textContent = '已复制到剪贴板。'; }
    catch { if (current()) node(view, 'cronStatus').textContent = '复制失败，请手动选择文字复制。'; }
}

function initCrontabExplainerTool() {
    destroyCrontabExplainerTool();
    const root = document.querySelector('.cron-tool'); if (!root) return;
    const view = { root, controller: new AbortController(), attempted: false, expression: '', scheduleText: '', baseTime: null,
        revision: 0, suspended: document.hidden || document.documentElement.classList.contains('app-is-suspended') }; state = view;
    const { signal } = view.controller;
    const on = (id, event, listener) => node(view, id).addEventListener(event, listener, { signal });
    on('cronExplainBtn', 'click', () => render(view));
    on('cronInput', 'input', () => invalidate(view));
    on('cronInput', 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); render(view); } });
    for (const id of ['cronTimeZone', 'cronCount', 'cronFrom']) on(id, 'change', () => render(view));
    on('cronFrom', 'input', () => { node(view, 'cronFrom').removeAttribute('aria-invalid'); invalidate(view); });
    on('cronNowBtn', 'click', () => { node(view, 'cronFrom').value = ''; render(view); });
    on('cronCopyBtn', 'click', () => { void copy(view, view.expression); });
    on('cronCopyScheduleBtn', 'click', () => { void copy(view, view.scheduleText); });
    root.querySelectorAll('[data-cron-example]').forEach(button => button.addEventListener('click', () => {
        node(view, 'cronInput').value = button.dataset.cronExample; render(view); node(view, 'cronInput').focus();
    }, { signal }));
    const setSuspended = suspended => { view.suspended = suspended; if (suspended) view.revision++; };
    window.addEventListener('dtkit:power-state', event => setSuspended(Boolean(event.detail?.suspended)), { signal });
    document.addEventListener('visibilitychange', () => setSuspended(document.hidden), { signal });
    render(view);
}

function serializePageDraft() {
    if (!state) return null;
    const input = node(state, 'cronInput');
    return { version: 1, expression: input.value, timeZone: selectedZone(state), from: node(state, 'cronFrom').value,
        count: node(state, 'cronCount').value, attempted: state.attempted, baseTime: state.baseTime,
        selectionStart: input.selectionStart, selectionEnd: input.selectionEnd };
}

function restorePageDraft(snapshot) {
    if (!state || snapshot?.version !== 1) return;
    const view = state;
    const input = node(view, 'cronInput');
    input.value = typeof snapshot.expression === 'string' ? snapshot.expression.slice(0, 512) : '';
    node(view, 'cronTimeZone').value = snapshot.timeZone === 'utc' ? 'utc' : 'local';
    node(view, 'cronFrom').value = typeof snapshot.from === 'string' ? snapshot.from.slice(0, 32) : '';
    node(view, 'cronCount').value = ['5', '10', '20'].includes(String(snapshot.count)) ? String(snapshot.count) : '5';
    updateZoneHint(view);
    if (snapshot.attempted === true) render(view, Number.isFinite(snapshot.baseTime) ? snapshot.baseTime : null);
    else invalidate(view);
    if (Number.isInteger(snapshot.selectionStart) && Number.isInteger(snapshot.selectionEnd)) input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
}

function destroyCrontabExplainerTool() { state?.controller.abort(); state = null; }

registerTool({
    id: 'crontab-explainer', name: 'Crontab 解释', icon: 'ri-terminal-box-line', colorClass: 'tool-card__icon--rose',
    category: 'other', status: 'ready', description: '解释五段 Cron，按本地或 UTC 预览执行时间。',
    template: getTemplate, init: initCrontabExplainerTool, destroy: destroyCrontabExplainerTool,
    serialize: serializePageDraft, restore: restorePageDraft
});

export { destroyCrontabExplainerTool, initCrontabExplainerTool };
