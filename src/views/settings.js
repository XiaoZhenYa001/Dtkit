import { initDesktopOrganizerSettings } from './settings/desktop-organizer.js';
import { initDownloadPathSettings } from './settings/download-path.js';
import { initCleanupSettings } from './settings/cleanup.js';
import { initMinimizeModeSettings } from './settings/minimize-mode.js';
import { initSettingsNavigation } from './settings/navigation.js';
import { initPasswordSettings } from './settings/passwords.js';
import { shortcutManager } from './settings/shortcuts.js';
import { initToolModuleSettings } from './settings/tool-modules.js';
import { initUpdateChecker } from './settings/update-checker.js';

let initializationPromise = null;

/**
 * 初始化设置页。各功能模块自行保证幂等，入口仅负责编排依赖顺序。
 */
export function initSettings() {
    if (initializationPromise) return initializationPromise;

    initializationPromise = Promise.resolve()
        .then(async () => {
            initSettingsNavigation();
            initDownloadPathSettings();
            initMinimizeModeSettings();
            initUpdateChecker();
            await Promise.all([
                shortcutManager.init(),
                initToolModuleSettings(),
                initPasswordSettings(),
                initCleanupSettings(),
                initDesktopOrganizerSettings()
            ]);
        })
        .catch(error => {
            initializationPromise = null;
            throw error;
        });

    return initializationPromise;
}

export { shortcutManager };
