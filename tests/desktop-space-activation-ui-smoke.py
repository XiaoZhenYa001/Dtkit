"""Exercise desktop-space activation through the production settings DOM.

Run after npm run build. Each scenario has isolated browser storage; no native
application or real global shortcut is changed.
"""

import functools
import http.server
import json
import os
from pathlib import Path
import threading

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
KEY = 'dtkit_desktop_organizer'


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


MOCK = r"""
(() => {
    const initial = __INITIAL_SETTINGS__;
    localStorage.setItem('dtkit_desktop_organizer', JSON.stringify(initial));
    window.__mode = {configured:true, ...initial, shortcutWarning:null};
    window.__calls = [];
    window.__modeError = '';
    window.__showError = '';
    window.__shortcutWarning = null;
    window.__bindings = [
        {accelerator:'Ctrl+Alt+Space',target:{kind:'palette'},enabled:true},
        {accelerator:'Ctrl+Alt+T',target:{kind:'tool',toolId:'timestamp-converter'},enabled:true}
    ];
    const listeners = new Map();
    window.__TAURI__ = {
        core: {invoke: async (command, args={}) => {
            window.__calls.push({command,args:structuredClone(args)});
            if (command === 'get_desktop_organizer_mode') return window.__mode;
            if (command === 'set_desktop_organizer_mode') {
                if (args.enabled && args.presentation === 'space') {
                    if (window.__modeError) throw new Error(window.__modeError);
                    if (!window.__shortcutWarning && !window.__bindings.some(binding => binding.target.kind === 'desktopSpace')) {
                        window.__bindings.push({accelerator:'Ctrl+Alt+D',target:{kind:'desktopSpace'},enabled:true});
                    }
                }
                window.__mode = {configured:true,...args,shortcutWarning:args.enabled && args.presentation === 'space' ? window.__shortcutWarning : null};
                return window.__mode;
            }
            if (command === 'desktop_space_show') {
                if (window.__showError) throw new Error(window.__showError);
                if (!window.__mode.enabled || window.__mode.presentation !== 'space') throw new Error('桌面空间尚未启用');
                return null;
            }
            if (command === 'get_shortcut_bindings') return structuredClone(window.__bindings);
            if (command === 'upsert_shortcut_binding') {
                window.__bindings = window.__bindings.filter(item => JSON.stringify(item.target) !== JSON.stringify(args.binding.target));
                window.__bindings.push(structuredClone(args.binding)); return structuredClone(window.__bindings);
            }
            if (command === 'remove_shortcut_binding') {
                window.__bindings = window.__bindings.filter(item => JSON.stringify(item.target) !== JSON.stringify(args.target)); return structuredClone(window.__bindings);
            }
            if (command === 'replace_shortcut_bindings') {
                window.__bindings = structuredClone(args.bindings); return window.__bindings;
            }
            if (command === 'take_missed_alarm_triggers') return [];
            return null;
        }},
        event: {
            listen: async (name, callback) => {
                if (!listeners.has(name)) listeners.set(name,new Set());
                listeners.get(name).add(callback);
                return () => listeners.get(name)?.delete(callback);
            },
            emit: async (name,payload) => {
                for (const callback of listeners.get(name)||[]) callback({payload});
            }
        },
        window: {getCurrentWindow: () => ({label:'main',
            innerSize:async()=>({width:1280,height:850}),
            innerPosition:async()=>({x:0,y:0}),
            setSize:async()=>{},setPosition:async()=>{}
        })}
    };
})();
"""


def local_test_url():
    configured = os.environ.get('DTKIT_TEST_BASE_URL')
    if configured:
        return configured.rstrip('/'), lambda: None
    assert (ROOT / 'dist/index.html').is_file(), 'Run npm run build first'
    handler = functools.partial(QuietHandler, directory=str(ROOT / 'dist'))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def close():
        server.shutdown()
        server.server_close()

    return f'http://127.0.0.1:{server.server_port}', close


def saved(page):
    return page.evaluate('key => JSON.parse(localStorage.getItem(key))', KEY)


