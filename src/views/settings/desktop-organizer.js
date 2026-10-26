import {
    bootstrapDesktopOrganizer,
    getDesktopOrganizerSettings,
    getDesktopOrganizerShortcutWarning,
    clearDesktopOrganizerShortcutWarning,
    normalizeDesktopOrganizerPresentation,
    setDesktopOrganizerEnabled,
    updateDesktopOrganizerPresentation
} from '../../core/desktopOrganizer.js';
import { showToast } from '../../core/utils.js';
import { showConfirmDialog } from './modal.js';
import { mountShortcutBinding } from '../../core/shortcutBindingControl.js';
import { mountSpaceSettingsPanel } from './space-settings-panel.js';
import { applyGlassSettings } from '../../desktop-organizer/glass-material.js';
import { getSpaceSettings, subscribeSpaceSettings } from '../../desktop-organizer/space-preferences.js';

let initialized = false;

const PRESENTATION_CHOICES = [
    { value: 'classic', name: '分类侧栏', description: '右上角热区呼出，按分类快速访问文件', preview: 'classic' },
    { value: 'space', name: '桌面空间', description: '快捷键呼出的横向玻璃文件面板', preview: 'space' }
];

function presentationPreview(type) {
    return `<span class="desktop-presentation-preview desktop-presentation-preview--${type}" aria-hidden="true">
        <span class="desktop-preview-clock">10:08</span>
        <span class="desktop-preview-sidebar"><span></span><span></span><span></span><span></span><span></span></span>
        <span class="desktop-preview-space${type === 'space' ? ' liquid-glass' : ''}" data-appearance="dark"><span class="desktop-preview-search"></span><span class="desktop-preview-files">${Array.from({ length: 8 }, () => '<i></i>').join('')}</span></span>
    </span>`;
}

function presentationSettingsMarkup() {
    return `<div class="desktop-presentation-heading"><span>整理方式</span></div>
        <div class="desktop-presentation-cards" role="radiogroup" aria-label="桌面整理方式">
            ${PRESENTATION_CHOICES.map(choice => `<div class="desktop-presentation-option"><label class="desktop-presentation-card">
                <input type="radio" name="desktopOrganizerPresentation" value="${choice.value}" data-organizer-presentation="${choice.value}">
                ${presentationPreview(choice.preview)}
                <span class="desktop-presentation-card-title">${choice.name}<span class="desktop-presentation-check" aria-hidden="true">✓</span></span>
                <span class="desktop-presentation-card-desc">${choice.description}</span>
            </label>${choice.value === 'space' ? '<button type="button" id="desktopSpaceSettingsButton" class="desktop-space-settings-button" aria-label="桌面空间设置" title="桌面空间设置" aria-controls="desktopSpaceSettingsPage" aria-expanded="false"><i class="ri-settings-3-line" aria-hidden="true"></i></button>' : ''}</div>`).join('')}
        </div>
        <div class="desktop-space-options" id="desktopSpaceOptions"><div class="desktop-space-options-inner">
            <div class="desktop-space-launch-row"><div><strong>横向玻璃空间</strong><p id="desktopSpaceLaunchHint">需要时呼出，固定常用文件并拖动排序。空闲时不占桌面。</p></div>
                <div class="desktop-space-launch-actions"><button type="button" id="openDesktopSpace" class="settings-action-btn">打开空间</button><button type="button" id="desktopSpaceSettingsAction" class="settings-action-btn desktop-space-settings-action" aria-controls="desktopSpaceSettingsPage" aria-expanded="false">空间设置</button></div>
            </div>
            <div id="desktopSpaceShortcut" class="desktop-space-shortcut"></div>
            <p id="desktopSpaceShortcutNotice" class="desktop-presentation-error" role="status" hidden></p>
        </div></div>
        <div class="desktop-presentation-motion-row"><div><label class="desktop-presentation-label" for="desktopReducedMotion">减少动态</label><span class="desktop-presentation-motion-desc">减少面板与文件的位移动画</span></div>
            <label class="settings-toggle"><input type="checkbox" class="settings-toggle-input" id="desktopReducedMotion"><span class="settings-toggle-slider"></span></label>
        </div>
        <p class="desktop-presentation-error" role="alert" hidden></p>
        <section id="desktopSpaceSettingsPage" class="space-detail-page" aria-label="桌面空间设置" hidden></section>`;
}

