import { initDesktopOrganizerSettings } from './settings/desktop-organizer.js';
import { initDownloadPathSettings } from './settings/download-path.js';
import { initMirrorSourceSettings } from './settings/mirror-source.js';
import { initSettingsNavigation } from './settings/navigation.js';
import { shortcutManager } from './settings/shortcuts.js';

let initializationPromise = null;

/**
 * 初始化设置页。各功能模块自行保证幂等，入口仅负责编排依赖顺序。
 */
export function initSettings() {
    if (initializationPromise) return initializationPromise;

    initializationPromise = Promise.resolve()
        .then(() => {
            initSettingsNavigation();
            initDownloadPathSettings();
            initMirrorSourceSettings();
            shortcutManager.init();
            return initDesktopOrganizerSettings();
        })
        .catch(error => {
            initializationPromise = null;
            throw error;
        });

    return initializationPromise;
}

export { shortcutManager };