def calls(page, command):
    return page.evaluate('command => window.__calls.filter(call => call.command === command)', command)


def open_settings(browser, url, *, enabled, presentation):
    context = browser.new_context(viewport={'width':1280,'height':900})
    context.add_init_script(MOCK.replace('__INITIAL_SETTINGS__', json.dumps({
        'enabled':enabled,'autoAnalyze':False,'presentation':presentation,'reducedMotion':False
    })))
    page = context.new_page()
    page.set_default_timeout(7000)
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(url, wait_until='networkidle')
    page.locator('[data-view="settings"]').click()
    page.locator('#desktopPresentationSettings[data-initialized="true"]').wait_for()
    page.wait_for_function('window.__calls.some(call => call.command === "get_shortcut_bindings")')
    return context, page


def click_open(page):
    page.locator('#openDesktopSpace').click()
    # Accept the existing explicit enable modal if this action uses it.
    confirmation = page.locator('#desktopOrganizerConfirmDialog')
    if confirmation.is_visible():
        page.locator('#confirmDesktopOrganizer').click()


def enabled_switch(browser, url):
    context, page = open_settings(browser, url, enabled=True, presentation='classic')
    try:
        page.locator('[data-organizer-presentation="space"]').check()
        expect(page.locator('[data-organizer-presentation="space"]')).to_be_checked()
        expect(page.locator('#openDesktopSpace')).to_be_enabled()
        click_open(page)
        page.wait_for_function('window.__calls.some(call => call.command === "desktop_space_show")')
        assert saved(page)['enabled'] is True and saved(page)['presentation'] == 'space'
        bindings = page.evaluate('window.__bindings')
        assert any(item['target']['kind'] == 'palette' and item['accelerator'] == 'Ctrl+Alt+Space' for item in bindings)
        assert any(item['target'].get('toolId') == 'timestamp-converter' for item in bindings)
        expect(page.locator('.desktop-presentation-error[role="alert"]')).to_be_hidden()
    finally:
        context.close()


def disabled_open(browser, url):
    context, page = open_settings(browser, url, enabled=False, presentation='space')
    try:
        expect(page.locator('#desktopOrganizerToggle')).not_to_be_checked()
        expect(page.locator('#openDesktopSpace')).to_be_enabled()
        expect(page.locator('#openDesktopSpace')).to_contain_text('启用并打开')
        assert not any(call['args'].get('enabled') is True for call in calls(page,'set_desktop_organizer_mode'))
        click_open(page)
        page.wait_for_function('window.__calls.some(call => call.command === "desktop_space_show")')
        expect(page.locator('#desktopOrganizerToggle')).to_be_checked()
        expect(page.locator('#desktopOrganizerSubSettings')).to_be_visible()
        expect(page.locator('#openDesktopSpace')).to_contain_text('打开空间')
        assert saved(page)['enabled'] is True and saved(page)['presentation'] == 'space'
        sequence = page.evaluate('window.__calls')
        enabled_index = next(i for i, call in enumerate(sequence) if call['command'] == 'set_desktop_organizer_mode' and call['args'].get('enabled') is True)
        show_index = next(i for i, call in enumerate(sequence) if call['command'] == 'desktop_space_show')
        assert enabled_index < show_index
    finally:
        context.close()


def activation_error(browser, url):
    context, page = open_settings(browser, url, enabled=True, presentation='classic')
    try:
        page.evaluate("window.__modeError = '创建桌面空间失败：ACTIVATION_FIXTURE'")
        page.locator('[data-organizer-presentation="space"]').click()
        expect(page.locator('.desktop-presentation-error[role="alert"]')).to_contain_text('ACTIVATION_FIXTURE')
        expect(page.locator('[data-organizer-presentation="classic"]')).to_be_checked()
        expect(page.locator('#desktopOrganizerToggle')).to_be_checked()
        assert saved(page)['enabled'] is True and saved(page)['presentation'] == 'classic'
        assert not calls(page,'desktop_space_show')
        page.evaluate("window.__modeError = ''")
        page.locator('[data-organizer-presentation="space"]').check()
        expect(page.locator('#openDesktopSpace')).to_be_enabled()
        click_open(page)
        page.wait_for_function('window.__calls.some(call => call.command === "desktop_space_show")')
    finally:
        context.close()


