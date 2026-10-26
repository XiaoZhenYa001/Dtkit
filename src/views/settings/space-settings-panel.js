import { mountShortcutBinding } from '../../core/shortcutBindingControl.js';
import { DEFAULT_SPACE_SETTINGS, getSpaceSettings, initializeSpaceSettings, subscribeSpaceSettings, updateSpaceSettings } from '../../desktop-organizer/space-preferences.js';
import { mountSpaceSettingsPreview, spaceSettingsPreviewMarkup } from './space-settings-preview.js';
import '../../desktop-organizer/glass-material.css';

const range = (key, title, min, max, unit, description) => `<label class="space-detail-row" for="space-pref-${key}"><span><strong>${title}</strong><small>${description}</small></span><span class="space-detail-range"><input id="space-pref-${key}" type="range" min="${min}" max="${max}" step="1" data-space-pref="${key}"><output data-space-output="${key}"></output><span>${unit}</span></span></label>`;
const toggle = (key, title, description) => `<label class="space-detail-row" for="space-pref-${key}"><span><strong>${title}</strong><small>${description}</small></span><span class="settings-toggle"><input class="settings-toggle-input" id="space-pref-${key}" type="checkbox" data-space-pref="${key}"><span class="settings-toggle-slider"></span></span></label>`;

