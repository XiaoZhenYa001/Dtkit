import { migrateFileCategory } from './categories.js';

export function createFileActions({
    invoke,
    state,
    setStatus,
    saveCategories,
    loadDesktopFiles,
    refreshCurrentView
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
            if (migratedCategories !== state.fileCategories) {
                state.fileCategories = migratedCategories;
                saveCategories();
            }
            await loadDesktopFiles();
            if (state.folderView.active) await refreshCurrentView();
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
