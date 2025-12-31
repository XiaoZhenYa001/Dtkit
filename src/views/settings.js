/**
 * 设置视图 - 包含下载路径和快捷键绑定
 */
import appState, { saveDownloadPath } from '../core/state.js';
import { showToast } from '../core/utils.js';
import { isAutoDetectEnabled, setAutoDetectEnabled } from '../core/mirrorSource.js';

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
    initMirrorSourceSettings();
    initDesktopOrganizerSettings();
    shortcutManager.init();
}

// ============================================
// 桌面整理设置
// ============================================

/**
 * 显示确认对话框
 * @param {string} title - 对话框标题
 * @param {string} message - 对话框消息
 * @returns {Promise<boolean>} - 用户确认返回 true，取消返回 false
 */
function showConfirmDialog(title, message) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('desktopOrganizerConfirmDialog');
        const titleEl = document.getElementById('desktopOrganizerDialogTitle');
        const messageEl = document.getElementById('desktopOrganizerDialogMessage');
        const confirmBtn = document.getElementById('confirmDesktopOrganizer');
        const cancelBtn = document.getElementById('cancelDesktopOrganizer');
        const closeBtn = document.getElementById('closeDesktopOrganizerDialog');
        
        if (!dialog) {
            // 降级到 confirm
            resolve(confirm(message));
            return;
        }
        
        titleEl.textContent = title;
        messageEl.textContent = message;
        dialog.style.display = 'flex';
        
        const cleanup = () => {
            dialog.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
        };
        
        const onConfirm = () => {
            cleanup();
            resolve(true);
        };
        
        const onCancel = () => {
            cleanup();
            resolve(false);
        };
        
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
    });
}

async function initDesktopOrganizerSettings() {
    const mainToggle = document.getElementById('desktopOrganizerToggle');
    const autoAnalyzeToggle = document.getElementById('desktopAutoAnalyzeToggle');
    const subSettings = document.getElementById('desktopOrganizerSubSettings');
    
    if (!mainToggle) return;
    
    // 从本地存储加载设置
    const savedSettings = localStorage.getItem('dtkit_desktop_organizer');
    let settings = {
        enabled: false,
        autoAnalyze: false
    };
    
    if (savedSettings) {
        try {
            settings = JSON.parse(savedSettings);
        } catch (e) {
            console.error('加载桌面整理设置失败:', e);
        }
    }
    
    // 初始化开关状态（不触发事件）
    mainToggle.checked = settings.enabled;
    if (autoAnalyzeToggle) {
        autoAnalyzeToggle.checked = settings.autoAnalyze;
    }
    
    // 显示/隐藏子设置
    if (subSettings) {
        subSettings.style.display = settings.enabled ? 'block' : 'none';
    }
    
    // 如果已启用，启动热区监听
    if (settings.enabled && window.__TAURI__) {
        try {
            await window.__TAURI__.core.invoke('start_hotzone_monitor');
        } catch (e) {
            console.error('启动热区监听失败:', e);
        }
    }
    
    // 主开关事件 - 先弹窗确认，取消则恢复状态
    mainToggle.addEventListener('change', async (e) => {
        const willEnable = mainToggle.checked; // 当前的状态（已经切换了）
        
        // 显示自定义确认弹窗
        const title = willEnable ? '开启桌面整理' : '关闭桌面整理';
        const message = willEnable 
            ? '开启后，鼠标移至屏幕右上角热区将触发侧边栏。确定要开启吗？'
            : '关闭后，热区触发将不再可用。确定要关闭吗？';
        
        const confirmed = await showConfirmDialog(title, message);
        
        if (confirmed) {
            // 用户确认，保存设置
            settings.enabled = willEnable;
            localStorage.setItem('dtkit_desktop_organizer', JSON.stringify(settings));
            
            // 显示/隐藏子设置
            if (subSettings) {
                subSettings.style.display = willEnable ? 'block' : 'none';
            }
            
            // 调用 Tauri 命令启动/停止热区监听
            if (window.__TAURI__) {
                try {
                    if (willEnable) {
                        await window.__TAURI__.core.invoke('start_hotzone_monitor');
                        showToast('桌面整理已开启');
                    } else {
                        await window.__TAURI__.core.invoke('stop_hotzone');
                        showToast('桌面整理已关闭');
                    }
                } catch (error) {
                    console.error('热区监听操作失败:', error);
                    showToast('操作失败: ' + error, 'error');
                }
            }
        } else {
            // 用户取消，恢复开关状态
            mainToggle.checked = !willEnable;
        }
    });
    
    // 自动分析开关事件 - 先弹窗确认，取消则恢复状态
    if (autoAnalyzeToggle) {
        autoAnalyzeToggle.addEventListener('change', async (e) => {
            const willEnable = autoAnalyzeToggle.checked;
            
            const title = willEnable ? '开启自动分析' : '关闭自动分析';
            const message = willEnable 
                ? '开启后，应用将自动扫描桌面文件并提供整理建议。确定要开启吗？'
                : '确定要关闭自动分析吗？';
            
            const confirmed = await showConfirmDialog(title, message);
            
            if (confirmed) {
                settings.autoAnalyze = willEnable;
                localStorage.setItem('dtkit_desktop_organizer', JSON.stringify(settings));
                showToast(willEnable ? '自动分析已开启' : '自动分析已关闭');
            } else {
                // 用户取消，恢复开关状态
                autoAnalyzeToggle.checked = !willEnable;
            }
        });
    }
}

