import { showToast } from '../../core/utils.js';
import { shortcutFromKeyboardEvent } from './model.js';

const SHORTCUT_TARGETS = Object.freeze([
    { key: 'palette', label: '万能命令面板', icon: 'ri-terminal-box-line', target: { kind: 'palette' } },
    { key: 'tool:timestamp-converter', label: '时间戳转换', icon: 'ri-time-line' },
    { key: 'tool:json-formatter', label: 'JSON 格式化', icon: 'ri-braces-line' },
    { key: 'tool:base64-codec', label: 'Base64 编解码', icon: 'ri-lock-2-line' },
    { key: 'tool:hash-tool', label: 'MD5 / Hash', icon: 'ri-hashtag' },
    { key: 'tool:qr-generator', label: '二维码生成', icon: 'ri-qr-code-line' },
    { key: 'tool:color-picker', label: '颜色提取器', icon: 'ri-palette-line' },
    { key: 'tool:html-preview', label: 'HTML 预览', icon: 'ri-code-box-line' },
    { key: 'tool:url-encoder', label: 'URL 编码', icon: 'ri-global-line' },
    { key: 'tool:crontab-explainer', label: 'Crontab 解释', icon: 'ri-terminal-box-line' },
    { key: 'tool:unit-converter', label: '单位换算', icon: 'ri-calculator-line' },
    { key: 'tool:alarm-clock', label: '定时闹钟', icon: 'ri-alarm-line' },
    { key: 'tool:file-batch', label: '文件批处理', icon: 'ri-file-list-3-line' },
    { key: 'tool:transfer-station', label: '临时文件中转站', icon: 'ri-box-3-line' },
    { key: 'tool:resource-center', label: '资源控制中心', icon: 'ri-dashboard-line' }
].map(item => Object.freeze({
    ...item,
    target: item.target || { kind: 'tool', toolId: item.key.slice(5) }
})));

const TARGET_BY_KEY = new Map(SHORTCUT_TARGETS.map(item => [item.key, item]));

function targetKey(target) {
    return target?.kind === 'palette' ? 'palette' : `tool:${target?.toolId || ''}`;
}

function displayKeys(accelerator) {
    return accelerator
        .replace(/Control/gi, 'Ctrl')
        .replace(/Super/gi, 'Win')
        .replace(/ArrowUp/g, '↑')
        .replace(/ArrowDown/g, '↓')
        .replace(/ArrowLeft/g, '←')
        .replace(/ArrowRight/g, '→')
        .split('+');
}

class ShortcutManager {
    constructor() {
        this.currentRecording = null;
        this.bindings = [];
        this.initialized = false;
        this.abortController = null;
        this.container = null;
        this.invoke = null;
        this.ready = false;
    }

    async init() {
        if (this.initialized) return;
        this.container = document.getElementById('shortcutBindings');
        if (!this.container) return;

        this.initialized = true;
        this.abortController = new AbortController();
        this.invoke = globalThis.window?.__TAURI__?.core?.invoke || null;
        this.render();

        const { signal } = this.abortController;
        this.container.addEventListener('click', event => this.handleClick(event), { signal });
        document.addEventListener('keydown', event => this.handleKeyDown(event), { signal, capture: true });
        document.addEventListener('click', event => {
            if (this.currentRecording && !event.target.closest('[data-shortcut-record]')) {
                this.cancelRecording();
            }
        }, { signal, capture: true });

        if (!this.invoke) {
            this.setStatus('请在 DtKit 桌面程序中配置系统级快捷键。', 'muted');
            return;
        }

        try {
            this.bindings = await this.invoke('get_shortcut_bindings');
            this.ready = true;
            this.render();
            this.setStatus(this.bindings.length ? `已启用 ${this.bindings.length} 个快捷键` : '默认不绑定任何快捷键');
        } catch (error) {
            this.setStatus(`读取快捷键失败：${error}`, 'error');
        }
    }

    bindingFor(key) {
        return this.bindings.find(binding => targetKey(binding.target) === key) || null;
    }

