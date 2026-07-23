import appState, {
    getLegacyDownloadPathAtStartup,
    markLegacyDownloadPathMigrated,
    saveDownloadPath
} from '../../core/state.js';
import { showToast } from '../../core/utils.js';

let initialized = false;
const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);

function applyLayout(layout, input, status) {
    if (!layout) return;
    input.value = layout.root || '';
    if (layout.downloads) saveDownloadPath(layout.downloads);
    status.className = `storage-root-status${layout.writable ? '' : ' storage-root-status--warning'}`;
    status.innerHTML = layout.warning
        ? `<i class="ri-error-warning-line"></i><span>${layout.warning}</span>`
        : `<i class="ri-checkbox-circle-line"></i><span>目录可用 · 工具数据统一使用相对路径</span>`;
}

async function loadLayout(input, status) {
    try {
        applyLayout(await invoke?.('get_storage_layout'), input, status);
    } catch (error) {
        status.textContent = `读取文件根目录失败：${error}`;
    }
}

async function selectStorageRoot(input, browseButton) {
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
            title: '选择新的 DtKit 数据根目录',
            defaultPath: input.value || undefined
        });
        if (selected) input.value = selected;
    } catch (error) {
        showToast(`选择文件夹失败：${error}`, 'error');
    } finally {
        browseButton.disabled = false;
    }
}

export function initDownloadPathSettings() {
    if (initialized) return;
    const input = document.getElementById('downloadPathInput');
    const migrateButton = document.getElementById('changeDownloadPathBtn');
    const browseButton = document.getElementById('browseDownloadPathBtn');
    const status = document.getElementById('storageRootStatus');
    if (!input || !migrateButton || !browseButton || !status) return;
    initialized = true;
    input.value = appState.settings.downloadPath;
    loadLayout(input, status);

    const migrate = async () => {
        const targetRoot = input.value.trim();
        if (!targetRoot) {
            showToast('数据根目录不能为空', 'error');
            return input.focus();
        }
        migrateButton.disabled = true;
        browseButton.disabled = true;
        status.innerHTML = '<i class="ri-loader-4-line"></i><span>正在复制并校验全部 DtKit 数据，请勿关闭软件…</span>';
        try {
            const result = await invoke?.('migrate_storage_root', {
                targetRoot,
                legacyDownloadRoot: getLegacyDownloadPathAtStartup()
            });
            if (!result?.layout) throw new Error('桌面文件迁移服务不可用');
            applyLayout(result.layout, input, status);
            markLegacyDownloadPathMigrated();
            showToast(`文件管理目录迁移完成，共校验 ${result.filesCopied} 个文件`);
        } catch (error) {
            status.className = 'storage-root-status storage-root-status--warning';
            status.innerHTML = `<i class="ri-error-warning-line"></i><span>迁移未生效，仍继续使用原目录：${error}</span>`;
            showToast(`迁移失败：${error}`, 'error');
            await loadLayout(input, status);
        } finally {
            migrateButton.disabled = false;
            browseButton.disabled = false;
        }
    };

    migrateButton.addEventListener('click', migrate);
    browseButton.addEventListener('click', () => selectStorageRoot(input, browseButton));
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') migrate();
    });
}