export function mountSpaceSettingsPanel(container, { onBack, onOpen }) {
    container.innerHTML = `<header class="space-detail-heading"><button type="button" class="space-detail-back" aria-label="返回桌面整理"><i class="ri-arrow-left-line" aria-hidden="true"></i>返回</button><div><h3 tabindex="-1">桌面空间设置</h3><p>液态玻璃风格 · 需要时出现，空闲时收起</p></div><button type="button" class="space-detail-open">打开空间</button></header>
        ${spaceSettingsPreviewMarkup()}
        <p class="space-detail-status" role="status">正在读取空间设置…</p><p class="space-detail-error" role="alert" hidden></p><button class="space-detail-retry" type="button" hidden>重新读取设置</button>
        <fieldset class="space-detail-controls" disabled><legend class="sr-only">桌面空间偏好</legend>
            <section class="space-detail-group"><h4>外观</h4>${range('glassOpacity','玻璃浓度',40,90,'%','数值越高，底面越明显，背景透出越少。')}${range('blur','高光柔化',12,48,'px','调整玻璃高光与光晕的柔和程度。')}
                <label class="space-detail-row" for="space-pref-iconSize"><span><strong>图标密度</strong><small>调整空间中的图标大小和网格间距。</small></span><select id="space-pref-iconSize" data-space-pref="iconSize"><option value="small">紧凑</option><option value="medium">标准</option><option value="large">宽松</option></select></label>
            </section>
            <section class="space-detail-group"><h4>窗口</h4>${range('windowWidth','窗口宽度',60,96,'%','示例立即按比例缩放；实际空间在下次呼出时应用。')}${range('windowHeight','窗口高度',45,90,'%','示例立即按比例缩放；实际空间保留任务栏与边距。')}</section>
            <section class="space-detail-group"><h4>行为与动效</h4>${toggle('closeAfterOpen','打开后收起','成功启动文件或应用后自动收起空间。')}${toggle('closeOnBlur','失去焦点时收起','切换到其他窗口时自动收起；关闭后可让空间保持显示。')}${toggle('reducedMotion','减少动态','减少弹性、位移和悬停动效，立即应用。')}</section>
            <section class="space-detail-group"><h4>呼出快捷键</h4><div class="space-detail-shortcut"></div><p class="space-detail-help">快捷键可随时更改；如果被其他程序占用，仍可通过“打开空间”进入。</p></section>
            <footer class="space-detail-footer"><span>设置自动保存。文件、固定项和拖动顺序保持独立。</span><button type="button" class="space-detail-reset">恢复空间默认设置</button></footer>
        </fieldset>`;
    const controls = container.querySelector('fieldset'), status = container.querySelector('.space-detail-status');
    const error = container.querySelector('.space-detail-error'), retry = container.querySelector('.space-detail-retry');
    const fields = [...container.querySelectorAll('[data-space-pref]')];
    const demo = mountSpaceSettingsPreview(container.querySelector('.space-detail-preview'));
    let ready = false, open = false, pendingSaves = 0, hasSaved = false;
    const dirty = new Set(), versions = new Map(), fieldErrors = new Map();

    mountShortcutBinding(container.querySelector('.space-detail-shortcut'), {
        label: '桌面空间', icon: 'ri-layout-grid-line', compact: false,
        hint: '首次启用默认 Ctrl + Alt + D', target: { kind: 'desktopSpace' }
    });
    function preview(values) { demo.update(values); }
    function render(settings, force = false) {
        fields.forEach(field => {
            const key = field.dataset.spacePref;
            if (!force && dirty.has(key)) return;
            if (field.type === 'checkbox') field.checked = settings[key];
            else field.value = settings[key];
            const output = container.querySelector(`[data-space-output="${field.dataset.spacePref}"]`);
            if (output) output.value = String(settings[key]);
        });
        preview(values());
    }
    function values() {
        const value = getSpaceSettings();
        fields.forEach(field => { value[field.dataset.spacePref] = field.type === 'checkbox' ? field.checked : field.type === 'range' ? Number(field.value) : field.value; });
        return value;
    }
    function beginEdit(key) {
        const version = (versions.get(key) || 0) + 1;
        versions.set(key, version); dirty.add(key);
        return version;
    }
    function saveStatus() {
        status.textContent = pendingSaves ? '正在保存…' : fieldErrors.size ? '部分设置尚未保存'
            : hasSaved ? '已保存 · 外观与行为即时同步' : '所有设置自动保存';
        error.hidden = fieldErrors.size === 0;
        error.textContent = fieldErrors.size ? `保存失败：${[...fieldErrors].map(([key, reason]) => {
            const title = fields.find(field => field.dataset.spacePref === key)?.closest('label')?.querySelector('strong')?.textContent || key;
            return `${title} · ${String(reason)}`;
        }).join('；')}` : '';
    }
    async function save(patch, tokens) {
        pendingSaves++;
        for (const key of Object.keys(patch)) fieldErrors.delete(key);
        saveStatus();
        try {
            await updateSpaceSettings(patch);
            for (const [key, version] of Object.entries(tokens)) {
                if (versions.get(key) === version) dirty.delete(key);
            }
            hasSaved = true;
        } catch (reason) {
            for (const [key, version] of Object.entries(tokens)) {
                if (versions.get(key) !== version) continue;
                dirty.delete(key); fieldErrors.set(key, reason);
            }
        } finally {
            pendingSaves--; render(getSpaceSettings()); saveStatus();
        }
    }
    async function load() {
        error.hidden = true; retry.hidden = true; controls.disabled = true;
        try { await initializeSpaceSettings(); render(getSpaceSettings()); ready = true; controls.disabled = false; saveStatus(); }
        catch (reason) { status.textContent = '暂时无法读取设置'; error.textContent = String(reason); error.hidden = false; retry.hidden = false; }
    }
    fields.forEach(field => {
        field.addEventListener('input', () => {
            if (!ready) return;
            beginEdit(field.dataset.spacePref);
            const output = container.querySelector(`[data-space-output="${field.dataset.spacePref}"]`);
            if (output) output.value = field.value;
            preview(values());
        });
        field.addEventListener('change', () => {
            if (!ready) return;
            const key = field.dataset.spacePref, version = beginEdit(key);
            void save({ [key]: field.type === 'checkbox' ? field.checked : field.type === 'range' ? Number(field.value) : field.value }, { [key]: version });
        });
    });
    container.querySelector('.space-detail-back').addEventListener('click', onBack);
    container.querySelector('.space-detail-open').addEventListener('click', async event => {
        event.currentTarget.disabled = true; error.hidden = true;
        try { await onOpen(); }
        catch (reason) { error.textContent = `打开空间失败：${String(reason)}`; error.hidden = false; }
        finally { container.querySelector('.space-detail-open').disabled = false; }
    });
    container.querySelector('.space-detail-reset').addEventListener('click', () => {
        const { version, ...patch } = DEFAULT_SPACE_SETTINGS;
        const tokens = Object.fromEntries(Object.keys(patch).map(key => [key, beginEdit(key)]));
        fieldErrors.clear(); render(DEFAULT_SPACE_SETTINGS, true); void save(patch, tokens);
    });
    retry.addEventListener('click', () => void load());
    const disposeSettings = subscribeSpaceSettings(render);
    window.addEventListener('pagehide', () => { disposeSettings(); demo.destroy(); }, { once: true });
    render(getSpaceSettings());
    return {
        async show() { open = true; container.hidden = false; container.querySelector('h3').focus(); await load(); },
        hide() { open = false; container.hidden = true; },
        get isOpen() { return open; }
    };
}