def show_error_after_enable(browser, url):
    context, page = open_settings(browser, url, enabled=False, presentation='space')
    try:
        page.evaluate("window.__showError = '无法显示窗口：SHOW_FIXTURE'")
        expect(page.locator('#openDesktopSpace')).to_be_enabled()
        click_open(page)
        expect(page.locator('.desktop-presentation-error[role="alert"]')).to_contain_text('SHOW_FIXTURE')
        expect(page.locator('#desktopOrganizerToggle')).to_be_checked()
        expect(page.locator('#desktopOrganizerSubSettings')).to_be_visible()
        expect(page.locator('#openDesktopSpace')).to_be_enabled()
        expect(page.locator('#openDesktopSpace')).to_contain_text('打开空间')
        assert saved(page)['enabled'] is True and saved(page)['presentation'] == 'space'
        assert page.evaluate('window.__mode.enabled') is True
    finally:
        context.close()


def disabled_activation_error(browser, url):
    context, page = open_settings(browser,url,enabled=False,presentation='space')
    try:
        page.evaluate("window.__modeError = '创建桌面空间失败：DISABLED_ACTIVATION_FIXTURE'")
        expect(page.locator('#openDesktopSpace')).to_be_enabled()
        click_open(page)
        expect(page.locator('.desktop-presentation-error[role="alert"]')).to_contain_text('DISABLED_ACTIVATION_FIXTURE')
        expect(page.locator('#desktopOrganizerToggle')).not_to_be_checked()
        expect(page.locator('#openDesktopSpace')).to_be_enabled()
        expect(page.locator('#openDesktopSpace')).to_contain_text('启用并打开')
        assert saved(page)['enabled'] is False and saved(page)['presentation'] == 'space'
        assert not calls(page,'desktop_space_show')
    finally:
        context.close()


def shortcut_warning_keeps_manual_open(browser, url):
    context, page = open_settings(browser,url,enabled=True,presentation='classic')
    try:
        page.evaluate("window.__shortcutWarning = '无法注册桌面空间快捷键：SHORTCUT_FIXTURE，请更改快捷键'")
        page.locator('[data-organizer-presentation="space"]').check()
        expect(page.locator('#desktopSpaceShortcutNotice')).to_contain_text('SHORTCUT_FIXTURE')
        expect(page.locator('#openDesktopSpace')).to_be_enabled()
        expect(page.locator('#desktopOrganizerToggle')).to_be_checked()
        assert saved(page)['enabled'] is True and saved(page)['presentation'] == 'space'
        click_open(page)
        page.wait_for_function('window.__calls.some(call => call.command === "desktop_space_show")')
        expect(page.locator('.desktop-presentation-error[role="alert"]')).to_be_hidden()
        assert len(page.evaluate('window.__bindings')) == 2
        page.locator('#desktopSpaceShortcut .shortcut-binding__record').click()
        page.keyboard.press('Control+Alt+Y')
        page.wait_for_function("window.__bindings.some(binding => binding.target.kind === 'desktopSpace')")
        expect(page.locator('#desktopSpaceShortcutNotice')).to_be_hidden()
        assert len(page.evaluate('window.__bindings')) == 3
    finally:
        context.close()


def main():
    url, close_server = local_test_url()
    failures = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for scenario in (enabled_switch, disabled_open, activation_error, show_error_after_enable, disabled_activation_error, shortcut_warning_keeps_manual_open):
                    try:
                        scenario(browser,url)
                        print(f'PASS: {scenario.__name__}',flush=True)
                    except Exception as error:
                        failures.append((scenario.__name__,str(error)))
                        print(f'FAIL: {scenario.__name__}: {error}',flush=True)
            finally:
                browser.close()
    finally:
        close_server()
    assert not failures, failures
    print('desktop space activation UI smoke passed',flush=True)


if __name__ == '__main__':
    main()
