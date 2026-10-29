import appState, {
    getLegacyDownloadPathAtStartup,
    markLegacyDownloadPathMigrated,
    saveDownloadPath
} from '../../core/state.js';
import { showToast } from '../../core/utils.js';

let initialized = false;

function setStatus(status, message, tone = 'info') {
    status.classList.toggle('storage-root-status--warning', tone === 'error' || tone === 'warning');
    status.dataset.tone = tone;
    const icon = document.createElement('i');
    icon.className = tone === 'pending' ? 'ri-loader-4-line'
        : tone === 'error' || tone === 'warning' ? 'ri-error-warning-line' : tone === 'success' ? 'ri-checkbox-circle-line' : 'ri-information-line';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.textContent = message;
    status.replaceChildren(icon, text);
}

export function initDownloadPathSettings() {
    if (initialized) return;
    const input = document.getElementById('downloadPathInput');
    const migrateButton = document.getElementById('changeDownloadPathBtn');
    const browseButton = document.getElementById('browseDownloadPathBtn');
    const status = document.getElementById('storageRootStatus');
    if (!input || !migrateButton || !browseButton || !status) return;
    initialized = true;
    const group = input.closest('.settings-input-group');
    const buttonLabel = migrateButton.querySelector('span');
    const idleLabel = buttonLabel?.textContent;
    const invoke = (...args) => {
        const nativeInvoke = globalThis.window?.__TAURI__?.core?.invoke;
        if (!nativeInvoke) throw new Error('请在 DtKit 桌面程序中管理文件目录');
        return nativeInvoke(...args);
    };
    let revision = 0;
    let busy = false;
    let selecting = false;
    let layout = null;
    let storageWarning = '';
    input.value = appState.settings.downloadPath;
    input.setAttribute('aria-describedby', 'storageRootStatus');
    status.setAttribute('role', 'status');

    const draftMessage = () => setStatus(status,
        layout?.root ? `当前目录：${layout.root}。新输入尚未应用，点击“迁移全部数据”后生效。`
            : '新输入尚未应用，点击“迁移全部数据”后生效。');
    const syncBusy = () => {
        migrateButton.disabled = browseButton.disabled = busy || selecting;
        input.readOnly = busy;
        if (busy || selecting) group?.setAttribute('aria-busy', 'true');
        else group?.removeAttribute('aria-busy');
        status.setAttribute('aria-busy', String(busy || selecting));
        if (buttonLabel) buttonLabel.textContent = busy ? '正在迁移…' : idleLabel;
    };
    const rememberLayout = next => {
        if (!next || typeof next.root !== 'string' || !next.root) throw new Error('文件目录服务返回了无效结果');
        layout = next;
        storageWarning = '';
        if (next.downloads) {
            try { saveDownloadPath(next.downloads); }
            catch { storageWarning = '目录已生效，但本机偏好缓存未能更新。'; }
        }
    };
    const displayLayout = () => setStatus(status, storageWarning || layout.warning
        || (layout.writable ? '目录可用 · 工具数据统一使用相对路径' : '目录暂不可写，请检查文件夹权限。'),
        !layout.writable ? 'error' : storageWarning || layout.warning ? 'warning' : 'success');
    const loadedRevision = revision;
    Promise.resolve().then(() => invoke('get_storage_layout')).then(next => {
        if (busy || loadedRevision !== revision) return;
        rememberLayout(next);
        input.value = layout.root;
        displayLayout();
    }).catch(error => {
        if (!busy && loadedRevision === revision) setStatus(status, `读取文件根目录失败：${error}`, 'error');
    });

    const migrate = async () => {
        if (busy || selecting) return;
        const targetRoot = input.value.trim();
        if (!targetRoot) {
            input.setAttribute('aria-invalid', 'true');
            setStatus(status, '数据根目录不能为空，请先输入或选择文件夹。', 'error');
            input.focus(); return;
        }
        revision++;
        busy = true; syncBusy();
        input.removeAttribute('aria-invalid');
        setStatus(status, '正在复制并校验全部 DtKit 数据，请勿关闭软件…', 'pending');
        try {
            const result = await invoke('migrate_storage_root', {
                targetRoot, legacyDownloadRoot: getLegacyDownloadPathAtStartup()
            });
            rememberLayout(result?.layout);
            input.value = layout.root;
            markLegacyDownloadPathMigrated();
            displayLayout();
            showToast(`文件管理目录迁移完成，共校验 ${result.filesCopied} 个文件`);
        } catch (error) {
            setStatus(status, `迁移失败，输入已保留，可核对后重试：${error}`, 'error');
            showToast(`迁移失败：${error}`, 'error');
        } finally { busy = false; syncBusy(); }
    };
    const browse = async () => {
        if (busy || selecting) return;
        const openDialog = globalThis.window?.__TAURI__?.dialog?.open;
        if (!openDialog) {
            setStatus(status, '桌面端可使用文件夹选择器，当前请手动输入路径。');
            input.focus(); return;
        }
        selecting = true; syncBusy();
        const selectedRevision = revision;
        try {
            const selected = await openDialog({ directory: true, multiple: false,
                title: '选择新的 DtKit 数据根目录', defaultPath: input.value || undefined });
            if (typeof selected === 'string' && selectedRevision === revision) {
                revision++; input.value = selected; input.removeAttribute('aria-invalid'); draftMessage();
                input.focus({ preventScroll: true });
            }
        } catch (error) { setStatus(status, `选择文件夹失败：${error}`, 'error'); }
        finally { selecting = false; syncBusy(); }
    };
    migrateButton.addEventListener('click', migrate);
    browseButton.addEventListener('click', browse);
    input.addEventListener('input', () => { revision++; input.removeAttribute('aria-invalid'); draftMessage(); });
    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault(); void migrate();
    });
}
