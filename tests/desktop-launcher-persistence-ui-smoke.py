"""Production-DOM regression for launcher preference read/write failures.

Run after npm run build. Uses isolated browser storage and mocked file IPC;
it never opens real files or changes the user's native configuration.
"""

import importlib.util
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
KEY = 'dtkit_desktop_space_v2'
LEGACY = 'dtkit_desktop_space_v1'
CLASSIC = 'dtkit_desktop_classic_categories_v1'
spec = importlib.util.spec_from_file_location('launcher_persistence_helpers', ROOT / 'tests/desktop-launcher-ui-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

BRAVO = {'path': r'C:\Users\demo\Desktop\Bravo.txt', 'name': 'Bravo.txt',
         'is_folder': False, 'category': 'document', 'size': 1024}
ORDER = ['file:c:\\users\\demo\\desktop\\charlie.txt', 'file:c:\\users\\demo\\desktop\\alpha.txt']
CURRENT = {'version': 2, 'pinned': [BRAVO], 'orders': {'root': ORDER, 'pinned': ['file:c:\\users\\demo\\desktop\\bravo.txt']}}


def open_page(browser, url, initial, *, block_key=KEY):
    context = browser.new_context(viewport={'width': 1100, 'height': 700})
    context.add_init_script(helpers.MOCK_TAURI + r'''
        const originalSetItem = Storage.prototype.setItem;
        const initial = __INITIAL__;
        for (const [key, value] of Object.entries(initial)) {
            if (localStorage.getItem(key) === null) originalSetItem.call(localStorage, key, value);
        }
        window.__blockedPreferenceKey = __BLOCK_KEY__;
        window.__failPreferenceWrite = true;
        window.__preferenceWrites = [];
        Storage.prototype.setItem = function(key, value) {
            if (key === window.__blockedPreferenceKey) {
                window.__preferenceWrites.push(key);
                if (window.__failPreferenceWrite) throw new Error('fixture preference quota exceeded');
            }
            return originalSetItem.call(this, key, value);
        };
    '''.replace('__INITIAL__', json.dumps(initial)).replace('__BLOCK_KEY__', json.dumps(block_key)))
    page = context.new_page()
    page.set_default_timeout(8000)
    page.goto(url + '/desktop-organizer/space.html', wait_until='networkidle')
    helpers.open_panel(page)
    return context, page


def pin(page, name):
    helpers.card(page, name).locator('.pin-button').click()


def saved(page):
    return page.evaluate('key => JSON.parse(localStorage.getItem(key))', KEY)


def valid_v2_keeps_existing_state(browser, url):
    raw = json.dumps(CURRENT, indent=2)
    context, page = open_page(browser, url, {KEY: raw})
    try:
        expect(helpers.card(page, 'Bravo.txt', '#pinnedGrid')).to_be_visible()
        assert page.evaluate('window.__preferenceWrites.length') == 0, 'Loading valid v2 must not depend on writable storage'
        pin(page, 'Alpha.txt')
        expect(page.locator('#spaceStatus')).to_contain_text('无法保存')
        assert page.evaluate('key => localStorage.getItem(key)', KEY) == raw
        page.evaluate('window.__failPreferenceWrite = false')
        pin(page, 'Alpha.txt')
        expect(helpers.card(page, 'Alpha.txt', '#pinnedGrid')).to_be_visible()
        expect(helpers.card(page, 'Bravo.txt', '#pinnedGrid')).to_be_visible()
        result = saved(page)
        assert {file['name'] for file in result['pinned']} == {'Alpha.txt', 'Bravo.txt'}
        assert result['orders']['root'] == ORDER
        page.reload(wait_until='networkidle')
        helpers.open_panel(page)
        for name in ('Alpha.txt', 'Bravo.txt'):
            expect(helpers.card(page, name, '#pinnedGrid')).to_be_visible()
        assert saved(page)['orders']['root'] == ORDER
    finally:
        context.close()


def corrupt_v2_is_read_only_until_repaired(browser, url):
    raw = '{"version":2,"pinned":[BROKEN ORIGINAL DATA'
    context, page = open_page(browser, url, {KEY: raw})
    try:
        pin(page, 'Alpha.txt')
        expect(page.locator('#spaceStatus')).to_contain_text('暂停修改')
        assert page.evaluate('key => localStorage.getItem(key)', KEY) == raw
        assert page.evaluate('window.__preferenceWrites.length') == 0
        page.evaluate('''({key,current}) => {
            window.__failPreferenceWrite = false;
            localStorage.setItem(key, JSON.stringify(current));
            window.dispatchEvent(new StorageEvent('storage', {key}));
        }''', {'key': KEY, 'current': CURRENT})
        expect(helpers.card(page, 'Bravo.txt', '#pinnedGrid')).to_be_visible()
        pin(page, 'Alpha.txt')
        expect(helpers.card(page, 'Alpha.txt', '#pinnedGrid')).to_be_visible()
        assert {file['name'] for file in saved(page)['pinned']} == {'Alpha.txt', 'Bravo.txt'}
    finally:
        context.close()


def legacy_retirement_waits_for_backup(browser, url):
    raw = json.dumps({'version': 1, 'groups': {'document': {'name': '保留类别'}}, 'orders': {'document': ORDER}})
    context, page = open_page(browser, url, {LEGACY: raw}, block_key=CLASSIC)
    try:
        expect(page.locator('#spaceStatus')).to_contain_text('旧数据迁移未完成')
        pin(page, 'Alpha.txt')
        expect(page.locator('#spaceStatus')).to_contain_text('无法保存')
        assert page.evaluate('key => localStorage.getItem(key)', LEGACY) == raw
        assert page.evaluate('key => localStorage.getItem(key)', KEY) is None
        page.evaluate('window.__failPreferenceWrite = false')
        pin(page, 'Alpha.txt')
        expect(helpers.card(page, 'Alpha.txt', '#pinnedGrid')).to_be_visible()
        assert page.evaluate('key => localStorage.getItem(key)', LEGACY) is None
        classic = page.evaluate('key => JSON.parse(localStorage.getItem(key))', CLASSIC)
        assert classic['names']['document'] == '保留类别'
        assert classic['orders']['document'] == ORDER
        assert saved(page)['orders']['root'] == ORDER
    finally:
        context.close()


def main():
    url, stop = helpers.local_test_url()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for scenario in (valid_v2_keeps_existing_state, corrupt_v2_is_read_only_until_repaired, legacy_retirement_waits_for_backup):
                    scenario(browser, url)
                    print(f'PASS: {scenario.__name__}', flush=True)
            finally:
                browser.close()
    finally:
        stop()
    print('desktop launcher preference persistence UI smoke passed', flush=True)


if __name__ == '__main__':
    main()
