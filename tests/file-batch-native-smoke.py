"""Exercise actual Windows file-batch UI and native file operations.

Build using tests/native-webview.config.json first. The shared harness refuses
production storage and stops only its own child process. Every selected file,
destination and permanent-delete target is created inside this test's temporary
fixture. Selection is injected through the tool's public snapshot/restore API;
the Tauri bridge, preflight, execution, events and restore commands stay real.
"""

import argparse
import ctypes
import importlib.util
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location(
    'native_webview', Path(__file__).with_name('native-webview-ui-smoke.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
TERMINAL = {'completed', 'cancelled', 'failed'}


def invoke(page, command, args=None):
    return page.evaluate('({command,args})=>window.__TAURI__.core.invoke(command,args)',
                         {'command': command, 'args': args or {}})


def snapshot(page):
    return page.evaluate('()=>window.__DTKIT_TOOL_PAGE__.snapshot()')


def selected_path(value):
    # Rust's canonical Windows paths use the extended-length prefix.
    return Path(str(value).removeprefix('\\\\?\\')).resolve()


def scenario(page, context, process):
    def until(predicate):
        def pump():
            page.wait_for_timeout(30)
            return predicate()
        native.wait_until(pump)

    until(lambda: page.evaluate('window.__DTKIT_TOOL_PAGE__?.ready===true'))
    expect(page.locator('#batchPreview')).to_be_visible()
    recoveries = {}

    with tempfile.TemporaryDirectory(prefix='dtkit-file-batch-native-') as directory:
        fixture = Path(directory).resolve()
        original = fixture / '原始文件'
        copied = fixture / '复制结果'
        moved = fixture / '移动结果'
        conflicts = fixture / '冲突测试'
        for folder in [original, copied, moved, conflicts]:
            folder.mkdir()

        def owned(path):
            result = selected_path(path)
            assert result.is_relative_to(fixture), f'Refusing a non-fixture path: {path}'
            return result

        def set_files(paths, destination=''):
            for path in paths:
                owned(path)
            if destination:
                owned(destination)
            page.evaluate('''async ({files,destination})=>{
                const saved=window.__DTKIT_TOOL_PAGE__.snapshot();
                Object.assign(saved.state,{files,destination,recordId:null,
                    appliedJobId:null,resultRecord:null,query:'',sort:'manual',onlyConflicts:false});
                await window.__DTKIT_TOOL_PAGE__.restore(saved);
            }''', {'files': [str(path) for path in paths], 'destination': str(destination)})
            expect(page.locator('#batchSelectionSummary')).to_have_text(f'已选择 {len(paths)} 个文件')

        def operation(value):
            page.locator(f'input[name="batchOperation"][value="{value}"]').locator('..').click()

        def current_record():
            state = snapshot(page)['state']
            return next((record for record in state.get('history', [])
                         if record['id'] == state.get('recordId')), None)

        def remember_recovery(record):
            batch_id = (record.get('result') or {}).get('recoveryBatchId')
            if batch_id:
                sources = [owned(item['source']) for item in record['preview']['items']]
                recoveries[batch_id] = sources

        def finish_task(expected_count):
            until(lambda: (current_record() or {}).get('status') in TERMINAL)
            record = current_record()
            remember_recovery(record)
            assert record['status'] == 'completed', record
            assert record['result']['processed'] == expected_count, record
            assert len(record['preview']['items']) == expected_count, record
            cached = invoke(page, 'get_file_batch_status', {'jobId': record['jobId']})
            assert cached['status'] == 'completed' and cached['jobId'] == record['jobId'], cached
            assert cached['clientId'] == record['id'], cached
            assert cached['result']['processed'] == expected_count, cached
            assert cached['result']['preview']['items'] == record['preview']['items'], cached
            assert cached['progress'] == 1
            by_client = invoke(page, 'get_file_batch_status', {'jobId': record['id']})
            assert by_client == cached
            expect(page.locator('#batchProgressValue')).to_have_text('100%')
            return record

        def run_task(expected_count, permanent=False):
            page.locator('#batchPreview').click()
            expect(page.locator('#batchExecute')).to_be_enabled()
            page.locator('#batchExecute').click()
            if permanent:
                expect(page.locator('#batchDangerDialog')).to_be_visible()
                page.locator('#batchConfirmPermanent').click()
            return finish_task(expected_count)

        try:
            first = original / '旧_Alpha.txt'
            second = original / '旧_Straße.TXT'
            filtered = original / '保留.png'
            first.write_bytes(b'first generated text\x00\xff')
            second.write_bytes('Unicode fixture 中文'.encode('utf-8'))
            filtered.write_bytes(b'not a selected extension')
            expected_contents = [first.read_bytes(), second.read_bytes()]
            set_files([filtered, first, second])
            page.locator('#batchNamePattern').fill('整理_{name}_{n}{dotext}')
            page.locator('#batchStartIndex').fill('3')
            page.locator('#batchNumberPadding').select_option('3')
            page.locator('.batch-advanced > summary').click()
            page.locator('#batchFind').fill('旧_')
            page.locator('#batchReplace').fill('新_')
            page.locator('#batchCaseMode').select_option('upper')
            page.locator('#batchNumberStep').fill('4')
            page.locator('#batchExtensions').fill('txt')
            renamed_record = run_task(2)
            renamed = [original / '整理_新_ALPHA_003.txt', original / '整理_新_STRASSE_007.TXT']
            assert [path.read_bytes() for path in renamed] == expected_contents
            assert not first.exists() and not second.exists()
            assert filtered.read_bytes() == b'not a selected extension'
            assert {path.name for path in original.iterdir()} == {path.name for path in renamed} | {filtered.name}

            # Replay the exact cold-reload window where start was submitted but
            # its actual jobId was not yet received. The native clientId cache
            # must reconnect to the one real task without submitting it twice.
            cold_state = snapshot(page)['state']
            cold_record = next(record for record in cold_state['history'] if record['id'] == renamed_record['id'])
            cold_record.update({'status': 'starting', 'jobId': None, 'result': None,
                                'progress': 0, 'launching': False})
            cold_state.update({'files': renamed_record['request']['sources'],
                               'appliedJobId': None, 'resultRecord': None})
            page.reload(wait_until='networkidle')
            until(lambda: page.evaluate('window.__DTKIT_TOOL_PAGE__?.ready===true'))
            page.evaluate('''async state=>{
                const saved=window.__DTKIT_TOOL_PAGE__.snapshot();saved.state=state;
                await window.__DTKIT_TOOL_PAGE__.restore(saved);
            }''', cold_state)
            finish_task(2)
            assert {owned(path) for path in snapshot(page)['state']['files']} == {filtered, *renamed}
            duplicate = page.evaluate('''async request=>{
                try{await window.__TAURI__.core.invoke('start_file_batch',{request});return null;}
                catch(error){return String(error);}
            }''', {**renamed_record['request'], 'clientId': renamed_record['id']})
            assert duplicate and '已经提交' in duplicate, duplicate
            assert [path.read_bytes() for path in renamed] == expected_contents

            set_files(renamed, copied)
            operation('copy')
            page.locator('#batchExtensions').fill('')
            run_task(2)
            copied_files = [copied / path.name for path in renamed]
            assert [path.read_bytes() for path in copied_files] == expected_contents
            assert [path.read_bytes() for path in renamed] == expected_contents

            set_files(copied_files, moved)
            operation('move')
            run_task(2)
            moved_files = [moved / path.name for path in renamed]
            assert not any(path.exists() for path in copied_files)
            assert [path.read_bytes() for path in moved_files] == expected_contents

            precious = conflicts / renamed[0].name
            precious.write_bytes(b'existing destination must survive')
            set_files([renamed[0]], conflicts)
            operation('copy')
            page.locator('#batchPreview').click()
            expect(page.locator('#batchStatus')).to_contain_text('冲突')
            expect(page.locator('#batchExecute')).to_be_disabled()
            assert precious.read_bytes() == b'existing destination must survive'
            assert renamed[0].read_bytes() == expected_contents[0]

            # Directory discovery stays read-only and only recurses when asked.
            imported = fixture / '导入分组{n}'
            nested = imported / '嵌套'
            nested.mkdir(parents=True)
            imported_source = imported / '  甲😀旧beta尾丙  .TxT'
            imported_source.write_bytes(b'generated folder rename fixture')
            nested_source = nested / 'keep.bin'
            nested_source.write_bytes(b'generated nested fixture')
            flat = invoke(page, 'collect_file_batch_sources', {'directory': str(imported)})
            assert {owned(path) for path in flat['sources']} == {imported_source}, flat
            assert flat['skipped'] == 1 and not flat['truncated'] and not flat['warnings'], flat
            recursive = invoke(page, 'collect_file_batch_sources',
                               {'directory': str(imported), 'recursive': True})
            assert {owned(path) for path in recursive['sources']} == {imported_source, nested_source}, recursive
            assert not recursive['truncated'], recursive
            assert imported_source.read_bytes() == b'generated folder rename fixture'
            set_files([owned(path) for path in flat['sources']])
            operation('rename')
            if not page.locator('.batch-advanced').evaluate('(element)=>element.open'):
                page.locator('.batch-advanced > summary').click()
            page.locator('#batchNamePattern').fill('{folder}_{name}_{n}{dotext}')
            page.locator('#batchStartIndex').fill('2')
            page.locator('#batchNumberPadding').select_option('2')
            page.locator('#batchNumberStep').fill('1')
            page.locator('#batchTrimWhitespace').check()
            page.locator('#batchRemoveStart').fill('2')
            page.locator('#batchRemoveEnd').fill('2')
            page.locator('#batchFind').fill('旧')
            page.locator('#batchReplace').fill('新')
            page.locator('#batchCaseMode').select_option('upper')
            page.locator('#batchExtensionCase').select_option('lower')
            imported_record = run_task(1)
            imported_target = imported / '导入分组{n}_新BETA_02.txt'
            assert owned(imported_record['preview']['items'][0]['target']) == imported_target
            assert imported_target.read_bytes() == b'generated folder rename fixture'
            assert not imported_source.exists()
            assert nested_source.read_bytes() == b'generated nested fixture'
            page.locator('#batchTrimWhitespace').uncheck()
            page.locator('#batchRemoveStart').fill('0')
            page.locator('#batchRemoveEnd').fill('0')
            page.locator('#batchFind').fill('')
            page.locator('#batchReplace').fill('')
            page.locator('#batchCaseMode').select_option('keep')
            page.locator('#batchExtensionCase').select_option('keep')

            # The authoritative execution preview must follow a source that
            # changed into a directory after the user's first preflight.
            changed = original / 'changed-after-preview.txt'
            stable = original / 'stable-after-preview.txt'
            changed.write_bytes(b'generated changing source')
            stable.write_bytes(b'generated stable source')
            set_files([changed, stable])
            operation('rename')
            page.locator('#batchNamePattern').fill('actual-{n}{dotext}')
            page.locator('#batchStartIndex').fill('1')
            page.locator('#batchNumberPadding').select_option('1')
            page.locator('#batchPreview').click()
            expect(page.locator('#batchExecute')).to_be_enabled()
            changed.unlink()
            changed.mkdir()
            page.locator('#batchExecute').click()
            actual = finish_task(1)
            assert owned(actual['preview']['items'][0]['source']) == stable
            assert (original / 'actual-1.txt').read_bytes() == b'generated stable source'
            assert changed.is_dir() and not stable.exists()
            assert {owned(path) for path in snapshot(page)['state']['files']} == {changed, original / 'actual-1.txt'}

            set_files(moved_files)
            operation('delete')
            expect(page.locator('#batchPermanent')).not_to_be_checked()
            deleted_record = run_task(2)
            recovery_id = deleted_record['result']['recoveryBatchId']
            assert recovery_id and not any(path.exists() for path in moved_files)
            moved_files[0].write_bytes(b'new generated conflicting file')
            page.locator('#batchRestore').click()
            expect(page.locator('#batchStatus')).to_contain_text('暂未恢复')
            assert moved_files[0].read_bytes() == b'new generated conflicting file'
            assert moved_files[1].read_bytes() == expected_contents[1]
            expect(page.locator('#batchRestore')).to_be_enabled()
            moved_files[0].unlink()
            page.locator('#batchRestore').click()
            expect(page.locator('#batchStatus')).to_contain_text('已恢复 1 个文件')
            expect(page.locator('#batchRestore')).to_be_hidden()
            assert [path.read_bytes() for path in moved_files] == expected_contents
            recoveries.pop(recovery_id)

            # Denying DELETE sharing on one generated source forces a real
            # mid-job failure after the preceding file entered recovery.
            partial_first = original / 'partial-first.txt'
            partial_second = original / 'partial-second.txt'
            partial_first.write_bytes(b'first partial deletion fixture')
            partial_second.write_bytes(b'second locked deletion fixture')
            set_files([partial_first, partial_second])
            page.locator('#batchPreview').click()
            expect(page.locator('#batchExecute')).to_be_enabled()
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                           wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
            kernel.CreateFileW.restype = wintypes.HANDLE
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.CreateFileW(str(partial_second), 0x80000000, 0x1 | 0x2,
                                        None, 3, 0x80, None)
            assert handle != ctypes.c_void_p(-1).value, ctypes.get_last_error()
            try:
                page.locator('#batchExecute').click()
                until(lambda: (current_record() or {}).get('status') in TERMINAL)
                partial = current_record()
                remember_recovery(partial)
                assert partial['status'] == 'failed', partial
                assert partial['result']['processed'] == 1, partial
                assert not partial_first.exists() and partial_second.is_file()
                assert {owned(path) for path in snapshot(page)['state']['files']} == {partial_second}
                failed_cache = invoke(page, 'get_file_batch_status', {'jobId': partial['id']})
                assert failed_cache['status'] == 'failed' and failed_cache['result']['processed'] == 1
                assert failed_cache['result']['recoveryBatchId'] == partial['result']['recoveryBatchId']
                expect(page.locator('#batchRestore')).to_be_enabled()
            finally:
                assert kernel.CloseHandle(handle), ctypes.get_last_error()
            page.locator('#batchRestore').click()
            expect(page.locator('#batchStatus')).to_contain_text('已恢复 1 个文件')
            expect(page.locator('#batchRestore')).to_be_hidden()
            assert partial_first.read_bytes() == b'first partial deletion fixture'
            assert partial_second.read_bytes() == b'second locked deletion fixture'
            recoveries.pop(partial['result']['recoveryBatchId'])

            disposable = fixture / 'only-generated-permanent-delete.bin'
            disposable.write_bytes(b'explicitly generated disposable bytes')
            set_files([disposable])
            page.locator('#batchPermanent').check()
            permanently_deleted = run_task(1, permanent=True)
            assert permanently_deleted['result'].get('recoveryBatchId') is None
            assert not disposable.exists()
            assert invoke(page, 'get_file_batch_status', {'jobId': '00000000-0000-0000-0000-000000000000'}) is None
            print('Native file batch: Unicode rename/numbering, directory import, Unicode trimming/removal, folder naming, extension case, cold clientId reconnect, duplicate rejection, copy/move, no overwrite, changed sources, recovery retry, mid-job failure recovery and confirmed permanent deletion passed', flush=True)
        finally:
            # Only recovery batches whose every source belongs to this fresh
            # fixture are eligible for cleanup. No unrelated batch is queried.
            if not page.is_closed():
                for record in snapshot(page)['state'].get('history', []):
                    if not record.get('restored'):
                        remember_recovery(record)
                for batch_id, sources in recoveries.items():
                    for source in sources:
                        target = owned(source)
                        if target.is_file():
                            target.unlink()
                    try:
                        result = invoke(page, 'restore_file_batch', {'batchId': batch_id})
                        assert result['skipped'] == 0, result
                    except Exception as error:
                        print(f'Generated recovery cleanup for {batch_id}: {error}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert executable.is_file(), executable
    with sync_playwright() as playwright:
        native.run_case(playwright, executable, ['--tool', 'file-batch'], scenario)