// ============================================
// 镜像源设置功能
// ============================================
function initMirrorSourceSettings() {
    const configBtn = document.getElementById('configCustomSourceBtn');
    const dialog = document.getElementById('customSourceDialog');
    const closeBtn = document.getElementById('closeCustomSourceDialog');
    const cancelBtn = document.getElementById('cancelCustomSource');
    const confirmBtn = document.getElementById('confirmCustomSource');
    const textarea = document.getElementById('customSourceInput');
    const selectElement = document.getElementById('mirrorSourceSelect');
    const testSpeedBtn = document.getElementById('testMirrorSpeedBtn');
    const statusBadge = document.getElementById('mirrorPingStatus');
    const autoDetectToggle = document.getElementById('autoMirrorDetect');
    
    if (!configBtn || !dialog) return;
    
    // 初始化智能镜像检测开关
    if (autoDetectToggle) {
        autoDetectToggle.checked = isAutoDetectEnabled();
        autoDetectToggle.addEventListener('change', () => {
            setAutoDetectEnabled(autoDetectToggle.checked);
            showToast(autoDetectToggle.checked ? '智能镜像检测已启用' : '智能镜像检测已禁用');
        });
    }
    
    // 从本地存储加载自定义源配置
    const savedCustomSource = localStorage.getItem('dtkit_custom_mirror_source');
    if (savedCustomSource) {
        try {
            const config = JSON.parse(savedCustomSource);
            // 更新自定义选项的文本和URL
            const customOption = selectElement?.querySelector('option[value="custom"]');
            if (customOption && config.name) {
                customOption.textContent = `${config.name}`;
                customOption.dataset.url = config.url || '';
            }
        } catch (e) {
            console.error('加载自定义镜像源配置失败:', e);
        }
    }
    
    // 打开配置对话框
    configBtn.addEventListener('click', () => {
        if (savedCustomSource) {
            try {
                textarea.value = JSON.stringify(JSON.parse(savedCustomSource), null, 2);
            } catch (e) {
                textarea.value = '';
            }
        } else {
            textarea.value = '';
        }
        dialog.style.display = 'flex';
    });
    
    // 关闭对话框
    const closeDialog = () => {
        dialog.style.display = 'none';
        if (textarea) textarea.value = '';
    };
    
    if (closeBtn) closeBtn.addEventListener('click', closeDialog);
    if (cancelBtn) cancelBtn.addEventListener('click', closeDialog);
    
    // 点击遮罩层关闭
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            closeDialog();
        }
    });
    
    // 确认配置
    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            const inputValue = textarea.value.trim();
            
            if (!inputValue) {
                alert('请输入JSON格式的配置');
                return;
            }
            
            try {
                const config = JSON.parse(inputValue);
                
                // 验证必需字段
                if (!config.name || !config.url) {
                    alert('配置格式错误：缺少必需的 name 或 url 字段');
                    return;
                }
                
                // 验证URL格式
                try {
                    new URL(config.url);
                } catch (e) {
                    alert('URL 格式无效');
                    return;
                }
                
                // 保存到本地存储
                localStorage.setItem('dtkit_custom_mirror_source', JSON.stringify(config));
                
                // 更新下拉选项
                const customOption = selectElement?.querySelector('option[value="custom"]');
                if (customOption) {
                    customOption.textContent = `${config.name}`;
                    customOption.dataset.url = config.url;
                    selectElement.value = 'custom';
                }
                
                closeDialog();
                
                // 提示成功
                showToast('自定义镜像源配置成功！', 'success');
                
            } catch (e) {
                alert('JSON 格式错误，请检查配置格式\n\n' + e.message);
            }
        });
    }
    
    // 测速功能
    if (testSpeedBtn) {
        testSpeedBtn.addEventListener('click', async () => {
            if (!selectElement) return;
            
            const selectedOption = selectElement.options[selectElement.selectedIndex];
            const url = selectedOption?.dataset?.url;
            
            if (!url) {
                showToast('当前镜像源未配置 URL', 'error');
                return;
            }
            
            if (statusBadge) statusBadge.innerHTML = '<i class="ri-loader-4-line"></i> 测速中...';
            testSpeedBtn.disabled = true;
            
            try {
                const startTime = performance.now();
                await fetch(url, { method: 'HEAD', mode: 'no-cors' });
                const endTime = performance.now();
                const ping = Math.round(endTime - startTime);
                
                if (statusBadge) statusBadge.innerHTML = `<i class="ri-wifi-line"></i> ${ping}ms`;
                showToast(`延迟: ${ping}ms`, 'success');
            } catch (e) {
                if (statusBadge) statusBadge.innerHTML = '<i class="ri-wifi-off-line"></i> 超时';
                showToast('测速失败，请检查网络或镜像源地址', 'error');
            } finally {
                testSpeedBtn.disabled = false;
            }
        });
    }
}
