import { mountShortcutBinding } from '../../core/shortcutBindingControl.js';

let dispose = null;

class ShortcutManager {
    init() {
        const container = document.getElementById('shortcutBindings');
        if (!container || dispose) return;
        dispose = mountShortcutBinding(container, {
            label: '万能命令面板',
            icon: 'ri-terminal-box-line',
            compact: false,
            target: { kind: 'palette' }
        });
        const status = document.getElementById('shortcutStatus');
        if (status) status.textContent = '各工具的专属快捷键已移动到工具内容区左上角。';
    }

    destroy() {
        dispose?.();
        dispose = null;
    }
}

export const shortcutManager = new ShortcutManager();
