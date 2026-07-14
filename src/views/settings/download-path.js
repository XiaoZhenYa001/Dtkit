import appState, { saveDownloadPath } from '../../core/state.js';
import { showToast } from '../../core/utils.js';

let initialized = false;

async function selectDownloadFolder(input, browseButton) {
    const openDialog = globalThis.window?.__TAURI__?.dialog?.open;
    if (!openDialog) {
        showToast('桌面端可使用文件夹选择器，当前请手动输入路径', 'info');
        input.focus();
        return;
    }

    browseButton.disabled = true;
    try {
        const selected = await openDialog({
            directory: true,
            multiple: false,
            title: '选择下载文件夹',
            defaultPath: appState.settings.downloadPath
        });
        if (!selected) return;

        saveDownloadPath(selected);
        input.value = selected;
        showToast('下载路径已更新');
    } catch (error) {
        console.error('选择文件夹失败:', error);
        showToast(`选择文件夹失败：${error.message}`, 'error');
    } finally {
        browseButton.disabled = false;
    }
}

export function initDownloadPathSettings() {
    if (initialized) return;

    const input = document.getElementById('downloadPathInput');
    const saveButton = document.getElementById('changeDownloadPathBtn');
    const browseButton = document.getElementById('browseDownloadPathBtn');
    if (!input || !saveButton || !browseButton) return;
    initialized = true;

    input.value = appState.settings.downloadPath;
    const save = () => {
        const path = input.value.trim();
        if (!path) {
            showToast('下载路径不能为空', 'error');
            input.focus();
            return;
        }
        saveDownloadPath(path);
        showToast('下载路径已保存');
    };

    saveButton.addEventListener('click', save);
    browseButton.addEventListener('click', () => selectDownloadFolder(input, browseButton));
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') save();
    });
}
