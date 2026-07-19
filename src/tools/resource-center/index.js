import { registerTool } from '../toolRegistry.js';
import { getMinimizeMode, setMinimizeMode } from '../../core/minimizeMode.js';
import '../../css/tools/resource-center.css';

let controller = null;
let policy = null;

const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke(command, args);
const byId = id => document.getElementById(id);

function template() {
    return `
        <div class="resource-tool-shell">
            <header class="resource-hero">
                <div><span class="resource-kicker">RESOURCE CONTROL</span><h2>资源控制中心</h2>
                    <p>按需查看当前资源状态，调整低能耗策略。此页面不进行后台轮询。</p></div>
                <div class="resource-actions">
                    <button id="resourceRelease" class="resource-button resource-button--secondary" type="button"><i class="ri-leaf-line"></i> 释放空闲资源</button>
                    <button id="resourceRefresh" class="resource-button resource-button--primary" type="button"><i class="ri-refresh-line"></i> 刷新快照</button>
                </div>
            </header>

            <section class="resource-card" aria-labelledby="resourceSnapshotTitle">
                <div class="resource-section-heading"><div><span class="resource-kicker">ONE-SHOT SNAPSHOT</span><h3 id="resourceSnapshotTitle">当前状态</h3></div><span id="resourceCapturedAt">尚未采集</span></div>
                <div id="resourceMetrics" class="resource-metrics" aria-live="polite"></div>
                <p class="resource-caption"><i class="ri-information-line"></i> 内存数据仅指 DtKit 原生进程工作集，不包含 WebView2 子进程；请以 Windows 任务管理器中的进程组总量为准。</p>
            </section>

            <div class="resource-layout">
                <section class="resource-card" aria-labelledby="resourceStorageTitle">
                    <div class="resource-section-heading"><div><span class="resource-kicker">MANAGED STORAGE</span><h3 id="resourceStorageTitle">受管存储</h3></div><strong id="resourceStorageTotal">—</strong></div>
                    <div id="resourceStorage" class="resource-storage"></div>
                    <p class="resource-caption">这里只统计 DtKit 管理的缓存、日志、中转、任务与恢复区；可在设置中手动或自动清理。</p>
                </section>

                <section class="resource-card" aria-labelledby="resourcePolicyTitle">
                    <div class="resource-section-heading"><div><span class="resource-kicker">POLICY</span><h3 id="resourcePolicyTitle">能耗策略</h3></div><span>保存后立即生效</span></div>
                    <form id="resourcePolicyForm" class="resource-policy-form">
                        <fieldset><legend>最小化行为</legend><div class="resource-mode-options">
                            <label><input type="radio" name="minimizeMode" value="standard"><span><strong>标准</strong><small>保留页面，恢复最快</small></span></label>
                            <label><input type="radio" name="minimizeMode" value="efficient"><span><strong>节能</strong><small>释放页面资源，推荐</small></span></label>
                            <label><input type="radio" name="minimizeMode" value="deep"><span><strong>深度休眠</strong><small>销毁 WebView，内存最低</small></span></label>
                        </div></fieldset>
                        <div class="resource-policy-grid">
                            <label><span>电池并发任务</span><input id="resourceBatteryWorkers" type="number" min="1" max="16" required><small>1–16，未知电源时也采用此值</small></label>
                            <label><span>接通电源并发任务</span><input id="resourceAcWorkers" type="number" min="1" max="32" required><small>不得低于电池并发数</small></label>
                            <label><span>标准模式快捷窗保留</span><div class="resource-input-unit"><input id="resourceStandardRetention" type="number" min="0" max="600" required><span>秒</span></div></label>
                            <label><span>节能模式快捷窗保留</span><div class="resource-input-unit"><input id="resourceEfficientRetention" type="number" min="0" max="120" required><span>秒</span></div></label>
                            <label><span>缓存上限</span><div class="resource-input-unit"><input id="resourceCacheLimit" type="number" min="10" max="10240" required><span>MB</span></div></label>
                            <label><span>缓存保留</span><div class="resource-input-unit"><input id="resourceCacheDays" type="number" min="0" max="365" required><span>天</span></div></label>
                            <label><span>日志保留</span><div class="resource-input-unit"><input id="resourceLogDays" type="number" min="0" max="365" required><span>天</span></div></label>
                        </div>
                        <div class="resource-form-footer"><p><i class="ri-shield-check-line"></i> 释放操作不会中断正在执行的任务、提醒或局域网分享。</p><button class="resource-button resource-button--primary" type="submit">保存策略</button></div>
                    </form>
                </section>
            </div>
            <p id="resourceStatus" class="resource-status" role="status" aria-live="polite"></p>
        </div>`;
}

