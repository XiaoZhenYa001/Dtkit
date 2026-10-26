import { migrateFileCategory } from './categories.js';

export function createFileActions({
    invoke,
    state,
    setStatus,
    saveCategories,
    loadDesktopFiles,
    refreshCurrentView,
    onRename
}) {
    async function open(path, appId = '') {
        try {
            await invoke(appId ? 'desktop_open_app' : 'desktop_open_file', { path });
        } catch (error) {
            console.error('打开文件失败:', error);
            setStatus(`打开失败 · ${String(error)}`);
        }
    }

    async function locate(path, appId = '') {
        try {
            await invoke(appId ? 'desktop_locate_app' : 'desktop_locate_file', { path });
        } catch (error) {
            console.error('定位文件失败:', error);
            setStatus(`定位失败 · ${String(error)}`);
        }
    }

    async function rename(oldPath, newName) {
        try {
            const newPath = await invoke('desktop_rename_file', { oldPath, newName });
            const migratedCategories = migrateFileCategory(state.fileCategories, oldPath, newPath);
            let categoryWarning = '';
            if (migratedCategories !== state.fileCategories) {
                state.fileCategories = migratedCategories;
                if (saveCategories() === false) categoryWarning = '文件已重命名，分类设置尚未保存，请在存储恢复后刷新重试';
            }
            await onRename?.(oldPath, newPath);
            await loadDesktopFiles();
            if (state.folderView.active) await refreshCurrentView();
            if (categoryWarning) setStatus(categoryWarning);
        } catch (error) {
            console.error('重命名失败:', error);
            alert(`重命名失败: ${error}`);
        }
    }

    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            console.error('复制失败:', error);
        }
    }

    return { open, locate, rename, copyToClipboard };
}
