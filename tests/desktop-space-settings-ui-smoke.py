"""Production settings-page and live launcher appearance regression.

Run after npm run build. File and native settings IPC are isolated fixtures;
no real application shortcut or desktop configuration is modified.
"""

import importlib.util
import json
from pathlib import Path
import tempfile

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
KEY = 'dtkit_desktop_space_settings_v1'
NATIVE_KEY = '__dtkit_test_native_space_settings_v1'
OUT = Path(tempfile.mkdtemp(prefix='dtkit-space-settings-'))
spec = importlib.util.spec_from_file_location('space_settings_helpers', ROOT / 'tests/desktop-space-activation-ui-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

DEFAULTS = {'version': 1, 'glassOpacity': 68, 'blur': 30, 'iconSize': 'medium', 'windowWidth': 90,
            'windowHeight': 70, 'closeOnBlur': True, 'closeAfterOpen': True, 'reducedMotion': False}
WRAPPER = r"""
(() => {
    const defaults = __DEFAULTS__;
    const key = __NATIVE_KEY__;
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(defaults));
    const read = () => JSON.parse(localStorage.getItem(key));
    const originalInvoke = window.__TAURI__.core.invoke;
    window.__spaceCalls = [];
    window.__previewNativeFileCalls = [];
    window.__failSpaceRead = false;
    window.__failSpaceSave = false;
    window.__TAURI__.core.invoke = async (command, args={}) => {
        if (/^desktop_(scan|list_folder|open_|preview_|locate_|space_(show|hide))/.test(command)) {
            window.__previewNativeFileCalls.push({command,args:structuredClone(args)});
        }
        if (command === 'get_desktop_space_settings' || command === 'update_desktop_space_settings') {
            window.__spaceCalls.push({command,args:structuredClone(args)});
            if (command === 'get_desktop_space_settings') {
                if (window.__failSpaceRead) throw new Error('READ_SPACE_FIXTURE');
                return read();
            }
            if (window.__failSpaceSave) throw new Error('SAVE_SPACE_FIXTURE');
            const next = {...read(),...args.patch,version:1};
            localStorage.setItem(key, JSON.stringify(next));
            await window.__TAURI__.event.emit('desktop-space-settings-changed', next);
            return next;
        }
        if (command === 'desktop_scan') {
            const file=(name,category,is_folder=false)=>({name,path:'C:\\Users\\demo\\Desktop\\'+name,category,is_folder,size:1024,extension:name.split('.').pop()});
            return {documents:[file('Project plan.md','document'),file('Meeting notes.txt','document')],folders:[file('Projects','folder',true)],applications:[],images:[],programs:[],others:[],recent:[],total_count:3};
        }
        return originalInvoke(command,args);
    };
})();
""".replace('__DEFAULTS__', json.dumps(DEFAULTS)).replace('__NATIVE_KEY__', json.dumps(NATIVE_KEY))


def context(browser):
    result = browser.new_context(viewport={'width': 1280, 'height': 950}, color_scheme='light')
    initial = {'enabled': False, 'presentation': 'classic', 'reducedMotion': False}
    result.add_init_script(helpers.MOCK.replace('__INITIAL_SETTINGS__', json.dumps(initial)) + WRAPPER)
    return result


def open_settings(context, url):
    page = context.new_page()
    page.set_default_timeout(8000)
    page.goto(url, wait_until='networkidle')
    page.locator('[data-view="settings"]').click()
    page.locator('#desktopSpaceSettingsButton').wait_for(state='visible')
    return page


def open_details(page):
    page.locator('#desktopSpaceSettingsButton').click()
    expect(page.locator('#desktopSpaceSettingsPage')).to_be_visible()
    expect(page.locator('#desktopSpaceSettingsPage h3')).to_be_focused()
    expect(page.locator('[data-space-pref="glassOpacity"]')).to_be_enabled()


def persisted(page):
    return page.evaluate('key => JSON.parse(localStorage.getItem(key))', NATIVE_KEY)


def set_field(page, key, value):
    field = page.locator(f'[data-space-pref="{key}"]')
    if isinstance(value, bool):
        field.set_checked(value)
    elif isinstance(value, str):
        field.select_option(value)
    else:
        field.evaluate('''(node,value) => {
            node.value = String(value);
            node.dispatchEvent(new Event('input',{bubbles:true}));
            node.dispatchEvent(new Event('change',{bubbles:true}));
        }''', value)
    page.wait_for_function('''({storage,key,value}) => JSON.parse(localStorage.getItem(storage))[key] === value''',
                           arg={'storage': NATIVE_KEY, 'key': key, 'value': value})
    expect(page.locator('.space-detail-status')).to_contain_text('已保存')


def material_styles(surface):
    return surface.evaluate('''node => {
        const style = getComputedStyle(node), rim = getComputedStyle(node, '::before'), glow = getComputedStyle(node, '::after');
        return {
            background: style.backgroundImage, color: style.backgroundColor,
            shadow: style.boxShadow, backdrop: style.backdropFilter,
            rim: rim.backgroundImage, glowBlur: glow.filter,
            opacitySetting: style.getPropertyValue('--glass-opacity').trim(),
            highlightSetting: style.getPropertyValue('--glass-blur').trim()
        };
    }''')


def matching_materials(page, launcher):
    page.mouse.move(0, 0)
    launcher.mouse.move(0, 0)
    preview = material_styles(page.locator('.space-detail-preview-surface'))
    card = material_styles(page.locator('.desktop-presentation-preview--space .desktop-preview-space'))
    real = material_styles(launcher.locator('.launcher-material'))
    assert preview == real, {'preview': preview, 'launcher': real}
    assert card == real, {'card': card, 'launcher': real}
    def icon_plate_styles(plate):
        return plate.evaluate('''node=>{
            const style=getComputedStyle(node),rim=getComputedStyle(node,'::after');
            return {background:style.backgroundImage,shadow:style.boxShadow,
                radius:style.borderRadius,rim:rim.boxShadow};
        }''')
    preview_plate=icon_plate_styles(page.locator('.space-demo-file-art').first)
    for plate in launcher.locator('.file-art').all():
        assert icon_plate_styles(plate)==preview_plate,{'preview':preview_plate,'launcher':icon_plate_styles(plate)}
    return real


def text_settings_entry_and_return_focus(browser, url):
    isolated = context(browser)
    try:
        page = open_settings(isolated, url)
        expect(page.locator('.desktop-presentation-card-title').first).to_contain_text('分类侧栏')
        expect(page.locator('#desktopPresentationSettings')).not_to_contain_text('原有桌面整理')
        page.locator('[data-organizer-presentation="space"]').check()
        entry = page.locator('#desktopSpaceSettingsAction')
        expect(page.get_by_role('button', name='空间设置', exact=True)).to_be_visible()
        expect(entry.locator('..').locator('#openDesktopSpace')).to_be_visible()
        before_modes = len(helpers.calls(page, 'set_desktop_organizer_mode'))
        entry.click()
        expect(page.locator('#desktopSpaceSettingsPage h3')).to_be_focused()
        expect(entry).to_have_attribute('aria-expanded', 'true')
        assert len(helpers.calls(page, 'set_desktop_organizer_mode')) == before_modes
        assert helpers.saved(page)['enabled'] is False
        page.locator('.space-detail-back').click()
        expect(entry).to_be_focused()
        expect(entry).to_have_attribute('aria-expanded', 'false')
        # The compact gear remains an independent entry with its own return target.
        open_details(page)
        page.locator('.space-detail-back').click()
        expect(page.locator('#desktopSpaceSettingsButton')).to_be_focused()
        page.set_viewport_size({'width': 640, 'height': 900})
        expect(entry).to_be_visible()
        actions = page.locator('.desktop-space-launch-actions').bounding_box()
        bounds = entry.bounding_box()
        assert actions and bounds and bounds['x'] >= actions['x'] and bounds['x'] + bounds['width'] <= 640, (actions, bounds)
        page.locator('#desktopPresentationSettings').screenshot(path=str(OUT / 'space-text-settings-entry.png'))
        print('PASS: category-sidebar name, adjacent text settings entry, independent opening and return focus for both entries', flush=True)
    finally:
        isolated.close()


def settings_and_live_launcher(browser, url):
    isolated = context(browser)
    try:
        page = open_settings(isolated, url)
        native_errors = []
        page.on('pageerror', lambda error: native_errors.append(str(error)))
        expect(page.locator('[data-organizer-presentation="classic"]')).to_be_checked()
        expect(page.locator('#desktopOrganizerToggle')).not_to_be_checked()
        before_modes = len(helpers.calls(page, 'set_desktop_organizer_mode'))
        gear, preview = page.locator('#desktopSpaceSettingsButton'), page.locator('.desktop-presentation-preview--space')
        bounds = {'gear': gear.bounding_box(), 'preview': preview.bounding_box()}
        assert bounds['gear'] and bounds['preview'], bounds
        g, p = bounds['gear'], bounds['preview']
        assert p['x'] + p['width'] * .75 < g['x'] < p['x'] + p['width'], bounds
        assert p['y'] - 4 <= g['y'] < p['y'] + p['height'] * .4, bounds
        page.locator('#desktopPresentationSettings').screenshot(path=str(OUT / 'card-dark-gear.png'))
        open_details(page)
        assert len(helpers.calls(page, 'set_desktop_organizer_mode')) == before_modes, 'Settings entry must not switch or enable the mode'
        assert helpers.saved(page)['presentation'] == 'classic' and helpers.saved(page)['enabled'] is False
        expect(page.locator('.space-detail-error')).to_be_hidden()
        page.locator('#desktopSpaceSettingsPage').screenshot(path=str(OUT / 'space-settings-default.png'))
        page.locator('.space-detail-back').click()
        expect(page.locator('#desktopSpaceSettingsPage')).to_be_hidden()
        expect(gear).to_be_focused()
        expect(page.locator('[data-organizer-presentation="classic"]')).to_be_checked()
        open_details(page)

        launcher = isolated.new_page()
        launcher.set_default_timeout(8000)
        launcher.goto(url + '/desktop-organizer/space.html', wait_until='networkidle')
        launcher.wait_for_function("window.__spaceCalls.some(call => call.command === 'get_desktop_space_settings')")
        launcher.evaluate("window.__TAURI__.event.emit('desktop-space-opened',{session:1})")
        expect(launcher.locator('#launcher')).to_have_attribute('aria-hidden', 'false')
        expect(launcher.locator('#fileGrid .launcher-card[data-id]')).to_have_count(3)
        color = launcher.locator('html').evaluate('node => ({scheme:getComputedStyle(node).colorScheme,color:getComputedStyle(node).color})')
        assert color['scheme'] == 'dark', color
        launcher.emulate_media(color_scheme='dark')
        assert launcher.locator('html').evaluate('node => getComputedStyle(node).color') == color['color']
        launcher.emulate_media(color_scheme='light')
        assert launcher.locator('html').evaluate('node => getComputedStyle(node).colorScheme') == 'dark'
        default_material = matching_materials(page, launcher)
        assert default_material['background'] != 'none', default_material

        requested = {'glassOpacity': 82, 'blur': 41, 'iconSize': 'large', 'windowWidth': 86,
                     'windowHeight': 64, 'closeOnBlur': False, 'closeAfterOpen': False, 'reducedMotion': True}
        for key, value in requested.items():
            set_field(page, key, value)
        updates = page.evaluate("window.__spaceCalls.filter(call => call.command === 'update_desktop_space_settings').map(call => call.args.patch)")
        assert updates == [{key: value} for key, value in requested.items()], updates
        assert persisted(page) == {**DEFAULTS, **requested}
        launcher.wait_for_function("getComputedStyle(document.documentElement).getPropertyValue('--glass-opacity').trim() === '0.82'")
        launcher.wait_for_function("getComputedStyle(document.documentElement).getPropertyValue('--glass-blur').trim() === '41px'")
        expect(launcher.locator('html')).to_have_attribute('data-icon-size', 'large')
        expect(launcher.locator('html')).to_have_attribute('data-reduced-motion', 'true')
        changed_material = matching_materials(page, launcher)
        assert changed_material['background'] != default_material['background'], changed_material
        assert changed_material['glowBlur'] != default_material['glowBlur'], changed_material
        assert changed_material['backdrop'] == default_material['backdrop'], 'High-light softness must not change background blur'
        launcher.screenshot(path=str(OUT / 'launcher-dark-live-settings.png'))
        page.locator('#desktopSpaceSettingsPage').screenshot(path=str(OUT / 'space-settings-changed.png'))

        page.reload(wait_until='networkidle')
        page.locator('[data-view="settings"]').click()
        open_details(page)
        for key, value in requested.items():
            field = page.locator(f'[data-space-pref="{key}"]')
            if isinstance(value, bool):
                assert field.is_checked() == value, key
            else:
                expect(field).to_have_value(str(value))
        assert helpers.saved(page)['enabled'] is False
        page.locator('.space-detail-reset').click()
        page.wait_for_function('''({key,defaults}) => JSON.stringify(JSON.parse(localStorage.getItem(key))) === JSON.stringify(defaults)''',
                               arg={'key': NATIVE_KEY, 'defaults': DEFAULTS})
        launcher.wait_for_function("getComputedStyle(document.documentElement).getPropertyValue('--glass-opacity').trim() === '0.68'")
        expect(launcher.locator('html')).to_have_attribute('data-icon-size', 'medium')
        assert not native_errors, native_errors
        print('PASS: gear placement, independent settings, field patches, reload, live dark launcher, defaults', flush=True)
    finally:
        isolated.close()


def errors_and_retry(browser, url):
    isolated = context(browser)
    try:
        page = open_settings(isolated, url)
        page.evaluate('window.__failSpaceRead = true')
        page.locator('#desktopSpaceSettingsButton').click()
        expect(page.locator('.space-detail-error')).to_contain_text('READ_SPACE_FIXTURE')
        expect(page.locator('[data-space-pref="glassOpacity"]')).to_be_disabled()
        expect(page.locator('.space-detail-retry')).to_be_visible()
        page.evaluate('window.__failSpaceRead = false')
        page.locator('.space-detail-retry').click()
        expect(page.locator('[data-space-pref="glassOpacity"]')).to_be_enabled()
        expect(page.locator('.space-detail-error')).to_be_hidden()
        old = persisted(page)
        page.evaluate('window.__failSpaceSave = true')
        page.locator('[data-space-pref="glassOpacity"]').evaluate('''node => {
            node.value = '87'; node.dispatchEvent(new Event('change',{bubbles:true}));
        }''')
        expect(page.locator('.space-detail-error')).to_contain_text('SAVE_SPACE_FIXTURE')
        expect(page.locator('[data-space-pref="glassOpacity"]')).to_have_value(str(old['glassOpacity']))
        assert persisted(page) == old
        page.evaluate('window.__failSpaceSave = false')
        set_field(page, 'glassOpacity', 87)
        expect(page.locator('.space-detail-error')).to_be_hidden()
        assert persisted(page)['glassOpacity'] == 87
        print('PASS: read failure/retry and save failure/rollback/retry', flush=True)
    finally:
        isolated.close()


def slow_saves_preserve_other_drafts(browser, url):
    isolated = context(browser)
    try:
        page = open_settings(isolated, url)
        open_details(page)

        def hold_opacity(value):
            page.evaluate('''value => {
                const original = window.__TAURI__.core.invoke;
                delete window.__releaseHeldSpaceSave;
                delete window.__rejectHeldSpaceSave;
                window.__TAURI__.core.invoke = async (command,args) => {
                    if (command === 'update_desktop_space_settings' && args.patch.glassOpacity === value) {
                        await new Promise((resolve,reject) => {
                            window.__releaseHeldSpaceSave = resolve;
                            window.__rejectHeldSpaceSave = () => reject(new Error('HELD_SAVE_SPACE_FIXTURE'));
                        });
                    }
                    return original(command,args);
                };
                const field = document.querySelector('[data-space-pref="glassOpacity"]');
                field.value = String(value);
                field.dispatchEvent(new Event('input',{bubbles:true}));
                field.dispatchEvent(new Event('change',{bubbles:true}));
            }''', value)
            page.wait_for_function('typeof window.__releaseHeldSpaceSave === "function"')

        def draft(key, value):
            page.locator(f'[data-space-pref="{key}"]').evaluate('''(field,value) => {
                field.value = String(value); field.dispatchEvent(new Event('input',{bubbles:true}));
            }''', value)

        def commit(key):
            page.locator(f'[data-space-pref="{key}"]').evaluate("field => field.dispatchEvent(new Event('change',{bubbles:true}))")

        hold_opacity(82)
        draft('blur', 41)
        page.evaluate('window.__releaseHeldSpaceSave()')
        page.wait_for_function("JSON.parse(localStorage.getItem('__dtkit_test_native_space_settings_v1')).glassOpacity === 82")
        expect(page.locator('.space-detail-status')).to_contain_text('已保存')
        expect(page.locator('[data-space-pref="blur"]')).to_have_value('41')
        assert page.locator('.space-detail-preview-surface').evaluate("node => node.style.getPropertyValue('--glass-blur')") == '41px'
        commit('blur')
        page.wait_for_function("JSON.parse(localStorage.getItem('__dtkit_test_native_space_settings_v1')).blur === 41")

        # A newer draft of the same field survives the older request finishing.
        hold_opacity(83)
        draft('glassOpacity', 88)
        page.evaluate('window.__releaseHeldSpaceSave()')
        page.wait_for_function("JSON.parse(localStorage.getItem('__dtkit_test_native_space_settings_v1')).glassOpacity === 83")
        expect(page.locator('.space-detail-status')).to_contain_text('已保存')
        expect(page.locator('[data-space-pref="glassOpacity"]')).to_have_value('88')
        commit('glassOpacity')
        page.wait_for_function("JSON.parse(localStorage.getItem('__dtkit_test_native_space_settings_v1')).glassOpacity === 88")

        # Failed writes roll back only their unchanged field, not another drag.
        hold_opacity(85)
        draft('blur', 44)
        page.evaluate('window.__rejectHeldSpaceSave()')
        expect(page.locator('.space-detail-error')).to_contain_text('HELD_SAVE_SPACE_FIXTURE')
        expect(page.locator('[data-space-pref="glassOpacity"]')).to_have_value('88')
        expect(page.locator('[data-space-pref="blur"]')).to_have_value('44')
        commit('blur')
        page.wait_for_function("JSON.parse(localStorage.getItem('__dtkit_test_native_space_settings_v1')).blur === 44")
        expect(page.locator('.space-detail-error')).to_contain_text('HELD_SAVE_SPACE_FIXTURE')
        set_field(page, 'glassOpacity', 86)
        expect(page.locator('.space-detail-error')).to_be_hidden()

        # Returning to the card never cancels an already submitted preference.
        hold_opacity(87)
        page.locator('.space-detail-back').click()
        page.evaluate('window.__releaseHeldSpaceSave()')
        page.wait_for_function("JSON.parse(localStorage.getItem('__dtkit_test_native_space_settings_v1')).glassOpacity === 87")
        open_details(page)
        expect(page.locator('[data-space-pref="glassOpacity"]')).to_have_value('87')
        draft('glassOpacity', 89)
        draft('blur', 46)
        page.locator('.space-detail-reset').click()
        page.wait_for_function('''({key,defaults}) => JSON.stringify(JSON.parse(localStorage.getItem(key))) === JSON.stringify(defaults)''',
                               arg={'key': NATIVE_KEY, 'defaults': DEFAULTS})
        expect(page.locator('[data-space-pref="glassOpacity"]')).to_have_value('68')
        expect(page.locator('[data-space-pref="blur"]')).to_have_value('30')
        print('PASS: slow responses preserve drafts, per-field rollback, submitted saves and explicit reset', flush=True)
    finally:
        isolated.close()



def preview_draft(page, key, value):
    page.locator(f'[data-space-pref="{key}"]').evaluate("""(field,value) => {
        if (field.type === 'checkbox') field.checked = value;
        else field.value = String(value);
        field.dispatchEvent(new Event('input',{bubbles:true}));
    }""", value)


def expect_preview_size(page, width, height):
    page.wait_for_function("""({width,height}) => {
        const stage = document.querySelector('[data-preview-stage]').getBoundingClientRect();
        const panel = document.querySelector('.space-detail-preview-surface').getBoundingClientRect();
        return stage.width > 0 && stage.height > 0
            && Math.abs(panel.width / stage.width - width / 100) < .035
            && Math.abs(panel.height / stage.height - height / 100) < .035;
    }""", arg={'width': width, 'height': height})


def preview_density(page):
    return page.locator('[data-preview-grid]').evaluate("""grid => ({
        columns: getComputedStyle(grid).gridTemplateColumns,
        gap: getComputedStyle(grid).gap,
        icon: grid.querySelector('[data-preview-file] svg').getBoundingClientRect().width
    })""")


def live_preview_drafts_and_interactions(browser, url):
    isolated = context(browser)
    try:
        page = open_settings(isolated, url)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        open_details(page)
        surface = page.locator('.space-detail-preview-surface')
        files = page.locator('[data-preview-file]:visible')
        feedback = page.locator('[data-preview-feedback]')
        expect(files).to_have_count(6)
        for name in ['项目资料', '项目计划.md', '海岸壁纸.png', '设计工具', '会议记录.txt', '演示视频.mp4']:
            expect(files.filter(has_text=name)).to_have_count(1)
        before_files = page.evaluate('window.__previewNativeFileCalls')
        before_settings = persisted(page)
        before_updates = page.evaluate("window.__spaceCalls.filter(call => call.command === 'update_desktop_space_settings').length")
        expect_preview_size(page, 90, 70)

        # Input events update the local example before change submits a save.
        preview_draft(page, 'glassOpacity', 84)
        preview_draft(page, 'blur', 44)
        preview_draft(page, 'windowWidth', 70)
        preview_draft(page, 'windowHeight', 55)
        assert surface.evaluate("node => node.style.getPropertyValue('--glass-opacity')") == '0.84'
        assert surface.evaluate("node => node.style.getPropertyValue('--glass-blur')") == '44px'
        expect_preview_size(page, 70, 55)
        assert persisted(page) == before_settings
        assert page.evaluate("window.__spaceCalls.filter(call => call.command === 'update_desktop_space_settings').length") == before_updates

        # Density changes both the icon artwork size and the real grid layout.
        preview_draft(page, 'windowWidth', 96)
        preview_draft(page, 'windowHeight', 90)
        preview_draft(page, 'iconSize', 'small')
        expect(surface).to_have_attribute('data-icon-size', 'small')
        compact = preview_density(page)
        preview_draft(page, 'iconSize', 'large')
        expect(surface).to_have_attribute('data-icon-size', 'large')
        roomy = preview_density(page)
        assert roomy['icon'] > compact['icon'], (compact, roomy)
        assert (roomy['columns'], roomy['gap']) != (compact['columns'], compact['gap']), (compact, roomy)
        preview_draft(page, 'reducedMotion', True)
        expect(surface).to_have_attribute('data-reduced-motion', 'true')
        assert persisted(page) == before_settings
        assert page.evaluate("window.__spaceCalls.filter(call => call.command === 'update_desktop_space_settings').length") == before_updates

        # A failed commit restores the saved field in the example while other
        # unfinished inputs retain their material, size, and density drafts.
        page.evaluate('window.__failSpaceSave = true')
        page.locator('[data-space-pref="glassOpacity"]').evaluate("field => field.dispatchEvent(new Event('change',{bubbles:true}))")
        expect(page.locator('.space-detail-error')).to_contain_text('SAVE_SPACE_FIXTURE')
        expect(page.locator('[data-space-pref="glassOpacity"]')).to_have_value('68')
        assert surface.evaluate("node => node.style.getPropertyValue('--glass-opacity')") == '0.68'
        assert surface.evaluate("node => node.style.getPropertyValue('--glass-blur')") == '44px'
        expect_preview_size(page, 96, 90)
        expect(surface).to_have_attribute('data-icon-size', 'large')
        assert persisted(page) == before_settings
        page.evaluate('window.__failSpaceSave = false')
        page.locator('.space-detail-reset').click()
        page.wait_for_function("JSON.parse(localStorage.getItem('__dtkit_test_native_space_settings_v1')).glassOpacity === 68")
        expect(page.locator('[data-space-pref="blur"]')).to_have_value('30')
        expect_preview_size(page, 90, 70)

        # Alternate example backgrounds expose the same material's boundaries.
        page.locator('[data-preview-background="light"]').click()
        expect(page.locator('[data-preview-background="light"]')).to_have_attribute('aria-pressed', 'true')
        expect(surface).to_have_attribute('data-appearance', 'light')
        light = material_styles(surface)
        page.locator('[data-preview-background="dark"]').click()
        expect(surface).to_have_attribute('data-appearance', 'dark')
        dark = material_styles(surface)
        assert light['background'] != dark['background'], {'light': light, 'dark': dark}
        page.locator('[data-preview-background="mixed"]').click()
        expect(page.locator('[data-preview-background="mixed"]')).to_have_attribute('aria-pressed', 'true')

        # Filtering, search, and quick look use only the fixed example files.
        page.locator('[data-preview-filter="document"]').click()
        expect(files).to_have_count(2)
        page.locator('[data-preview-filter="image"]').click()
        expect(files).to_have_count(1)
        expect(files.first).to_contain_text('海岸壁纸.png')
        page.locator('[data-preview-filter="program"]').click()
        expect(files).to_have_count(1)
        expect(files.first).to_contain_text('设计工具')
        page.locator('[data-preview-filter="all"]').click()
        page.locator('[data-preview-search]').fill('会议')
        expect(files).to_have_count(1)
        expect(files.first).to_contain_text('会议记录.txt')
        page.locator('[data-preview-search]').fill('')
        expect(files).to_have_count(6)
        document = files.filter(has_text='项目计划.md')
        document.click()
        expect(document).to_have_attribute('aria-pressed', 'true')
        page.locator('[data-preview-action="quick-look"]').click()
        quick_look = page.locator('[data-preview-quick-look]')
        expect(quick_look).to_be_visible()
        expect(quick_look).to_contain_text('项目计划.md')
        quick_look.locator('[data-preview-action="close-preview"]').click()
        expect(quick_look).to_be_hidden()
        document.focus()
        document.press('Space')
        expect(quick_look).to_be_visible()
        quick_look.locator('[data-preview-action="close-preview"]').click()

        # The behavior controls can be tried without showing a native window.
        page.locator('[data-preview-action="open"]').click()
        expect(surface).to_be_hidden()
        expect(feedback).not_to_be_empty()
        page.locator('[data-preview-action="show"]').click()
        expect(surface).to_be_visible()
        set_field(page, 'closeAfterOpen', False)
        document.click()
        page.locator('[data-preview-action="open"]').click()
        expect(surface).to_be_visible()
        set_field(page, 'closeAfterOpen', True)
        document.focus()
        document.press('Enter')
        expect(surface).to_be_hidden()
        page.locator('[data-preview-action="show"]').click()
        set_field(page, 'closeOnBlur', False)
        page.locator('[data-preview-action="blur"]').click()
        expect(surface).to_be_visible()
        set_field(page, 'closeOnBlur', True)
        page.locator('[data-preview-action="blur"]').click()
        expect(surface).to_be_hidden()
        page.locator('[data-preview-action="show"]').click()
        expect(surface).to_be_visible()
        assert page.evaluate('window.__previewNativeFileCalls') == before_files
        assert not helpers.calls(page, 'desktop_space_show')
        assert not errors, errors
        page.locator('.space-detail-preview').screenshot(path=str(OUT / 'space-interactive-preview.png'))
        print('PASS: input-only live material/size/density drafts, rollback, backgrounds, file interactions and simulated behavior without file IPC', flush=True)
    finally:
        isolated.close()


def preview_layout_and_control_visibility(browser, url):
    for width,height in [(1440,950),(1006,800),(640,900),(420,760)]:
        isolated=context(browser)
        try:
            page=open_settings(isolated,url)
            page.set_viewport_size({'width':width,'height':height})
            open_details(page)
            preview_draft(page,'windowWidth',60)
            preview_draft(page,'windowHeight',45)
            preview_draft(page,'iconSize','large')
            expect_preview_size(page,60,45)
            page.wait_for_function('''() => {
                const grid=document.querySelector('[data-preview-grid]').getBoundingClientRect();
                const icon=document.querySelector('[data-preview-file] svg').getBoundingClientRect();
                return icon.width>15 && icon.top>=grid.top-1 && icon.bottom<=grid.bottom+1;
            }''')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,height)
            # Test the actual pointer path after scrolling to a lower setting.
            # A sticky example must not cover the control it is demonstrating.
            field=page.locator('[data-space-pref="windowHeight"]')
            field.scroll_into_view_if_needed()
            box=field.bounding_box();assert box
            x,y=box['x']+box['width']*.8,box['y']+box['height']/2
            hit=field.evaluate('''(node,point) => {
                const hit=document.elementFromPoint(point.x,point.y);
                return hit===node || node.contains(hit);
            }''',{'x':x,'y':y})
            assert hit,{'viewport':(width,height),'control':box,'preview':page.locator('.space-detail-preview').bounding_box()}
            page.mouse.click(x,y)
            page.wait_for_function("document.querySelector('[data-space-pref=windowHeight]').value!=='45'")
            value=int(field.input_value())
            expect_preview_size(page,60,value)
            if width>=1000:
                bounds=page.locator('.space-detail-preview').bounding_box()
                assert bounds['y']>=-2 and bounds['y']+bounds['height']<=height+2,((width,height),bounds)
            page.screenshot(path=str(OUT/f'live-preview-layout-{width}.png'))
        finally:isolated.close()
    print('PASS: minimal window and large icons remain visible; scrolled settings accept real pointer input at wide, medium and narrow widths',flush=True)


def main():
    url, stop = helpers.local_test_url()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                text_settings_entry_and_return_focus(browser, url)
                live_preview_drafts_and_interactions(browser, url)
                preview_layout_and_control_visibility(browser, url)
                settings_and_live_launcher(browser, url)
                errors_and_retry(browser, url)
                slow_saves_preserve_other_drafts(browser, url)
            finally:
                browser.close()
    finally:
        stop()
    print(f'desktop space settings UI smoke passed; screenshots={OUT}', flush=True)


if __name__ == '__main__':
    main()