export function initDesktopOrganizerPresentationSettings() {
    const container = document.getElementById('desktopPresentationSettings');
    if (!container || container.dataset.initialized === 'true') return;
    container.dataset.initialized = 'true';
    container.innerHTML = presentationSettingsMarkup();
    const cardMaterial = container.querySelector('.desktop-presentation-preview--space .desktop-preview-space');
    applyGlassSettings(cardMaterial, getSpaceSettings());
    const disposeCardMaterial = subscribeSpaceSettings(settings => applyGlassSettings(cardMaterial, settings));
    window.addEventListener('pagehide', disposeCardMaterial, { once: true });
    const spaceOptions = container.querySelector('#desktopSpaceOptions');
    const openButton = container.querySelector('#openDesktopSpace');
    const motionToggle = container.querySelector('#desktopReducedMotion');
    const errorMessage = container.querySelector('.desktop-presentation-error[role="alert"]');
    let revision = 0, opening = false;
    const settingsButton = container.querySelector('#desktopSpaceSettingsButton');
    const settingsButtons = [settingsButton, container.querySelector('#desktopSpaceSettingsAction')];
    let settingsReturnButton = settingsButton;
    const details = mountSpaceSettingsPanel(container.querySelector('#desktopSpaceSettingsPage'), {
        onBack: () => {
            details.hide(); delete container.dataset.detail;
            settingsButtons.forEach(button => button.setAttribute('aria-expanded', 'false'));
            settingsReturnButton.focus();
        },
        onOpen: () => launchSpace()
    });
    settingsButtons.forEach(button => button.addEventListener('click', () => {
        settingsReturnButton = button; container.dataset.detail = 'space';
        settingsButtons.forEach(entry => entry.setAttribute('aria-expanded', 'true'));
        void details.show();
    }));

    mountShortcutBinding(container.querySelector('#desktopSpaceShortcut'), {
        label: '桌面空间', icon: 'ri-layout-grid-line', compact: false,
        hint: '首次启用默认 Ctrl + Alt + D，可在此更改', target: { kind: 'desktopSpace' }
    });

    function applyPreferences(preferences, animate = false) {
        const enabled = getDesktopOrganizerSettings().enabled === true;
        container.dataset.presentation = preferences.presentation;
        container.classList.toggle('desktop-presentation-reduced-motion', preferences.reducedMotion);
        for (const [key, attribute] of [['presentation', 'data-organizer-presentation']]) {
            container.querySelectorAll(`[${attribute}]`).forEach(input => {
                const wasSelected = input.closest('label').classList.contains('is-selected');
                const isSelected = input.value === preferences[key];
                input.checked = isSelected;
                input.disabled = opening;
                input.closest('label').classList.toggle('is-selected', isSelected);
                if (animate && isSelected && !wasSelected && !preferences.reducedMotion
                    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
                    const preview = input.closest('label').querySelector('.desktop-presentation-preview');
                    preview?.animate?.([
                        { transform: 'scale(.975)', opacity: .82 },
                        { transform: 'scale(1)', opacity: 1 }
                    ], { duration: 380, easing: 'cubic-bezier(.2,.75,.25,1)' });
                }
            });
        }
        spaceOptions.classList.toggle('is-visible', preferences.presentation === 'space');
        spaceOptions.inert = preferences.presentation !== 'space';
        spaceOptions.setAttribute('aria-hidden', String(preferences.presentation !== 'space'));
        motionToggle.checked = preferences.reducedMotion;
        motionToggle.closest('.desktop-presentation-motion-row').hidden = preferences.presentation === 'space';
        openButton.disabled = opening || preferences.presentation !== 'space';
        openButton.textContent = opening ? '正在打开…' : enabled ? '打开空间' : '启用并打开';
        container.querySelector('#desktopSpaceLaunchHint').textContent = enabled
            ? '需要时呼出，固定常用文件并拖动排序。空闲时不占桌面。'
            : '空间尚未启用，点击“启用并打开”即可开始使用。';
        const shortcutNotice = container.querySelector('#desktopSpaceShortcutNotice');
        shortcutNotice.textContent = getDesktopOrganizerShortcutWarning();
        shortcutNotice.hidden = !enabled || !shortcutNotice.textContent;
        const mainToggle = document.getElementById('desktopOrganizerToggle');
        if (mainToggle) mainToggle.checked = enabled;
        setSubSettingsVisibility(document.getElementById('desktopOrganizerSubSettings'), enabled);
        const enableDescription = document.getElementById('desktopOrganizerEnableDescription');
        if (enableDescription) enableDescription.textContent = preferences.presentation === 'space'
            ? '用独立快捷键呼出横向玻璃空间，空闲时不占桌面'
            : '鼠标移至屏幕右上角热区可触发分类侧栏';
    }

    applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
    container.addEventListener('change', async event => {
        const control = event.target;
        const key = control.matches('[data-organizer-presentation]') ? 'presentation'
            : control === motionToggle ? 'reducedMotion' : null;
        if (!key) return;
        const value = key === 'reducedMotion' ? control.checked : control.value;
        const requestRevision = ++revision;
        const current = normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings());
        applyPreferences({ ...current, [key]: value }, true);
        errorMessage.hidden = true;
        try {
            const preferences = await updateDesktopOrganizerPresentation({ [key]: value });
            if (requestRevision === revision) applyPreferences(preferences);
        } catch (error) {
            if (requestRevision !== revision) return;
            applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
            errorMessage.textContent = `${key === 'presentation' ? '切换桌面整理方式失败' : '保存设置失败'}：${String(error)}`;
            errorMessage.hidden = false;
            console.error('[DesktopOrganizer] 保存桌面外观失败', error);
        }
    });
    window.addEventListener('dtkit:desktop-organizer-presentation-changed', () => {
        applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
    });
    window.addEventListener('dtkit:shortcut-bindings-changed', event => {
        if (event.detail?.bindings?.some(binding => binding.target?.kind === 'desktopSpace' && binding.registered !== false)) {
            clearDesktopOrganizerShortcutWarning();
            applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
        }
    });
    window.addEventListener('storage', event => {
        if (event.key === 'dtkit_desktop_organizer') {
            applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
        }
    });
    if (typeof window.__TAURI__?.event?.listen === 'function') {
        window.__TAURI__.event.listen('desktop-organizer-presentation-changed', () => {
            applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
        }).catch(error => console.error('[DesktopOrganizer] 监听外观同步失败', error));
    }
    async function launchSpace() {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke || opening) return;
        opening = true;
        const mainToggle = document.getElementById('desktopOrganizerToggle');
        if (mainToggle) mainToggle.disabled = true;
        applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
        errorMessage.hidden = true;
        let phase = '启用';
        try {
            if (normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()).presentation !== 'space') {
                await updateDesktopOrganizerPresentation({ presentation: 'space' });
            }
            if (!getDesktopOrganizerSettings().enabled) await setDesktopOrganizerEnabled(true);
            phase = '打开';
            await invoke('desktop_space_show');
        } catch (error) { errorMessage.textContent = `${phase}空间失败：${String(error)}`; errorMessage.hidden = false; throw error; }
        finally {
            opening = false;
            if (mainToggle) mainToggle.disabled = false;
            applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
        }
    }
    openButton.addEventListener('click', () => void launchSpace().catch(() => {}));
}

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
    initDesktopOrganizerPresentationSettings();

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
            await bootstrapDesktopOrganizer();
            mainToggle.checked = getDesktopOrganizerSettings().enabled;
            setSubSettingsVisibility(subSettings, mainToggle.checked);
            window.dispatchEvent(new CustomEvent('dtkit:desktop-organizer-presentation-changed'));
        } catch (error) {
            console.error('启动桌面整理失败:', error);
        }
    }

    mainToggle.addEventListener('change', async () => {
        const willEnable = mainToggle.checked;
        const isSpace = normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()).presentation === 'space';
        const confirmed = await showConfirmDialog(
            willEnable ? '开启桌面整理' : '关闭桌面整理',
            isSpace
                ? (willEnable
                    ? '开启后，可用独立快捷键呼出横向玻璃空间。确定要开启吗？'
                    : '关闭后，桌面空间快捷键将不再呼出面板。确定要关闭吗？')
                : (willEnable
                    ? '开启后，鼠标移至屏幕右上角热区将触发侧边栏。确定要开启吗？'
                    : '关闭后，热区触发将不再可用。确定要关闭吗？')
        );
        if (!confirmed) {
            mainToggle.checked = !willEnable;
            return;
        }

        mainToggle.disabled = true;
        try {
            await setDesktopOrganizerEnabled(willEnable);
            setSubSettingsVisibility(subSettings, willEnable);
            window.dispatchEvent(new CustomEvent('dtkit:desktop-organizer-presentation-changed'));
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
