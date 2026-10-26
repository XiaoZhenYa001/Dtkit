import { mountShortcutBinding } from '../../core/shortcutBindingControl.js';

let dispose = null;

class ShortcutManager {
    init() {
        const container = document.getElementById('shortcutBindings');
        if (!container || dispose) return;
        const palette = document.createElement('div'), space = document.createElement('div');
        container.replaceChildren(palette, space);
        const disposePalette = mountShortcutBinding(palette, {
            label: '万能命令面板',
            icon: 'ri-terminal-box-line',
            compact: false,
            target: { kind: 'palette' }
        });
        const disposeSpace = mountShortcutBinding(space, {
            label: '桌面空间', icon: 'ri-layout-grid-line', compact: false,
            hint: '独立呼出或收起横向玻璃文件面板', target: { kind: 'desktopSpace' }
        });
        dispose = () => { disposePalette(); disposeSpace(); };
        const status = document.getElementById('shortcutStatus');
        if (status) status.textContent = '桌面空间启用后首次绑定 Ctrl + Alt + D。各工具的专属快捷键位于页面工具面板。';
    }

    destroy() {
        dispose?.();
        dispose = null;
    }
}

export const shortcutManager = new ShortcutManager();
