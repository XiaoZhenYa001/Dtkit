import { isAutoDetectEnabled, setAutoDetectEnabled } from '../../core/mirrorSource.js';
import { showToast } from '../../core/utils.js';
import { SETTINGS_STORAGE_KEYS, parseCustomMirrorConfig } from './model.js';
import { createModalController } from './modal.js';

let initialized = false;

function readSavedConfig() {
    const serialized = localStorage.getItem(SETTINGS_STORAGE_KEYS.CUSTOM_MIRROR);
    if (!serialized) return null;
    try {
        return parseCustomMirrorConfig(serialized);
    } catch (error) {
        console.warn('忽略无效的自定义镜像源配置:', error.message);
        return null;
    }
}

function updateCustomOption(select, config) {
    const option = select?.querySelector('option[value="custom"]');
    if (!option || !config) return;
    option.textContent = `⚙️ ${config.name}`;
    option.dataset.url = config.url;
}

function setValidationMessage(element, message = '') {
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
}

function setPingStatus(element, icon, text, state = '') {
    if (!element) return;
    const iconElement = document.createElement('i');
    iconElement.className = icon;
    const textElement = document.createElement('span');
    textElement.textContent = text;
    element.dataset.state = state;
    element.replaceChildren(iconElement, textElement);
}

export function initMirrorSourceSettings() {
    if (initialized) return;

    const configButton = document.getElementById('configCustomSourceBtn');
    const dialog = document.getElementById('customSourceDialog');
    const textarea = document.getElementById('customSourceInput');
    const select = document.getElementById('mirrorSourceSelect');
    const speedButton = document.getElementById('testMirrorSpeedBtn');
    const statusBadge = document.getElementById('mirrorPingStatus');
    const autoDetectToggle = document.getElementById('autoMirrorDetect');
    const validationMessage = document.getElementById('customSourceError');
    const confirmButton = document.getElementById('confirmCustomSource');
    if (!configButton || !dialog || !textarea || !select || !confirmButton) return;
    initialized = true;

    updateCustomOption(select, readSavedConfig());
    if (autoDetectToggle) {
        autoDetectToggle.checked = isAutoDetectEnabled();
        autoDetectToggle.addEventListener('change', () => {
            setAutoDetectEnabled(autoDetectToggle.checked);
            showToast(autoDetectToggle.checked ? '智能镜像检测已启用' : '智能镜像检测已禁用');
        });
    }

    const modal = createModalController({
        dialog,
        closeTriggers: [
            document.getElementById('closeCustomSourceDialog'),
            document.getElementById('cancelCustomSource')
        ],
        initialFocus: () => textarea,
        onClose() {
            textarea.value = '';
            setValidationMessage(validationMessage);
        }
    });

    configButton.addEventListener('click', () => {
        const savedConfig = readSavedConfig();
        textarea.value = savedConfig ? JSON.stringify(savedConfig, null, 2) : '';
        setValidationMessage(validationMessage);
        modal.open(configButton);
    });

    confirmButton.addEventListener('click', () => {
        try {
            const config = parseCustomMirrorConfig(textarea.value);
            localStorage.setItem(SETTINGS_STORAGE_KEYS.CUSTOM_MIRROR, JSON.stringify(config));
            updateCustomOption(select, config);
            select.value = 'custom';
            modal.close('saved');
            showToast('自定义镜像源配置成功', 'success');
        } catch (error) {
            setValidationMessage(validationMessage, error.message);
            textarea.focus();
        }
    });

    speedButton?.addEventListener('click', async () => {
        const selectedOption = select.options[select.selectedIndex];
        const url = selectedOption?.dataset?.url;
        if (!url) {
            showToast('当前镜像源未配置 URL', 'error');
            return;
        }

        setPingStatus(statusBadge, 'ri-loader-4-line settings-spin', '测速中', 'loading');
        speedButton.disabled = true;
        try {
            const startTime = performance.now();
            await fetch(url, { method: 'HEAD', mode: 'no-cors' });
            const ping = Math.round(performance.now() - startTime);
            setPingStatus(statusBadge, 'ri-wifi-line', `${ping}ms`, 'success');
            showToast(`镜像延迟：${ping}ms`, 'success');
        } catch {
            setPingStatus(statusBadge, 'ri-wifi-off-line', '超时', 'error');
            showToast('测速失败，请检查网络或镜像源地址', 'error');
        } finally {
            speedButton.disabled = false;
        }
    });
}
