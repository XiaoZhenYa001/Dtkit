import { installToolPageRuntime } from '../core/toolPageRuntime.js';
import { showToast } from '../core/utils.js';

const params = new URLSearchParams(location.search);
const instanceId = params.get('instanceId');
const toolId = params.get('toolId');
let runtime = null;
window.showToast = (...args) => typeof window.parent.showToast === 'function' ? window.parent.showToast(...args) : showToast(...args);
const status = document.getElementById('toolPageStatus');

async function initialize() {
    try {
        runtime = installToolPageRuntime({ instanceId, toolId, embedded: true });
        const registry = await import('../tools/index.js');
        if (runtime.disposed) return;
        const disabled = await window.__TAURI__?.core?.invoke?.('get_tool_module_settings');
        if (runtime.disposed) return;
        registry.applyDisabledTools(Array.isArray(disabled) ? disabled : []);
        const tool = await registry.loadTool(toolId);
        if (runtime.disposed) return;
        if (typeof tool.template !== 'function') throw new Error('工具没有可打开的页面');
        document.getElementById('dynamicToolContainer').innerHTML = tool.template();
        runtime.attachTool(tool);
        await tool.init();
        if (runtime.disposed) return;
        if (toolId === 'alarm-clock') {
            const service = await import('../core/alarmService.js');
            await service.initializeAlarmService();
            if (runtime.disposed) return;
        }
        const snapshot = window.parent.__DTKIT_TOOL_WORKSPACE__?.snapshotFor(instanceId);
        // Restore against the final layout. Removing the loading row afterwards
        // makes Chromium's scroll anchoring shift the restored offset by its height.
        status.hidden = true;
        await runtime.restore(snapshot);
        if (runtime.disposed) return;
        document.title = tool.name;
        window.parent.postMessage({ type: 'dtkit-tool-page-ready', instanceId }, location.origin);
    } catch (error) {
        status.hidden = false;
        status.textContent = `工具加载失败：${String(error?.message || error)}`;
    }
}
initialize();
