"""Verify startup IPC/UI against this run's uniquely named Windows fixtures.

Build the isolated executable first (never use the production identifier):
  npm run build
  npm run tauri build -- --debug --no-bundle --config tests/native-webview.config.json
Run on an interactive Windows desktop:
  python tests/startup-manager-native-smoke.py --exe src-tauri/target/debug/DtKit.exe

Only token-named HKCU Run/RunOnce values and startup files are mutated. Generated
commands immediately exit if Windows ever starts them. No fixture is executed by
the test. Existing startup values/files are independently compared afterward.
"""

import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time
import winreg
from ctypes import wintypes
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location(
    'native_webview', Path(__file__).with_name('native-webview-ui-smoke.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

RUN = r'Software\Microsoft\Windows\CurrentVersion\Run'
RUN_ONCE = r'Software\Microsoft\Windows\CurrentVersion\RunOnce'
ADVAPI = ctypes.WinDLL('advapi32', use_last_error=True)
ADVAPI.RegQueryValueExW.argtypes = [wintypes.HKEY, wintypes.LPCWSTR, ctypes.c_void_p,
                                  ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
                                  ctypes.POINTER(wintypes.DWORD)]
ADVAPI.RegSetValueExW.argtypes = [wintypes.HKEY, wintypes.LPCWSTR, wintypes.DWORD,
                                wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]


def raw_value(key, name):
    size, kind = wintypes.DWORD(), wintypes.DWORD()
    result = ADVAPI.RegQueryValueExW(int(key), name, None, ctypes.byref(kind), None, ctypes.byref(size))
    if result == 2:
        return None
    assert result == 0, result
    buffer = (ctypes.c_ubyte * size.value)()
    assert ADVAPI.RegQueryValueExW(int(key), name, None, ctypes.byref(kind), buffer,
                                  ctypes.byref(size)) == 0
    return kind.value, bytes(buffer[:size.value])


def powershell(code, environment):
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', code],
                            env={**os.environ, **environment}, capture_output=True,
                            encoding='utf-8', errors='replace', timeout=20,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip().lstrip('\ufeff')


def invoke(page, command, args=None):
    return page.evaluate('''({command,args}) =>
        Object.getPrototypeOf(window.__TAURI__).core.invoke(command,args)''',
                         {'command': command, 'args': {'toolId': 'startup-manager', **(args or {})}})


def failure(page, command, args):
    message = page.evaluate('''async ({command,args}) => {
        try { await Object.getPrototypeOf(window.__TAURI__).core.invoke(command,args); return null; }
        catch (error) { return String(error); }
    }''', {'command': command, 'args': {'toolId': 'startup-manager', **args}})
    assert message, f'{command} unexpectedly succeeded'
    return message


def startup_folder():
    buffer = ctypes.create_unicode_buffer(32768)
    # CSIDL_STARTUP uses the same redirected user folder as FOLDERID_Startup.
    assert ctypes.windll.shell32.SHGetFolderPathW(None, 7, None, 0, buffer) == 0
    path = Path(buffer.value)
    assert path.is_absolute() and path.is_dir(), path
    assert not path.is_symlink() and not path.is_junction(), 'Startup folder must be an ordinary local directory'
    return path


class Fixtures:
    def __init__(self):
        self.token = uuid4().hex
        self.prefix = 'DtKit native startup ' + self.token
        self.root = None
        self.startup = None
        self.journal = None
        self.records = set()
        self.names = {
            'regular': self.prefix + ' 中文 REG_SZ',
            'expand': self.prefix + ' REG_EXPAND_SZ',
            'missing': self.prefix + ' Missing',
            'once': self.prefix + ' RunOnce',
        }
        self.files = set()
        self.registry_owned = set()
        self.keys = {}
        self.original_raw = {}
        self.non_fixture_registry = {}
        self.non_fixture_files = None
        self.initial_disabled_files = set()
        self.restart = {}

    def create(self, layout):
        assert native.IDENTIFIER in layout['root'], 'Refusing production storage'
        self.kits = Path(layout['kits'])
        self.root = Path(tempfile.mkdtemp(prefix='dtkit-startup-' + self.token + '-'))
        self.target = self.root / 'test program 中文.exe'
        shutil.copy2(Path(os.environ['SystemRoot']) / 'System32' / 'cmd.exe', self.target)
        self.arguments = '/d /c "rem DtKit ' + self.token + ' 中文 & exit /b 0"'
        self.startup = startup_folder()
        self.disabled = self.startup.parent / 'DtKitDisabledStartup'
        if self.disabled.is_dir():
            self.initial_disabled_files = {path.name for path in self.disabled.iterdir()}
        self.script = self.startup / (self.prefix + ' file.cmd')
        self.script_bytes = ('@echo off\r\nrem DtKit ' + self.token + '\r\nexit /b 0\r\n').encode('ascii')
        self.non_fixture_files = self.other_files()
        assert not (self.disabled / self.script.name).exists()
        assert not self.script.with_name(self.script.name + '.dtkit-disabled').exists()
        with self.script.open('xb') as stream:
            self.files.add(self.script.name)
            stream.write(self.script_bytes)
        for path in (RUN, RUN_ONCE):
            self.keys[path] = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0,
                                                winreg.KEY_READ | winreg.KEY_SET_VALUE)
            self.non_fixture_registry[path] = self.other_registry(path)
        commands = {
            'regular': f'"{self.target}" {self.arguments}',
            'expand': f'"%TEMP%\\{self.root.name}\\{self.target.name}" {self.arguments}',
            'missing': f'"{self.root / "missing.exe"}" --dtkit-{self.token}',
            'once': f'"{self.target}" {self.arguments}',
        }
        for kind, command in commands.items():
            name = self.names[kind]
            source = RUN_ONCE if kind == 'once' else RUN
            assert raw_value(self.keys[source], name) is None, 'Fixture name already exists'
            value_kind = winreg.REG_EXPAND_SZ if kind == 'expand' else winreg.REG_SZ
            # The regular value has an extra terminator to check exact byte recovery.
            value = value_kind, command.encode('utf-16-le') + b'\0\0' * (2 if kind == 'regular' else 1)
            self.original_raw[kind] = value
            self.registry_owned.add(kind)
            self.write(kind, value)

    def write(self, kind, value):
        assert kind in self.registry_owned, 'Refusing to edit a value not created by this run'
        path = RUN_ONCE if kind == 'once' else RUN
        data = ctypes.create_string_buffer(value[1])
        assert ADVAPI.RegSetValueExW(int(self.keys[path]), self.names[kind], 0,
                                    value[0], data, len(value[1])) == 0

    def raw(self, kind):
        return raw_value(self.keys[RUN_ONCE if kind == 'once' else RUN], self.names[kind])

    def owns(self, item):
        return (item['scope'] == 'user' and (item['name'] in self.names.values()
                or Path(item.get('sourcePath') or '').name in self.files))

    def claim(self, item):
        assert self.owns(item), 'Refusing to operate on another startup entry'
        self.records.add(item['id'])
        return item

    def find(self, snapshot, kind):
        name = self.names[kind] if kind in self.names else kind
        matches = [item for item in snapshot['items'] if item['name'] == name
                   or Path(item.get('sourcePath') or '').name == name]
        assert len(matches) == 1, (kind, len(matches))
        return self.claim(matches[0])

    def other_registry(self, path):
        result = {}
        key = self.keys[path]
        index = 0
        while True:
            try:
                name, _, _ = winreg.EnumValue(key, index)
            except OSError as error:
                if error.winerror == 259:
                    break
                raise
            index += 1
            if name not in self.names.values():
                kind, data = raw_value(key, name)
                result[name] = hashlib.sha256(kind.to_bytes(4, 'little') + data).digest()
        return result

    def other_files(self):
        return {path.name: (path.stat().st_size, path.stat().st_mtime_ns)
                for path in self.startup.iterdir() if path.is_file() and path.name not in self.files}

    def locate_journal(self):
        candidates = []
        for path in (self.kits / 'SystemAssistant').glob('recovery/*/startup-disabled.json'):
            try:
                value = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                continue
            if any(item.get('id') in self.records for item in
                   value.get('registryItems', []) + value.get('folderItems', [])):
                candidates.append(path)
        assert len(candidates) == 1, ('Fixture journal count', len(candidates))
        self.journal = candidates[0]
        assert native.IDENTIFIER in str(self.journal)
        assert self.journal.parent.name.isalnum() and len(self.journal.parent.name) == 64
        return json.loads(self.journal.read_text(encoding='utf-8'))

    def explorer(self, close=False):
        # An Explorer window is closed only if its location contains our fresh,
        # unique token. No existing user folder/window can match this token.
        code = r'''
            [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
            $items = @((New-Object -ComObject Shell.Application).Windows() | Where-Object {
                $_.LocationURL -like ('*' + $env:DTKIT_SMOKE_TOKEN + '*')
            })
            if ($env:DTKIT_SMOKE_CLOSE -eq '1') { $items | ForEach-Object { $_.Quit() }; exit 0 }
            @{ windows = @($items | ForEach-Object {
                @{ selected = @($_.Document.SelectedItems() | ForEach-Object { $_.Path }) }
            }) } | ConvertTo-Json -Depth 5 -Compress
        '''
        output = powershell(code, {'DTKIT_SMOKE_TOKEN': self.token,
                                   'DTKIT_SMOKE_CLOSE': '1' if close else '0'})
        return [] if close else json.loads(output)['windows']

    def cleanup(self):
        errors = []
        if self.root is not None:
            try:
                self.explorer(close=True)
            except Exception as error:
                errors.append(str(error))
        for kind in self.registry_owned:
            name = self.names[kind]
            key = self.keys.get(RUN_ONCE if kind == 'once' else RUN)
            if key is not None:
                try:
                    winreg.DeleteValue(key, name)
                except FileNotFoundError:
                    pass
                except OSError as error:
                    errors.append(str(error))
        if self.startup is not None:
            # Also catch a token-named link created immediately before a native
            # scan error, so even an interrupted add cannot leave a login item.
            for directory in (self.startup, self.disabled):
                if directory.is_dir():
                    existing = (self.non_fixture_files or {}) if directory == self.startup else self.initial_disabled_files
                    self.files.update(path.name for path in directory.iterdir()
                                      if self.token in path.name and path.is_file() and path.name not in existing)
            for name in self.files:
                for path in (self.startup / name, self.disabled / name,
                             self.startup / (name + '.dtkit-disabled')):
                    try:
                        path.unlink(missing_ok=True)
                    except OSError as error:
                        errors.append(str(error))
        if self.journal is not None and self.journal.is_file():
            try:
                store = json.loads(self.journal.read_text(encoding='utf-8'))
                for collection in ('registryItems', 'folderItems'):
                    store[collection] = [item for item in store.get(collection, [])
                                         if item.get('id') not in self.records
                                         and item.get('name') not in self.names.values()
                                         and self.token not in Path(item.get('originalPath') or '').name]
                temporary = self.journal.with_name('smoke-' + self.token + '.tmp')
                temporary.write_text(json.dumps(store, ensure_ascii=False), encoding='utf-8')
                temporary.replace(self.journal)
            except Exception as error:
                errors.append(str(error))
        for path, before in self.non_fixture_registry.items():
            if self.other_registry(path) != before:
                errors.append('Unrelated registry entries changed during the test')
        if self.non_fixture_files is not None and self.other_files() != self.non_fixture_files:
            errors.append('Unrelated startup files changed during the test')
        for key in self.keys.values():
            key.Close()
        if self.root is not None:
            assert self.root.resolve().parent == Path(tempfile.gettempdir()).resolve()
            assert self.root.name.startswith('dtkit-startup-' + self.token + '-')
            shutil.rmtree(self.root)
        assert not errors, errors


def scan(page):
    snapshot = invoke(page, 'scan_system_startup_items')
    assert snapshot['total'] == len(snapshot['items'])
    assert snapshot['enabled'] + snapshot['disabled'] == snapshot['total']
    assert snapshot['userItems'] + snapshot['systemItems'] == snapshot['total']
    return snapshot


def set_enabled(page, fixtures, item, enabled):
    fixtures.claim(item)
    return invoke(page, 'set_system_startup_enabled', {
        'id': item['id'], 'enabled': enabled, 'expectedFingerprint': item['fingerprint']})


def refresh(page):
    expect(page.locator('#systemRefresh')).to_be_enabled()
    page.locator('#systemRefresh').click()
    expect(page.locator('#systemRefresh')).to_be_enabled()
    expect(page.locator('#systemStatus')).to_contain_text('扫描完成')


def ui_toggle(page, fixtures, item, enabled):
    fixtures.claim(item)
    button = page.locator(f'[data-startup-toggle="{item["id"]}"]')
    expect(button).to_be_enabled()
    button.click()
    expect(button).to_have_attribute('aria-checked', str(enabled).lower())
    expect(button).to_be_enabled()


def first_run(page, context, process, fixtures):
    native.wait_until(lambda: page.evaluate('window.__DTKIT_TOOL_PAGE__?.ready === true'))
    fixtures.create(invoke(page, 'get_storage_layout'))
    expect(page.locator('#systemStartupPanel')).to_be_visible()
    expect(page.locator('#systemRefresh')).to_be_enabled()
    page.locator('#systemStartupSearch').fill(fixtures.token)
    refresh(page)
    snapshot = scan(page)
    for kind in ('regular', 'expand'):
        item = fixtures.find(snapshot, kind)
        assert item['enabled'] and item['canToggle'] and item['canReveal']
        assert Path(item['targetPath']).resolve() == fixtures.target.resolve(), kind
    missing = fixtures.find(snapshot, 'missing')
    assert not missing['targetExists'] and not missing['canReveal']
    expect(page.locator(f'[data-startup-reveal="{missing["id"]}"]')).to_be_disabled()
    failure(page, 'reveal_system_startup_item', {'id': missing['id'], 'target': 'program'})
    once = fixtures.find(snapshot, 'once')
    assert not once['canToggle'], 'RunOnce must remain read-only'
    failure(page, 'set_system_startup_enabled', {'id': once['id'], 'enabled': False,
                                               'expectedFingerprint': once['fingerprint']})
    assert fixtures.raw('once') == fixtures.original_raw['once']

    regular = fixtures.find(snapshot, 'regular')
    changed = (winreg.REG_SZ, (f'"{fixtures.target}" /d /c exit 9').encode('utf-16-le') + b'\0\0')
    fixtures.write('regular', changed)
    failure(page, 'set_system_startup_enabled', {'id': regular['id'], 'enabled': False,
                                               'expectedFingerprint': regular['fingerprint']})
    assert fixtures.raw('regular') == changed
    fixtures.write('regular', fixtures.original_raw['regular'])
    refresh(page)
    for kind in ('regular', 'expand'):
        item = fixtures.find(scan(page), kind)
        ui_toggle(page, fixtures, item, False)
        assert fixtures.raw(kind) is None
        disabled = fixtures.find(scan(page), kind)
        assert not disabled['enabled'] and disabled['managed']
        store = fixtures.locate_journal()
        record = next(record for record in store['registryItems'] if record['id'] == item['id'])
        assert bytes(record['rawBytes']) == fixtures.original_raw[kind][1]
        ui_toggle(page, fixtures, disabled, True)
        assert fixtures.raw(kind) == fixtures.original_raw[kind]
    print('PASS: real scan/UI, target resolution, RunOnce read-only, stale-state rejection and exact registry round trips', flush=True)

    # A newer same-name command is preserved while the obsolete backup is forgotten.
    item = fixtures.find(scan(page), 'regular')
    disabled = fixtures.find(set_enabled(page, fixtures, item, False), 'regular')
    fixtures.write('regular', changed)
    conflict = fixtures.find(scan(page), 'regular')
    assert conflict['backupConflict'] and conflict['canForgetBackup'] and not conflict['canToggle']
    failure(page, 'forget_system_startup_backup', {'id': conflict['id'], 'expectedFingerprint': disabled['fingerprint']})
    failure(page, 'set_system_startup_enabled', {'id': conflict['id'], 'enabled': False,
                                               'expectedFingerprint': conflict['fingerprint']})
    assert fixtures.raw('regular') == changed
    restored = fixtures.find(invoke(page, 'forget_system_startup_backup', {
        'id': conflict['id'], 'expectedFingerprint': conflict['fingerprint']}), 'regular')
    assert restored['canToggle'] and not restored['backupConflict']
    assert fixtures.raw('regular') == changed
    restored = fixtures.find(set_enabled(page, fixtures, restored, False), 'regular')
    set_enabled(page, fixtures, restored, True)
    assert fixtures.raw('regular') == changed

    # Startup files are moved outside the executable Startup folder without replacement.
    script = fixtures.find(scan(page), fixtures.script.name)
    disabled = fixtures.find(set_enabled(page, fixtures, script, False), fixtures.script.name)
    stored = Path(disabled['sourcePath'])
    assert stored == fixtures.disabled / fixtures.script.name
    assert stored.read_bytes() == fixtures.script_bytes and not fixtures.script.exists()
    stored.write_bytes(fixtures.script_bytes + b'rem external edit\r\n')
    edited = fixtures.find(scan(page), fixtures.script.name)
    failure(page, 'set_system_startup_enabled', {'id': edited['id'], 'enabled': True,
                                               'expectedFingerprint': edited['fingerprint']})
    assert not fixtures.script.exists() and stored.is_file()
    stored.write_bytes(fixtures.script_bytes)
    fixtures.script.write_bytes(b'@exit /b 0\r\nrem conflicting test file\r\n')
    conflicting_bytes = fixtures.script.read_bytes()
    conflict = fixtures.find(scan(page), fixtures.script.name)
    assert not conflict['canToggle']
    failure(page, 'set_system_startup_enabled', {'id': conflict['id'], 'enabled': True,
                                               'expectedFingerprint': conflict['fingerprint']})
    assert fixtures.script.read_bytes() == conflicting_bytes and stored.read_bytes() == fixtures.script_bytes
    fixtures.script.unlink()
    restored = fixtures.find(set_enabled(page, fixtures, fixtures.find(scan(page), fixtures.script.name), True), fixtures.script.name)
    assert restored['enabled'] and fixtures.script.read_bytes() == fixtures.script_bytes
    print('PASS: backup conflicts/forget preserve newer Run values; startup-file move, tamper and same-name conflict safeguards', flush=True)

    name = fixtures.prefix + ' 添加的程序'
    link = fixtures.startup / (name + '.lnk')
    assert not link.exists() and not (fixtures.disabled / link.name).exists() and not link.with_name(
        link.name + '.dtkit-disabled').exists(), 'Fixture file name already exists'
    fixtures.files.add(link.name)
    added = invoke(page, 'add_system_startup_item', {'path': str(fixtures.target), 'name': name,
                                                   'arguments': fixtures.arguments})
    item = fixtures.find(added, link.name)
    assert item['enabled'] and link.is_file()
    link_bytes = link.read_bytes()
    failure(page, 'add_system_startup_item', {'path': str(fixtures.target), 'name': name,
                                             'arguments': fixtures.arguments})
    assert link.read_bytes() == link_bytes
    details = json.loads(powershell(r'''
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $link = (New-Object -ComObject WScript.Shell).CreateShortcut($env:DTKIT_SMOKE_LINK)
        @{target=$link.TargetPath;arguments=$link.Arguments;workingDirectory=$link.WorkingDirectory} |
            ConvertTo-Json -Compress
    ''', {'DTKIT_SMOKE_LINK': str(link)}))
    assert Path(details['target']).resolve() == fixtures.target.resolve(), details
    assert details['arguments'] == fixtures.arguments, details
    assert Path(details['workingDirectory']).resolve() == fixtures.target.parent.resolve(), details
    assert Path(item['targetPath']).resolve() == fixtures.target.resolve()
    invoke(page, 'reveal_system_startup_item', {'id': item['id'], 'target': 'program'})
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        page.wait_for_timeout(100)
        windows = fixtures.explorer()
        if any(str(fixtures.target).casefold() in [str(path).casefold() for path in window['selected']]
               for window in windows):
            break
    else:
        raise AssertionError('Explorer did not select the generated program fixture')
    fixtures.explorer(close=True)
    print('PASS: real shortcut creation/COM arguments and working directory, duplicate rejection, native Explorer file selection', flush=True)

    # Corruption and an owner mismatch must leave the current account read-only.
    disabled = fixtures.find(set_enabled(page, fixtures, fixtures.find(scan(page), 'expand'), False), 'expand')
    store = fixtures.locate_journal()
    assert store['version'] == 2 and store['ownerHash'] == fixtures.journal.parent.name
    original_store = fixtures.journal.read_bytes()
    try:
        for corrupt in (b'{invalid startup journal', json.dumps({**store, 'ownerHash': '0' * 64}).encode('utf-8')):
            fixtures.journal.write_bytes(corrupt)
            read_only = scan(page)
            assert all(not item['canToggle'] for item in read_only['items'])
            assert read_only['recoveryState'] != 'ready' and read_only['recoveryMessage']
            failure(page, 'set_system_startup_enabled', {'id': disabled['id'], 'enabled': True,
                                                       'expectedFingerprint': disabled['fingerprint']})
            assert fixtures.raw('expand') is None
            assert fixtures.journal.read_bytes() == corrupt
    finally:
        fixtures.journal.write_bytes(original_store)
    assert fixtures.find(scan(page), 'expand')['managed']
    link_item = fixtures.find(scan(page), link.name)
    disabled_link = fixtures.find(set_enabled(page, fixtures, link_item, False), link.name)
    fixtures.restart = {'expand': fixtures.original_raw['expand'], 'link': link.name,
                        'linkBytes': Path(disabled_link['sourcePath']).read_bytes()}
    print('PASS: corrupt/foreign-owner journal is read-only; durable disabled fixtures prepared for a fresh process', flush=True)


def second_run(page, context, process, fixtures):
    native.wait_until(lambda: page.evaluate('window.__DTKIT_TOOL_PAGE__?.ready === true'))
    snapshot = scan(page)
    item = fixtures.find(snapshot, 'expand')
    assert not item['enabled'] and item['managed'] and fixtures.raw('expand') is None
    snapshot = set_enabled(page, fixtures, item, True)
    assert fixtures.raw('expand') == fixtures.restart['expand']
    item = fixtures.find(snapshot, fixtures.restart['link'])
    assert not item['enabled'] and item['managed']
    set_enabled(page, fixtures, item, True)
    assert (fixtures.startup / fixtures.restart['link']).read_bytes() == fixtures.restart['linkBytes']
    store = json.loads(fixtures.journal.read_text(encoding='utf-8'))
    assert not any(item.get('id') in fixtures.records for item in store.get('registryItems', []) + store.get('folderItems', []))
    assert fixtures.raw('once') == fixtures.original_raw['once']
    print('PASS: new native process restores exact REG_EXPAND_SZ and shortcut bytes; unrelated fixtures remain untouched', flush=True)


def legacy_run(page, context, process, fixtures):
    native.wait_until(lambda: page.evaluate('window.__DTKIT_TOOL_PAGE__?.ready === true'))
    legacy = fixtures.kits / 'SystemAssistant' / 'startup-disabled.json'
    if legacy.exists():
        print('SKIP: legacy create/adopt fixture would replace an existing isolated legacy journal', flush=True)
        return
    original = fixtures.journal.read_bytes()
    original_regular = fixtures.raw('regular')
    backup = fixtures.journal.with_name('smoke-' + fixtures.token + '.original')
    with backup.open('xb') as stream:
        stream.write(original)
    legacy_owned = False
    try:
        disabled = fixtures.find(set_enabled(page, fixtures, fixtures.find(scan(page), 'regular'), False), 'regular')
        current = json.loads(fixtures.journal.read_text(encoding='utf-8'))
        record = next(item for item in current['registryItems'] if item['id'] == disabled['id'])
        old_bytes = json.dumps({'version': 1, 'registryItems': [record], 'folderItems': []},
                               ensure_ascii=False).encode('utf-8')
        with legacy.open('xb') as stream:
            legacy_owned = True
            stream.write(old_bytes)
        fixtures.journal.unlink()
        pending = scan(page)
        assert pending['recoveryState'] == 'legacy' and pending['recoveryFingerprint']
        assert all(not item['canToggle'] for item in pending['items'])
        failure(page, 'create_system_startup_recovery', {'expectedStoreFingerprint': 'stale-' + fixtures.token})
        assert not fixtures.journal.exists() and legacy.read_bytes() == old_bytes
        ready = invoke(page, 'create_system_startup_recovery', {
            'expectedStoreFingerprint': pending['recoveryFingerprint']})
        assert ready['recoveryState'] == 'ready'
        fresh_bytes = fixtures.journal.read_bytes()
        fresh = json.loads(fresh_bytes)
        assert fresh['version'] == 2 and fresh['ownerHash'] == fixtures.journal.parent.name
        assert fresh['registryItems'] == [] and fresh['folderItems'] == []
        assert legacy.read_bytes() == old_bytes and fixtures.raw('regular') is None
        failure(page, 'create_system_startup_recovery', {
            'expectedStoreFingerprint': pending['recoveryFingerprint']})
        failure(page, 'adopt_system_startup_backups', {
            'expectedStoreFingerprint': pending['recoveryFingerprint']})
        assert fixtures.journal.read_bytes() == fresh_bytes and legacy.read_bytes() == old_bytes

        # The explicit adoption path also checks the exact legacy fingerprint;
        # it must restore only our own disabled registry fixture.
        fixtures.journal.unlink()
        pending = scan(page)
        failure(page, 'adopt_system_startup_backups', {'expectedStoreFingerprint': 'stale-' + fixtures.token})
        assert not fixtures.journal.exists() and legacy.read_bytes() == old_bytes
        adopted = invoke(page, 'adopt_system_startup_backups', {
            'expectedStoreFingerprint': pending['recoveryFingerprint']})
        assert adopted['recoveryState'] == 'ready'
        item = fixtures.find(adopted, 'regular')
        assert item['managed'] and not item['enabled']
        set_enabled(page, fixtures, item, True)
        assert fixtures.raw('regular') == original_regular
        assert legacy.read_bytes() == old_bytes
        print('PASS: legacy stays byte-identical through guarded fresh-namespace creation and explicit adoption', flush=True)
    finally:
        if legacy_owned:
            legacy.unlink(missing_ok=True)
        backup.replace(fixtures.journal)
        fixtures.write('regular', original_regular)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert os.name == 'nt' and executable.is_file(), executable
    fixtures = Fixtures()
    try:
        with sync_playwright() as playwright:
            native.run_case(playwright, executable, ['--tool', 'startup-manager'],
                            lambda *args: first_run(*args, fixtures))
            native.run_case(playwright, executable, ['--tool', 'startup-manager'],
                            lambda *args: second_run(*args, fixtures))
            native.run_case(playwright, executable, ['--tool', 'startup-manager'],
                            lambda *args: legacy_run(*args, fixtures))
    finally:
        fixtures.cleanup()