function formatBytes(value) {
    if (value === null || value === undefined) return '不可用';
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function setStatus(message, type = '') {
    const node = byId('resourceStatus');
    if (!node) return;
    node.textContent = message;
    node.dataset.type = type;
}

function metric(icon, label, value, detail) {
    const node = document.createElement('article');
    node.className = 'resource-metric';
    const iconNode = document.createElement('i'); iconNode.className = icon;
    const body = document.createElement('div');
    const labelNode = document.createElement('span'); labelNode.textContent = label;
    const valueNode = document.createElement('strong'); valueNode.textContent = value;
    const detailNode = document.createElement('small'); detailNode.textContent = detail;
    body.append(labelNode, valueNode, detailNode); node.append(iconNode, body);
    return node;
}

function renderSnapshot(snapshot) {
    const power = { ac: ['接通电源', '按交流电策略运行'], battery: ['电池供电', '自动限制后台并发'], unknown: ['电源未知', '保守采用电池策略'] }[snapshot.powerSource] || ['未知', '采用低能耗策略'];
    const mode = { standard: '标准', efficient: '节能', deep: '深度休眠' }[snapshot.mode] || snapshot.mode;
    byId('resourceMetrics').replaceChildren(
        metric('ri-ram-2-line', '原生进程内存', formatBytes(snapshot.nativeWorkingSetBytes), '不含 WebView2 子进程'),
        metric('ri-window-line', 'WebView 窗口', String(snapshot.webviewCount), `主窗口 ${snapshot.mainWindowOpen ? '存在' : '已释放'} · 快捷窗 ${snapshot.quickHostOpen ? '存在' : '已释放'}`),
        metric('ri-battery-charge-line', '电源与并发', power[0], `${power[1]} · 上限 ${snapshot.effectiveWorkerLimit}`),
        metric('ri-loader-4-line', '后台任务', String(snapshot.activeJobs), `保留 ${snapshot.recordedJobs} 条任务记录`),
        metric('ri-command-line', '全局快捷键', String(snapshot.registeredShortcuts), '仅注册用户主动绑定的项目'),
        metric('ri-leaf-line', '当前模式', mode, snapshot.lanShareActive ? '局域网分享正在运行' : '无局域网分享')
    );
    byId('resourceCapturedAt').textContent = `采集于 ${new Date(snapshot.capturedAt).toLocaleTimeString()}`;
    renderStorage(snapshot.storage);
}

function renderStorage(storage) {
    const entries = [
        ['缓存', storage.cacheBytes], ['日志', storage.logBytes], ['临时中转', storage.tempTransferBytes],
        ['任务数据', storage.jobBytes], ['恢复区', storage.recoveryBytes]
    ];
    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    byId('resourceStorageTotal').textContent = formatBytes(total);
    const max = Math.max(...entries.map(([, value]) => value), 1);
    byId('resourceStorage').replaceChildren(...entries.map(([label, value]) => {
        const row = document.createElement('div'); row.className = 'resource-storage-row';
        const heading = document.createElement('div');
        const name = document.createElement('span'); name.textContent = label;
        const amount = document.createElement('strong'); amount.textContent = formatBytes(value);
        heading.append(name, amount);
        const track = document.createElement('div'); track.className = 'resource-storage-track';
        const fill = document.createElement('span'); fill.style.width = `${Math.max(value ? 3 : 0, (value / max) * 100)}%`;
        track.append(fill); row.append(heading, track); return row;
    }));
}

function fillPolicy(nextPolicy) {
    policy = nextPolicy;
    const mode = getMinimizeMode();
    const radio = byId('resourcePolicyForm')?.querySelector(`input[name="minimizeMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    byId('resourceBatteryWorkers').value = policy.maxWorkersOnBattery;
    byId('resourceAcWorkers').value = policy.maxWorkersOnAc;
    byId('resourceStandardRetention').value = policy.quickHostStandardRetentionSeconds;
    byId('resourceEfficientRetention').value = policy.quickHostEfficientRetentionSeconds;
    byId('resourceCacheLimit').value = Math.round(policy.cacheLimitBytes / 1024 / 1024);
    byId('resourceCacheDays').value = policy.cacheRetentionDays;
    byId('resourceLogDays').value = policy.logRetentionDays;
}

async function refreshSnapshot() {
    const button = byId('resourceRefresh');
    if (button) button.disabled = true;
    try {
        renderSnapshot(await invoke('get_resource_snapshot'));
        setStatus('资源快照已更新。', 'success');
    } catch (error) { setStatus(`读取资源状态失败：${error}`, 'error'); }
    finally { if (button) button.disabled = false; }
}

async function savePolicy(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const nextPolicy = {
        quickHostStandardRetentionSeconds: Number(byId('resourceStandardRetention').value),
        quickHostEfficientRetentionSeconds: Number(byId('resourceEfficientRetention').value),
        maxWorkersOnBattery: Number(byId('resourceBatteryWorkers').value),
        maxWorkersOnAc: Number(byId('resourceAcWorkers').value),
        cacheLimitBytes: Number(byId('resourceCacheLimit').value) * 1024 * 1024,
        cacheRetentionDays: Number(byId('resourceCacheDays').value),
        logRetentionDays: Number(byId('resourceLogDays').value)
    };
    if (nextPolicy.maxWorkersOnBattery > nextPolicy.maxWorkersOnAc) {
        setStatus('接通电源并发数不能低于电池并发数。', 'error'); return;
    }
    const mode = new FormData(event.currentTarget).get('minimizeMode');
    try {
        await invoke('set_resource_policy', { policy: nextPolicy });
        await setMinimizeMode(mode);
        policy = nextPolicy;
        setStatus('资源策略已保存并立即生效。', 'success');
        await refreshSnapshot();
    } catch (error) { setStatus(`保存失败：${error}`, 'error'); }
}

async function releaseIdle() {
    const button = byId('resourceRelease');
    if (button) button.disabled = true;
    try {
        const result = await invoke('release_idle_resources');
        const released = [result.quickHostReleased && '快捷窗', result.hiddenOrganizerReleased && '隐藏桌面整理窗口', result.nativeWorkingSetTrimmed && '原生工作集'].filter(Boolean);
        if (!result.quickHostReleased) await refreshSnapshot();
        setStatus(released.length ? `已释放：${released.join('、')}。` : '当前没有可释放的空闲页面资源。', 'success');
    } catch (error) { setStatus(`释放失败：${error}`, 'error'); }
    finally { if (button) button.disabled = false; }
}

async function initResourceCenter() {
    controller?.abort(); controller = new AbortController();
    const { signal } = controller;
    byId('resourceRefresh')?.addEventListener('click', refreshSnapshot, { signal });
    byId('resourceRelease')?.addEventListener('click', releaseIdle, { signal });
    byId('resourcePolicyForm')?.addEventListener('submit', savePolicy, { signal });
    try {
        const [nextPolicy, snapshot] = await Promise.all([invoke('get_resource_policy'), invoke('get_resource_snapshot')]);
        if (signal.aborted) return;
        fillPolicy(nextPolicy); renderSnapshot(snapshot); setStatus('仅在打开页面或手动刷新时采集数据。');
    } catch (error) { setStatus(`资源中心初始化失败：${error}`, 'error'); }
}

function destroyResourceCenter() { controller?.abort(); controller = null; policy = null; }

registerTool({
    id: 'resource-center', name: '资源控制中心', icon: 'ri-dashboard-line', colorClass: 'tool-card__icon--green',
    category: 'utility', status: 'ready', description: '按需查看资源快照并配置低能耗策略。',
    template, init: initResourceCenter, destroy: destroyResourceCenter
});

export { destroyResourceCenter, initResourceCenter };
