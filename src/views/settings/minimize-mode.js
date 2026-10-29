import { getMinimizeMode, setMinimizeMode } from '../../core/minimizeMode.js';

let initialized = false;

function updateSelection(container, mode) {
    container.querySelectorAll('[data-minimize-mode]').forEach(option => {
        const selected = option.dataset.minimizeMode === mode;
        option.classList.toggle('minimize-mode-option--selected', selected);
        option.querySelector('input').checked = selected;
    });
}

export function initMinimizeModeSettings() {
    const container = document.getElementById('minimizeModeOptions');
    if (!container) return;

    updateSelection(container, getMinimizeMode());
    if (initialized) return;
    initialized = true;
    let saving = false;
    const status = document.createElement('p');
    status.id = 'minimizeModeStatus';
    status.className = 'settings-inline-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    container.insertAdjacentElement('afterend', status);
    const labels = { standard: '标准', efficient: '节能', deep: '深度休眠' };

    container.addEventListener('change', async event => {
        const input = event.target.closest('input[name="minimizeMode"]');
        if (!input) return;
        if (saving) return updateSelection(container, getMinimizeMode());

        const previousMode = getMinimizeMode();
        if (input.value === previousMode) return;
        saving = true;
        updateSelection(container, input.value);
        container.disabled = true;
        container.setAttribute('aria-busy', 'true');
        container.dataset.pendingMode = input.value;
        status.textContent = '正在保存资源策略…';
        status.dataset.tone = 'pending';
        try {
            const savedMode = await setMinimizeMode(input.value);
            updateSelection(container, savedMode);
            status.textContent = `已保存 · ${labels[savedMode]}模式`;
            status.dataset.tone = 'success';
        } catch (error) {
            updateSelection(container, previousMode);
            status.textContent = `保存失败，仍使用${labels[previousMode]}模式：${error}`;
            status.dataset.tone = 'error';
        } finally {
            saving = false;
            container.disabled = false;
            container.removeAttribute('aria-busy');
            delete container.dataset.pendingMode;
        }
    });
}
