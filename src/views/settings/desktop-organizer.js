import {
    getDesktopOrganizerSettings,
    setDesktopOrganizerEnabled,
    startDesktopOrganizerMonitor
} from '../../core/desktopOrganizer.js';
import { showToast } from '../../core/utils.js';
import { showConfirmDialog } from './modal.js';

let initialized = false;

function setSubSettingsVisibility(element, visible) {
    if (!element) return;
    element.hidden = !visible;
}

export async function initDesktopOrganizerSettings() {
    if (initialized) return;

    const mainToggle = document.getElementById('desktopOrganizerToggle');
    const autoAnalyzeToggle = document.getElementById('desktopAutoAnalyzeToggle');
    const subSettings = document.getElementById('desktopOrganizerSubSettings');
    const appManagerButton = document.getElementById('openDesktopAppManager');
    if (!mainToggle) return;
    initialized = true;

    const settings = getDesktopOrganizerSettings();
    mainToggle.checked = settings.enabled;
    if (autoAnalyzeToggle) {
        autoAnalyzeToggle.checked = false;
        autoAnalyzeToggle.disabled = true;
    }
    setSubSettingsVisibility(subSettings, settings.enabled);

    appManagerButton?.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('dtkit:open-tool-new-tab', { detail: { toolId: 'desktop-app-manager' } }));
    });

    if (settings.enabled) {
        try {
            await startDesktopOrganizerMonitor();
        } catch (error) {
            console.error('启动热区监听失败:', error);
        }
    }

    mainToggle.addEventListener('change', async () => {
        const willEnable = mainToggle.checked;
        const confirmed = await showConfirmDialog(
            willEnable ? '开启桌面整理' : '关闭桌面整理',
            willEnable
                ? '开启后，鼠标移至屏幕右上角热区将触发侧边栏。确定要开启吗？'
                : '关闭后，热区触发将不再可用。确定要关闭吗？'
        );
        if (!confirmed) {
            mainToggle.checked = !willEnable;
            return;
        }

        mainToggle.disabled = true;
        try {
            await setDesktopOrganizerEnabled(willEnable);
            setSubSettingsVisibility(subSettings, willEnable);
            showToast(willEnable ? '桌面整理已开启' : '桌面整理已关闭');
        } catch (error) {
            mainToggle.checked = !willEnable;
            setSubSettingsVisibility(subSettings, !willEnable);
            console.error('热区监听操作失败:', error);
            showToast(`操作失败：${error}`, 'error');
        } finally {
            mainToggle.disabled = false;
        }
    });

}