    render() {
        const fragment = document.createDocumentFragment();
        for (const item of SHORTCUT_TARGETS) {
            const row = document.createElement('div');
            row.className = 'settings-shortcut-item';
            row.dataset.shortcutTarget = item.key;

            const identity = document.createElement('div');
            identity.className = 'settings-shortcut-identity';
            const icon = document.createElement('i');
            icon.className = item.icon;
            const label = document.createElement('span');
            label.className = 'settings-shortcut-label';
            label.textContent = item.label;
            identity.append(icon, label);

            const controls = document.createElement('div');
            controls.className = 'settings-shortcut-controls';
            const recorder = document.createElement('button');
            recorder.type = 'button';
            recorder.className = 'settings-shortcut-record';
            recorder.dataset.shortcutRecord = item.key;
            recorder.disabled = !this.invoke || !this.ready;
            recorder.setAttribute('aria-label', `设置“${item.label}”的快捷键`);
            this.renderKeys(recorder, this.bindingFor(item.key)?.accelerator);

            const clear = document.createElement('button');
            clear.type = 'button';
            clear.className = 'settings-shortcut-clear';
            clear.dataset.shortcutClear = item.key;
            clear.disabled = !this.invoke || !this.ready || !this.bindingFor(item.key);
            clear.title = `清除“${item.label}”的快捷键`;
            clear.setAttribute('aria-label', clear.title);
            clear.innerHTML = '<i class="ri-close-line"></i>';
            controls.append(recorder, clear);
            row.append(identity, controls);
            fragment.appendChild(row);
        }
        this.container.replaceChildren(fragment);
    }

    renderKeys(container, accelerator) {
        if (!accelerator) {
            const unbound = document.createElement('span');
            unbound.className = 'settings-key settings-key--unbound';
            unbound.textContent = '未绑定';
            container.replaceChildren(unbound);
            return;
        }

        const fragment = document.createDocumentFragment();
        const keys = displayKeys(accelerator);
        keys.forEach((key, index) => {
            const element = document.createElement('span');
            element.className = 'settings-key';
            element.textContent = key;
            fragment.appendChild(element);
            if (index < keys.length - 1) {
                const plus = document.createElement('span');
                plus.className = 'settings-key-plus';
                plus.textContent = '+';
                fragment.appendChild(plus);
            }
        });
        container.replaceChildren(fragment);
    }

    handleClick(event) {
        const clear = event.target.closest('[data-shortcut-clear]');
        if (clear) {
            this.clearBinding(clear.dataset.shortcutClear);
            return;
        }
        const recorder = event.target.closest('[data-shortcut-record]');
        if (recorder) this.startRecording(recorder.dataset.shortcutRecord);
    }

    startRecording(key) {
        if (!this.invoke) return;
        this.cancelRecording();
        this.currentRecording = key;
        const button = this.container.querySelector(`[data-shortcut-record="${key}"]`);
        button?.classList.add('recording');
        if (button) {
            const prompt = document.createElement('span');
            prompt.className = 'settings-key settings-key--recording-prompt';
            prompt.textContent = '请按组合键';
            button.replaceChildren(prompt);
        }
    }

    cancelRecording() {
        if (!this.currentRecording) return;
        const key = this.currentRecording;
        this.currentRecording = null;
        const button = this.container.querySelector(`[data-shortcut-record="${key}"]`);
        button?.classList.remove('recording');
        if (button) this.renderKeys(button, this.bindingFor(key)?.accelerator);
    }

    async handleKeyDown(event) {
        if (!this.currentRecording) return;
        event.preventDefault();
        event.stopPropagation();
        const candidate = shortcutFromKeyboardEvent(event);
        if (!candidate) return;
        if (candidate === 'Escape') {
            this.cancelRecording();
            return;
        }
        if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
            showToast('系统级快捷键至少需要一个修饰键', 'error');
            return;
        }

        const key = this.currentRecording;
        const conflict = this.bindings.find(binding => binding.accelerator === candidate && targetKey(binding.target) !== key);
        if (conflict) {
            showToast(`快捷键 ${candidate} 已被其他工具使用`, 'error');
            return;
        }

        const item = TARGET_BY_KEY.get(key);
        const next = this.bindings.filter(binding => targetKey(binding.target) !== key);
        next.push({ accelerator: candidate, target: item.target, enabled: true });
        await this.save(next, `“${item.label}”快捷键已更新`);
    }

    async clearBinding(key) {
        const item = TARGET_BY_KEY.get(key);
        const next = this.bindings.filter(binding => targetKey(binding.target) !== key);
        await this.save(next, `已清除“${item.label}”快捷键`);
    }

    async save(bindings, successMessage) {
        try {
            this.bindings = await this.invoke('replace_shortcut_bindings', { bindings });
            this.currentRecording = null;
            this.render();
            this.setStatus(this.bindings.length ? `已启用 ${this.bindings.length} 个快捷键` : '默认不绑定任何快捷键');
            showToast(successMessage);
        } catch (error) {
            this.cancelRecording();
            showToast(`快捷键保存失败：${error}`, 'error');
        }
    }

    setStatus(message, tone = '') {
        const status = document.getElementById('shortcutStatus');
        if (!status) return;
        status.textContent = message;
        status.dataset.tone = tone;
    }
}

export const shortcutManager = new ShortcutManager();
