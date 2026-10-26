"""Real settings gear, persisted preferences, live dark surface and native sizing.

Only accepts the isolated native-smoke application. Backs up its three config
files, creates no desktop fixtures, opens no external application, and stops
only the child launched by the shared harness.
"""
import argparse
import importlib.util
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('space_settings_native_helpers', ROOT / 'tests/desktop-launcher-native-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
helpers.CONFIG_NAMES.add('desktop-space-settings.json')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    args = parser.parse_args()
    state = helpers.RunState()

    def scenario(seed, context, process):
        page = helpers.main_page(seed, context)
        assert helpers.check_isolation(page) == state.config
        helpers.invoke(page, 'set_desktop_organizer_mode', enabled=False, presentation='classic')
        page.evaluate("localStorage.setItem('dtkit_desktop_organizer',JSON.stringify({enabled:false,presentation:'classic',reducedMotion:false}))")
        page.reload(wait_until='networkidle')
        page.locator('[data-view="settings"]').click()
        page.locator('#desktopSpaceSettingsButton').click()
        detail = page.locator('#desktopSpaceSettingsPage')
        expect(detail).to_be_visible()
        expect(detail.locator('fieldset')).to_be_enabled()
        mode = helpers.invoke(page, 'get_desktop_organizer_mode')
        assert not mode['enabled'] and mode['presentation'] == 'classic', mode

        def change(key, value):
            control = detail.locator(f'[data-space-pref="{key}"]')
            if isinstance(value, bool):
                if control.is_checked() == value:
                    return
                control.set_checked(value)
            elif isinstance(value, str):
                control.select_option(value)
            else:
                control.evaluate("(node,value)=>{node.value=String(value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}",value)
            page.wait_for_function("({key,value})=>window.__TAURI__.core.invoke('get_desktop_space_settings').then(settings=>settings[key]===value)",arg={'key':key,'value':value})
            expect(detail.locator('.space-detail-status')).to_contain_text('已保存')

        for key,value in {'glassOpacity':78,'blur':36,'iconSize':'large','windowWidth':76,'windowHeight':60,'closeOnBlur':False,'closeAfterOpen':False,'reducedMotion':True}.items():
            change(key,value)
        saved = helpers.invoke(page,'get_desktop_space_settings')
        assert saved['glassOpacity'] == 78 and not saved['closeOnBlur'] and saved['iconSize'] == 'large',saved
        detail.locator('.space-detail-open').click()
        launcher = helpers.launcher_page(page,context)
        windows = helpers.NativeWindows()
        helpers.native.wait_until(lambda:windows.visible(process))
        launcher.wait_for_function("document.documentElement.dataset.iconSize==='large' && getComputedStyle(document.documentElement).getPropertyValue('--glass-opacity').trim()==='0.78'")
        appearance=launcher.evaluate("document.documentElement.dataset.appearance")
        assert launcher.evaluate("getComputedStyle(document.documentElement).colorScheme") == appearance
        assert launcher.evaluate("document.documentElement.dataset.reducedMotion") == 'true'
        wide = launcher.evaluate('({width:innerWidth,height:innerHeight})')

        # A real focus transfer must respect the disabled close-on-blur setting.
        page.locator('.space-detail-heading h3').click()
        page.wait_for_timeout(150)
        assert windows.visible(process),'closeOnBlur=false did not preserve the native window'
        launcher.keyboard.press('Escape')
        helpers.native.wait_until(lambda:not windows.visible(process))
        helpers.invoke(page,'update_desktop_space_settings',patch={'windowWidth':60})
        helpers.invoke(page,'desktop_space_show')
        launcher.wait_for_function('width=>innerWidth<width',arg=wide['width'])
        assert launcher.evaluate('innerHeight') == wide['height']
        launcher.keyboard.press('Escape')
        helpers.native.wait_until(lambda:not windows.visible(process))

        # Reload the actual settings UI, then verify the native saved values.
        page.reload(wait_until='networkidle')
        page.locator('[data-view="settings"]').click()
        page.locator('#desktopSpaceSettingsButton').click()
        expect(page.locator('#desktopSpaceSettingsPage fieldset')).to_be_enabled()
        expect(page.locator('#space-pref-glassOpacity')).to_have_value('78')
        expect(page.locator('#space-pref-windowWidth')).to_have_value('60')
        expect(page.locator('#space-pref-closeOnBlur')).not_to_be_checked()
        expect(page.locator('#space-pref-iconSize')).to_have_value('large')
        helpers.rejected(page,'update_desktop_space_settings','unknown field',patch={'eraseFiles':True})
        assert helpers.invoke(page,'get_desktop_space_settings')['glassOpacity'] == 78
        # Revisiting the detail view must read the current native event state,
        # rather than the resolved snapshot from its first initialization.
        page.locator('.space-detail-back').click()
        helpers.invoke(page,'update_desktop_space_settings',patch={'glassOpacity':74})
        page.locator('#desktopSpaceSettingsButton').click()
        expect(page.locator('#desktopSpaceSettingsPage fieldset')).to_be_enabled()
        expect(page.locator('#space-pref-glassOpacity')).to_have_value('74')
        helpers.invoke(page,'set_desktop_organizer_mode',enabled=False,presentation='classic')
        print('PASS: native settings gear, isolated selection, persistence/reload, live dark material/density/motion, native window sizing and close-on-blur',flush=True)

    try:
        with sync_playwright() as playwright:
            helpers.native.run_case(playwright,args.exe.resolve(strict=True),[],state.prime)
            helpers.native.run_case(playwright,args.exe.resolve(strict=True),[],scenario)
    finally:
        state.restore()


if __name__ == '__main__':
    main()
