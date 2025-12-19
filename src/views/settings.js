/**
 * 设置视图 - 包含下载路径和快捷键绑定
 */
import appState, { saveDownloadPath } from '../core/state.js';
import { showToast } from '../core/utils.js';

// ============================================
// 下载路径设置
// ============================================

/**
 * 初始化下载路径设置
 */
export function initDownloadPathSettings() {
    const downloadPathInput = document.getElementById('downloadPathInput');
    const changeDownloadPathBtn = document.getElementById('changeDownloadPathBtn');
    const browseDownloadPathBtn = document.getElementById('browseDownloadPathBtn');
    
    // 初始化输入框显示当前路径
    if (downloadPathInput) {
        downloadPathInput.value = appState.settings.downloadPath;
    }
    
    // 点击"更改目录"按钮，保存输入框中的路径
    if (changeDownloadPathBtn) {
        changeDownloadPathBtn.addEventListener('click', () => {
            const newPath = downloadPathInput?.value?.trim();
            if (newPath) {
                saveDownloadPath(newPath);
                showToast('下载路径已更新');
            } else {
                showToast('请输入有效的路径', 'error');
            }
        });
    }
    
    // 点击文件夹图标，打开文件夹选择对话框
    if (browseDownloadPathBtn) {
        browseDownloadPathBtn.addEventListener('click', async () => {
            await selectDownloadFolder();
        });
    }
}

/**
 * 使用 Tauri dialog API 选择文件夹
 */
async function selectDownloadFolder() {
    try {
        if (window.__TAURI__) {
            const { open } = window.__TAURI__.dialog;
            const selected = await open({
                directory: true,
                multiple: false,
                title: '选择下载文件夹',
                defaultPath: appState.settings.downloadPath
            });
            
            if (selected) {
                saveDownloadPath(selected);
                // 更新输入框
                const input = document.getElementById('downloadPathInput');
                if (input) input.value = selected;
                showToast('下载路径已更新');
            }
        } else {
            showToast('请在输入框中手动输入路径', 'info');
        }
    } catch (error) {
        console.error('选择文件夹失败:', error);
        showToast('选择文件夹失败: ' + error.message, 'error');
    }
}

// ============================================
// 快捷键绑定管理
// ============================================

export const shortcutManager = {
    currentRecording: null,
    shortcuts: {},
    
    init() {
        const saved = localStorage.getItem('dtkit_shortcuts');
        if (saved) {
            this.shortcuts = JSON.parse(saved);
        }
        
        this.initShortcutItems();
        
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
        
        document.addEventListener('click', (e) => {
            if (this.currentRecording && !e.target.closest('.settings-shortcut-item')) {
                this.cancelRecording();
            }
        });
    },
    
    initShortcutItems() {
        const container = document.getElementById('shortcutBindings');
        if (!container) return;
        
        const items = container.querySelectorAll('.settings-shortcut-item');
        items.forEach(item => {
            const shortcutId = item.dataset.shortcutId;
            const defaultValue = item.dataset.default;
            
            if (!this.shortcuts[shortcutId]) {
                this.shortcuts[shortcutId] = defaultValue;
            }
            
            this.updateShortcutDisplay(item, this.shortcuts[shortcutId]);
            
            item.addEventListener('dblclick', () => this.startRecording(item));
        });
    },
    
    startRecording(item) {
        if (this.currentRecording) {
            this.cancelRecording();
        }
        
        this.currentRecording = item;
        item.classList.add('recording');
        
        const keysContainer = item.querySelector('.settings-shortcut-keys');
        keysContainer.innerHTML = '<span class="settings-key" style="min-width: 120px; color: var(--color-primary);">按下新快捷键...</span>';
    },
    
    cancelRecording() {
        if (!this.currentRecording) return;
        
        const item = this.currentRecording;
        const shortcutId = item.dataset.shortcutId;
        
        item.classList.remove('recording');
        this.updateShortcutDisplay(item, this.shortcuts[shortcutId]);
        this.currentRecording = null;
    },
    
    handleKeyDown(e) {
        if (!this.currentRecording) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
            return;
        }
        
        if (e.key === 'Escape') {
            this.cancelRecording();
            return;
        }
        
        const keys = [];
        if (e.ctrlKey) keys.push('Ctrl');
        if (e.shiftKey) keys.push('Shift');
        if (e.altKey) keys.push('Alt');
        if (e.metaKey) keys.push('Win');
        
        let keyName = e.key;
        
        const keyNameMap = {
            ' ': 'Space',
            'ArrowUp': '↑',
            'ArrowDown': '↓',
            'ArrowLeft': '←',
            'ArrowRight': '→',
            'Backspace': 'Backspace',
            'Delete': 'Delete',
            'Enter': 'Enter',
            'Tab': 'Tab',
            'Home': 'Home',
            'End': 'End',
            'PageUp': 'PageUp',
            'PageDown': 'PageDown',
            'Insert': 'Insert'
        };
        
        if (keyNameMap[keyName]) {
            keyName = keyNameMap[keyName];
        } else if (keyName.length === 1) {
            keyName = keyName.toUpperCase();
        }
        
        keys.push(keyName);
        
        const shortcutString = keys.join('+');
        
        const item = this.currentRecording;
        const shortcutId = item.dataset.shortcutId;
        
        const conflict = Object.entries(this.shortcuts).find(
            ([id, value]) => id !== shortcutId && value === shortcutString
        );
        
        if (conflict) {
            showToast(`快捷键 ${shortcutString} 已被"${this.getShortcutLabel(conflict[0])}"使用`, 'error');
            return;
        }
        
        this.shortcuts[shortcutId] = shortcutString;
        this.saveShortcuts();
        
        item.classList.remove('recording');
        this.updateShortcutDisplay(item, shortcutString);
        this.currentRecording = null;
        
        showToast(`快捷键已更新为 ${shortcutString}`);
    },
    
    getShortcutLabel(shortcutId) {
        const item = document.querySelector(`[data-shortcut-id="${shortcutId}"]`);
        if (item) {
            const label = item.querySelector('.settings-shortcut-label');
            return label ? label.textContent : shortcutId;
        }
        return shortcutId;
    },
    
    updateShortcutDisplay(item, shortcutString) {
        const keysContainer = item.querySelector('.settings-shortcut-keys');
        if (!keysContainer || !shortcutString) return;
        
        const keys = shortcutString.split('+');
        const html = keys.map((key, index) => {
            const keyHtml = `<span class="settings-key">${key}</span>`;
            if (index < keys.length - 1) {
                return keyHtml + ' <span class="settings-key-plus">+</span> ';
            }
            return keyHtml;
        }).join('');
        
        keysContainer.innerHTML = html;
    },
    
    saveShortcuts() {
        localStorage.setItem('dtkit_shortcuts', JSON.stringify(this.shortcuts));
    },
    
    getShortcut(shortcutId) {
        return this.shortcuts[shortcutId];
    }
};

// 挂载到 window
window.shortcutManager = shortcutManager;

/**
 * 初始化所有设置
 */
export function initSettings() {
    initDownloadPathSettings();
    shortcutManager.init();
}
