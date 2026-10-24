"""Exercise real Windows sticky-note storage, windows and editor IPC.

Build the isolated identifier first, as described in native-webview-ui-smoke.py.
The shared harness refuses production storage and stops only its own child PID.
This test creates and deletes only notes with freshly generated test identifiers.
"""

import argparse
import ctypes
import importlib.util
import json
import tempfile
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location(
    'native_webview', Path(__file__).with_name('native-webview-ui-smoke.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def invoke(page, command, args=None):
    return page.evaluate('''({command,args}) => window.__TAURI__.core.invoke(command,args)''',
                         {'command': command, 'args': args or {}})


def rejected(page, command, args):
    return page.evaluate('''async ({command,args}) => {
        try { await window.__TAURI__.core.invoke(command,args); return false; }
        catch (error) { return Boolean(String(error)); }
    }''', {'command': command, 'args': args})


def owned_handle(process, title):
    from ctypes import wintypes
    user = ctypes.windll.user32
    matches = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def inspect(handle, _):
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        if pid.value == process.pid:
            value = ctypes.create_unicode_buffer(256)
            user.GetWindowTextW(handle, value, 256)
            if value.value == title:
                matches.append(handle)
        return True

    user.EnumWindows(callback_type(inspect), 0)
    assert len(matches) == 1, matches
    return matches[0]


def scenario(manager, context, process):
    def until(predicate):
        def pump():
            manager.wait_for_timeout(30)
            return predicate()
        native.wait_until(pump)

    until(lambda: manager.evaluate('window.__DTKIT_TOOL_PAGE__?.ready === true'))
    baseline = {note['id'] for note in invoke(manager, 'list_sticky_notes')}
    token = uuid4().hex[:12]
    created_ids = []

    legacy = invoke(manager, 'create_sticky_note')
    created_ids.append(legacy['id'])
    assert legacy['title'] == '' and legacy['content'] == ''
    assert legacy['color'] == 'yellow' and legacy['pinned'] is True

    first = invoke(manager, 'create_sticky_note', {'seed': {
        'title': f'Native {token}', 'content': '- [ ] 自动保存\n第二行 📝',
        'color': 'purple', 'pinned': False,
    }})
    created_ids.append(first['id'])
    assert first['revision'] == 1 and first['opened'] is False
    assert first['color'] == 'purple' and first['pinned'] is False
    assert first['content'].endswith('第二行 📝')

    before_import = {note['id'] for note in invoke(manager, 'list_sticky_notes')}
    assert rejected(manager, 'import_sticky_notes', {'notes': [
        {'title': 'should not partially import'}, {'color': 'invalid'},
    ]})
    assert {note['id'] for note in invoke(manager, 'list_sticky_notes')} == before_import
    imported = invoke(manager, 'import_sticky_notes', {'notes': [
        {'id': first['id'], 'title': f'Imported {token}', 'content': 'preserved copy',
         'color': 'green', 'pinned': True, 'revision': 999, 'createdAt': 1},
        {'title': f'Trash {token}', 'trashedAt': 123},
    ]})
    created_ids.extend(note['id'] for note in imported)
    assert len(imported) == 2 and len({note['id'] for note in imported}) == 2
    assert all(note['id'] not in before_import and note['revision'] == 1 for note in imported)
    assert imported[0]['createdAt'] > 1 and imported[0]['content'] == 'preserved copy'
    assert imported[1]['trashedAt'] is not None
    assert invoke(manager, 'get_sticky_note', {'id': first['id']})['content'] == first['content']

    invoke(manager, 'open_sticky_note', {'id': first['id']})
    until(lambda: any('sticky-note.html' in page.url for page in context.pages))
    editor = next(page for page in context.pages if 'sticky-note.html' in page.url)
    expect(editor.locator('#noteContent')).to_be_editable()
    expect(editor.locator('#noteContent')).to_have_value(first['content'])
    full_size = editor.evaluate('[innerWidth,innerHeight]')
    assert full_size[0] >= 250 and full_size[1] >= 240

    title = f'Edited {token}'
    editor.locator('#noteTitle').fill(title)
    editor.locator('#noteContent').fill('')
    editor.locator('#noteContent').press_sequentially('NATIVE autosave 12345', delay=10)
    expect(editor.locator('#noteSaveStatus')).to_have_attribute('data-state', 'saved')
    saved = invoke(manager, 'get_sticky_note', {'id': first['id']})
    assert saved['title'] == title and saved['content'] == 'NATIVE autosave 12345'
    assert saved['revision'] > 1

    assert rejected(editor, 'get_sticky_note', {'id': legacy['id']})
    assert rejected(editor, 'create_sticky_note', {})
    assert rejected(editor, 'import_sticky_notes', {'notes': [{'title': 'forbidden'}]})
    assert rejected(editor, 'set_sticky_notes_visible', {'visible': False})
    assert rejected(editor, 'set_sticky_note_collapsed', {'id': legacy['id'], 'collapsed': True})
    assert rejected(manager, 'save_sticky_note', {'draft': {
        key: saved[key] for key in ['id', 'title', 'content', 'color', 'pinned', 'revision']
    }})
    assert rejected(manager, 'set_sticky_note_collapsed', {'id': first['id'], 'collapsed': True})

    handle = owned_handle(process, title)
    assert ctypes.windll.user32.IsWindowVisible(handle)
    assert invoke(manager, 'set_sticky_notes_visible', {'visible': False}) == 1
    assert not ctypes.windll.user32.IsWindowVisible(handle)
    assert invoke(manager, 'get_sticky_note', {'id': first['id']})['opened'] is True
    assert invoke(manager, 'set_sticky_notes_visible', {'visible': True}) == 1
    assert ctypes.windll.user32.IsWindowVisible(handle)

    frames = editor.evaluate('''async id => {
        const heights=[]; let recording=true;
        const sample=()=>{heights.push(innerHeight);if(recording)requestAnimationFrame(sample);};
        requestAnimationFrame(sample);
        const collapsed=await window.__TAURI__.core.invoke('set_sticky_note_collapsed',{id,collapsed:true});
        recording=false;
        return {collapsed,heights,size:[innerWidth,innerHeight]};
    }''', first['id'])
    assert frames['collapsed'] is True and 52 <= frames['size'][1] <= 56, frames
    assert frames['size'][0] == full_size[0], frames
    assert any(58 < height < full_size[1] - 2 for height in frames['heights']), frames
    assert invoke(editor, 'set_sticky_note_collapsed', {
        'id': first['id'], 'collapsed': False, 'animate': False,
    }) is False
    assert editor.evaluate('[innerWidth,innerHeight]') == full_size
    editor.locator('#noteCollapse').click()
    expect(editor.locator('#noteCollapse')).to_have_attribute('aria-expanded', 'false')
    until(lambda: editor.evaluate('innerHeight <= 56'))
    expect(editor.locator('#noteClose')).to_be_enabled()
    # Close while collapsed; reopening must restore the full previous dimensions.
    invoke(manager, 'close_sticky_note', {'id': first['id']})
    until(lambda: editor.is_closed())
    assert invoke(manager, 'get_sticky_note', {'id': first['id']})['opened'] is False
    invoke(manager, 'open_sticky_note', {'id': first['id']})
    until(lambda: any('sticky-note.html' in page.url for page in context.pages))
    editor = next(page for page in context.pages if 'sticky-note.html' in page.url)
    expect(editor.locator('#noteContent')).to_be_editable()
    assert editor.evaluate('[innerWidth,innerHeight]') == full_size
    editor.locator('#noteContent').fill('Native close barrier keeps the last edit 📝')
    # A manager close arriving during the native resize is queued by the editor.
    editor.locator('#noteCollapse').click()
    invoke(manager, 'close_sticky_note', {'id': first['id']})
    until(lambda: editor.is_closed())
    assert invoke(manager, 'get_sticky_note', {'id': first['id']})['content'] == 'Native close barrier keeps the last edit 📝'

    # Exercise template creation through the real manager form and IPC bridge.
    manager.locator('#notesCreate').click()
    expect(manager.locator('#notesComposer')).to_be_visible()
    manager.locator('#notesComposeTitle').fill('')
    manager.locator('#notesComposeContent').fill('')
    manager.locator('[data-template="todo"]').click()
    expect(manager.locator('[data-template="todo"]')).to_have_attribute('aria-pressed', 'true')
    expect(manager.locator('#notesComposeTitle')).to_have_value('今日待办')
    todo_content = manager.locator('#notesComposeContent').input_value()
    assert todo_content.startswith('- [ ] ') and todo_content.count('- [ ]') == 3
    composer_title = f'Composer todo {token}'
    manager.locator('#notesComposeTitle').fill(composer_title)
    manager.locator('#notesComposePin').check()
    manager.locator('#notesComposeOpen').check()
    manager.locator('#notesComposeSubmit').click()
    expect(manager.locator('#notesComposer')).to_be_hidden()
    until(lambda: any('sticky-note.html' in page.url for page in context.pages))
    composed = next(note for note in invoke(manager, 'list_sticky_notes')
                    if note['title'] == composer_title)
    created_ids.append(composed['id'])
    assert composed['content'] == todo_content and composed['color'] == 'green'
    assert composed['pinned'] is True and composed['opened'] is True
    editor = next(page for page in context.pages if 'sticky-note.html' in page.url)
    expect(editor.locator('#noteContent')).to_have_value(todo_content)
    expect(editor.locator('#noteTitle')).to_have_value(composer_title)
    editor.locator('#noteClose').click()
    until(lambda: editor.is_closed())

    # Verify actual downloaded bytes in WebView2's configured download directory.
    # Its synthetic Playwright save_as artifact can be empty despite a valid file.
    manager.locator('#notesRefresh').click()
    stored = invoke(manager, 'list_sticky_notes')
    expect(manager.locator('#notesActiveCount')).to_have_text(str(sum(
        note['trashedAt'] is None for note in stored)))
    expect(manager.locator('#notesOpenedCount')).to_have_text('0')
    invoke(manager, 'open_sticky_note', {'id': first['id']})
    until(lambda: any('sticky-note.html' in page.url for page in context.pages))
    editor = next(page for page in context.pages if 'sticky-note.html' in page.url)
    expect(editor.locator('#noteContent')).to_be_editable()
    # Click Export synchronously on the native save notification. The manager's
    # 140ms UI refresh has not run, so this also guards stale cached backups.
    manager.evaluate('''async id => {
        window.__backupFreshnessUnlisten = await window.__TAURI__.event.listen(
            'sticky-notes-changed', event => {
                if (event.payload.id !== id) return;
                window.__backupFreshnessUnlisten();
                window.__backupFreshnessUnlisten = null;
                document.getElementById('notesExport').click();
            });
    }''', first['id'])
    fresh = invoke(manager, 'get_sticky_note', {'id': first['id']})
    fresh_draft = {key: fresh[key] for key in ['id', 'title', 'content', 'color', 'pinned', 'revision']}
    fresh_draft['content'] = f'Freshly persisted backup {token} 📝'
    with tempfile.TemporaryDirectory(prefix='dtkit-sticky-backup-') as directory:
        session = context.browser.new_browser_cdp_session()
        session.send('Browser.setDownloadBehavior', {
            'behavior': 'allow', 'downloadPath': directory, 'eventsEnabled': True,
        })
        try:
            with manager.expect_download(timeout=20000) as download_created:
                invoke(editor, 'save_sticky_note', {'draft': fresh_draft})
            download = download_created.value
            assert download.failure() is None, download.failure()

            def completed_backups():
                return [path for path in Path(directory).glob('*.json')
                        if path.is_file() and path.stat().st_size > 20]

            until(lambda: len(completed_backups()) == 1)
            destination = completed_backups()[0]
            assert destination.resolve().is_relative_to(Path(directory).resolve())
            backup = json.loads(destination.read_text(encoding='utf-8'))
            assert backup['format'] == 'dtkit-sticky-notes' and backup['version'] == 1
            assert isinstance(backup['exportedAt'], str) and backup['exportedAt'].endswith('Z')
            stored = invoke(manager, 'list_sticky_notes')
            fields = ['title', 'content', 'color', 'pinned', 'createdAt', 'updatedAt', 'trashedAt']
            expected_backup = [dict((key, note[key]) for key in fields) for note in stored]
            canonical = lambda notes: sorted(json.dumps(note, sort_keys=True) for note in notes)
            assert canonical(backup['notes']) == canonical(expected_backup)
            assert len(backup['notes']) == len(baseline) + len(created_ids)
            assert any(note['content'] == fresh_draft['content'] for note in backup['notes'])
        finally:
            session.detach()
    invoke(manager, 'close_sticky_note', {'id': first['id']})
    until(lambda: editor.is_closed())

    for note_id in created_ids:
        note = invoke(manager, 'get_sticky_note', {'id': note_id})
        if note['trashedAt'] is None:
            invoke(manager, 'trash_sticky_note', {'id': note_id})
        invoke(manager, 'delete_sticky_note', {'id': note_id})
    assert {note['id'] for note in invoke(manager, 'list_sticky_notes')} == baseline
    print('Native sticky notes: seeded create, atomic import, editor typing/autosave, isolation, '
          'hide/show, animated collapse, expanded geometry restore, queued close, '
          'template composer and downloaded JSON backup bytes passed', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert executable.is_file(), executable
    with sync_playwright() as playwright:
        native.run_case(playwright, executable, ['--tool', 'sticky-notes'], scenario)
