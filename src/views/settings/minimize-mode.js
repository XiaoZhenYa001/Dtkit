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

    container.addEventListener('change', async event => {
        const input = event.target.closest('input[name="minimizeMode"]');
        if (!input) return;

        const previousMode = getMinimizeMode();
        updateSelection(container, input.value);
        try {
            const savedMode = await setMinimizeMode(input.value);
            updateSelection(container, savedMode);
        } catch (error) {
            console.error('[MinimizeMode] 保存最小化策略失败', error);
            updateSelection(container, previousMode);
        }
    });
}
