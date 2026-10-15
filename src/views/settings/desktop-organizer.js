import {
    bootstrapDesktopOrganizer,
    getDesktopOrganizerSettings,
    normalizeDesktopOrganizerPresentation,
    setDesktopOrganizerEnabled,
    updateDesktopOrganizerPresentation
} from '../../core/desktopOrganizer.js';
import { showToast } from '../../core/utils.js';
import { showConfirmDialog } from './modal.js';

let initialized = false;

const PRESENTATION_CHOICES = [
    { value: 'classic', name: '原有桌面整理', description: '保留熟悉的分类侧栏，轻巧快速', preview: 'classic' },
    { value: 'space', name: '桌面空间', description: '直接在电脑桌面收纳文件与应用', preview: 'space' }
];
const LAYOUT_CHOICES = [
    { value: 'shelf', name: '收纳架', description: '自由摆放、靠边停靠，分组可拆出' },
    { value: 'islands', name: '独立卡片', description: '收起为文件夹，点击展开' },
    { value: 'drawer', name: '边缘抽屉', description: '从右侧展开，需要时再出现' },
    { value: 'zones', name: '展开分区', description: '各个分区同时可见' }
];

function presentationPreview(type) {
    return `<span class="desktop-presentation-preview desktop-presentation-preview--${type}" aria-hidden="true">
        <span class="desktop-preview-clock">10:08</span>
        <span class="desktop-preview-sidebar"><span></span><span></span><span></span><span></span><span></span></span>
        <span class="desktop-preview-folders">${Array.from({ length: 4 }, () => '<span><i></i><i></i><i></i><i></i></span>').join('')}</span>
        <span class="desktop-preview-dock"><i></i><i></i><i></i><i></i></span>
    </span>`;
}

function presentationSettingsMarkup() {
    return `<div class="desktop-presentation-heading"><span>整理方式</span><span class="desktop-presentation-hint">切换时平滑过渡</span></div>
        <div class="desktop-presentation-cards" role="radiogroup" aria-label="桌面整理方式">
            ${PRESENTATION_CHOICES.map(choice => `<label class="desktop-presentation-card">
                <input type="radio" name="desktopOrganizerPresentation" value="${choice.value}" data-organizer-presentation="${choice.value}">
                ${presentationPreview(choice.preview)}
                <span class="desktop-presentation-card-title">${choice.name}<span class="desktop-presentation-check" aria-hidden="true">✓</span></span>
                <span class="desktop-presentation-card-desc">${choice.description}</span>
            </label>`).join('')}
        </div>
        <div class="desktop-space-options" id="desktopSpaceOptions"><div class="desktop-space-options-inner">
            <div class="desktop-presentation-heading"><span>收纳布局</span></div>
            <div class="desktop-layout-choices" role="radiogroup" aria-label="桌面空间收纳布局">
                ${LAYOUT_CHOICES.map(choice => `<label class="desktop-layout-choice">
                    <input type="radio" name="desktopOrganizerLayout" value="${choice.value}" data-organizer-layout="${choice.value}">
                    <span class="desktop-layout-preview desktop-layout-preview--${choice.value}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                    <span class="desktop-layout-name">${choice.name}</span><span class="desktop-layout-desc">${choice.description}</span>
                </label>`).join('')}
            </div>
            <div class="desktop-appearance-row"><span class="desktop-presentation-label">界面风格</span>
                <div class="desktop-appearance-choices" role="radiogroup" aria-label="桌面空间界面风格">
                    <span class="desktop-appearance-pill" aria-hidden="true"></span>
                    <label><input type="radio" name="desktopOrganizerAppearance" value="warm" data-organizer-appearance="warm"><span class="desktop-appearance-swatch desktop-appearance-swatch--warm" aria-hidden="true"></span>暖色</label>
                    <label><input type="radio" name="desktopOrganizerAppearance" value="liquid" data-organizer-appearance="liquid"><span class="desktop-appearance-swatch desktop-appearance-swatch--liquid" aria-hidden="true"></span>液态玻璃</label>
                </div>
            </div>
        </div></div>
        <div class="desktop-presentation-motion-row"><div><label class="desktop-presentation-label" for="desktopReducedMotion">减少动态</label><span class="desktop-presentation-motion-desc">减少伸展与位移动画</span></div>
            <label class="settings-toggle"><input type="checkbox" class="settings-toggle-input" id="desktopReducedMotion"><span class="settings-toggle-slider"></span></label>
        </div>
        <p class="desktop-presentation-error" role="alert" hidden></p>`;
}

