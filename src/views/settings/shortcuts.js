import { showToast } from '../../core/utils.js';
import {
    DEFAULT_SHORTCUTS,
    SETTINGS_STORAGE_KEYS,
    findShortcutConflict,
    parseStoredShortcuts,
    shortcutFromKeyboardEvent
} from './model.js';

class ShortcutManager {
    constructor() {
        this.currentRecording = null;
        this.shortcuts = { ...DEFAULT_SHORTCUTS };
        this.initialized = false;
        this.abortController = null;
    }

    init() {
        if (this.initialized) return;
        const container = document.getElementById('shortcutBindings');
        if (!container) return;

        this.initialized = true;
        this.abortController = new AbortController();
        const { signal } = this.abortController;
        this.shortcuts = parseStoredShortcuts(localStorage.getItem(SETTINGS_STORAGE_KEYS.SHORTCUTS));

        container.querySelectorAll('.settings-shortcut-item').forEach(item => {
            const id = item.dataset.shortcutId;
            if (!this.shortcuts[id]) this.shortcuts[id] = item.dataset.default;
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            item.setAttribute('aria-label', `${this.getShortcutLabel(id)}，当前快捷键 ${this.shortcuts[id]}，按回车修改`);
            this.renderShortcut(item, this.shortcuts[id]);
            item.addEventListener('dblclick', () => this.startRecording(item), { signal });
            item.addEventListener('keydown', event => {
                if (!this.currentRecording && ['Enter', ' '].includes(event.key)) {
                    event.preventDefault();
                    this.startRecording(item);
                }
            }, { signal });
        });

        document.addEventListener('keydown', event => this.handleKeyDown(event), { signal, capture: true });
        document.addEventListener('click', event => {
            if (this.currentRecording && !event.target.closest('.settings-shortcut-item')) this.cancelRecording();
        }, { signal });
    }

    startRecording(item) {
        this.cancelRecording();
        this.currentRecording = item;
        item.classList.add('recording');
        item.setAttribute('aria-pressed', 'true');
        const keysContainer = item.querySelector('.settings-shortcut-keys');
        keysContainer.replaceChildren(this.createKeyElement('请按新组合键', 'settings-key--recording-prompt'));
    }

    cancelRecording() {
        if (!this.currentRecording) return;
        const item = this.currentRecording;
        item.classList.remove('recording');
        item.removeAttribute('aria-pressed');
        this.renderShortcut(item, this.shortcuts[item.dataset.shortcutId]);
        this.currentRecording = null;
    }

    handleKeyDown(event) {
        if (!this.currentRecording) return;
        event.preventDefault();
        event.stopPropagation();

        const candidate = shortcutFromKeyboardEvent(event);
        if (!candidate) return;
        if (candidate === 'Escape') {
            this.cancelRecording();
            return;
        }

        const item = this.currentRecording;
        const shortcutId = item.dataset.shortcutId;
        const conflict = findShortcutConflict(this.shortcuts, shortcutId, candidate);
        if (conflict) {
            showToast(`快捷键 ${candidate} 已被“${this.getShortcutLabel(conflict[0])}”使用`, 'error');
            return;
        }

        this.shortcuts[shortcutId] = candidate;
        localStorage.setItem(SETTINGS_STORAGE_KEYS.SHORTCUTS, JSON.stringify(this.shortcuts));
        item.classList.remove('recording');
        item.removeAttribute('aria-pressed');
        this.renderShortcut(item, candidate);
        item.setAttribute('aria-label', `${this.getShortcutLabel(shortcutId)}，当前快捷键 ${candidate}，按回车修改`);
        this.currentRecording = null;
        showToast(`快捷键已更新为 ${candidate}`);
    }

    getShortcutLabel(shortcutId) {
        return document.querySelector(`[data-shortcut-id="${shortcutId}"] .settings-shortcut-label`)?.textContent?.trim() || shortcutId;
    }

    createKeyElement(label, extraClass = '') {
        const element = document.createElement('span');
        element.className = `settings-key${extraClass ? ` ${extraClass}` : ''}`;
        element.textContent = label;
        return element;
    }

    renderShortcut(item, shortcut) {
        const container = item.querySelector('.settings-shortcut-keys');
        if (!container || !shortcut) return;

        const fragment = document.createDocumentFragment();
        shortcut.split('+').forEach((key, index, keys) => {
            fragment.appendChild(this.createKeyElement(key));
            if (index < keys.length - 1) {
                const plus = document.createElement('span');
                plus.className = 'settings-key-plus';
                plus.textContent = '+';
                fragment.appendChild(plus);
            }
        });
        container.replaceChildren(fragment);
    }

    getShortcut(shortcutId) {
        return this.shortcuts[shortcutId];
    }
}

export const shortcutManager = new ShortcutManager();
globalThis.window.shortcutManager = shortcutManager;