export function initDesktopOrganizerPresentationSettings() {
    const container = document.getElementById('desktopPresentationSettings');
    if (!container || container.dataset.initialized === 'true') return;
    container.dataset.initialized = 'true';
    container.innerHTML = presentationSettingsMarkup();
    const spaceOptions = container.querySelector('#desktopSpaceOptions');
    const appearanceChoices = container.querySelector('.desktop-appearance-choices');
    const appearancePill = container.querySelector('.desktop-appearance-pill');
    const motionToggle = container.querySelector('#desktopReducedMotion');
    const errorMessage = container.querySelector('.desktop-presentation-error');
    let revision = 0;

    function positionAppearancePill() {
        const selectedLabel = appearanceChoices.querySelector('input:checked')?.closest('label');
        if (!selectedLabel || !selectedLabel.offsetWidth) return;
        appearancePill.style.width = `${selectedLabel.offsetWidth}px`;
        appearancePill.style.transform = `translateX(${selectedLabel.offsetLeft - 4}px)`;
    }

    function applyPreferences(preferences, animate = false) {
        container.dataset.presentation = preferences.presentation;
        container.dataset.appearance = preferences.appearance;
        container.classList.toggle('desktop-presentation-reduced-motion', preferences.reducedMotion);
        for (const [key, attribute] of [
            ['presentation', 'data-organizer-presentation'],
            ['layout', 'data-organizer-layout'],
            ['appearance', 'data-organizer-appearance']
        ]) {
            container.querySelectorAll(`[${attribute}]`).forEach(input => {
                const wasSelected = input.closest('label').classList.contains('is-selected');
                const isSelected = input.value === preferences[key];
                input.checked = isSelected;
                input.closest('label').classList.toggle('is-selected', isSelected);
                if (animate && isSelected && !wasSelected && !preferences.reducedMotion
                    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
                    const preview = input.closest('label').querySelector('.desktop-presentation-preview, .desktop-layout-preview');
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
        const enableDescription = document.getElementById('desktopOrganizerEnableDescription');
        if (enableDescription) enableDescription.textContent = preferences.presentation === 'space'
            ? '收纳区域直接显示在电脑桌面，停用原有右上角热区'
            : '鼠标移至屏幕右上角热区可触发分类侧栏';
        positionAppearancePill();
    }

    applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
    container.addEventListener('change', async event => {
        const control = event.target;
        const key = control.matches('[data-organizer-presentation]') ? 'presentation'
            : control.matches('[data-organizer-layout]') ? 'layout'
                : control.matches('[data-organizer-appearance]') ? 'appearance'
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
            errorMessage.textContent = '未能保存选择，请重试。';
            errorMessage.hidden = false;
            console.error('[DesktopOrganizer] 保存桌面外观失败', error);
        }
    });
    window.addEventListener('dtkit:desktop-organizer-presentation-changed', () => {
        applyPreferences(normalizeDesktopOrganizerPresentation(getDesktopOrganizerSettings()));
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
    if (typeof ResizeObserver === 'function') new ResizeObserver(positionAppearancePill).observe(appearanceChoices);
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
                    ? '开启后，收纳区域会显示在电脑桌面。原桌面图标由你自行控制显示。确定要开启吗？'
                    : '关闭后，桌面收纳区域会移除。确定要关闭吗？')
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
