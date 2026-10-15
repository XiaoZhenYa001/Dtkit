"""Actual encrypted vault, import/export, and pagination with an isolated Tauri identity.

Only fake fixture passwords are created. The user's clipboard is never changed.
The launcher terminates only the test process it created.
"""
import argparse
import importlib.util
import json
import tempfile
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-webview-ui-smoke.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def scenario(page, context, process):
    prefix = 'DtKit password test ' + uuid.uuid4().hex
    def call(command, **args):
        return page.evaluate('({command,args})=>window.__TAURI__.core.invoke(command,args)', {'command':command,'args':args})
    ids = set()
    with tempfile.TemporaryDirectory(prefix='dtkit-password-native-') as directory:
        directory = Path(directory)
        first = call('save_password_entry', entry={
            'service':prefix+' Mail','username':'demo','password':'fixture-only-password-01!',
            'note':'contains, commas\nand newlines','category':prefix,'url':'https://example.com',
            'favorite':True,'customFields':[{'label':'recovery','value':'fixture-only-recovery','sensitive':True}]})
        second = call('save_password_entry', entry={
            'service':prefix+' Other','username':'other','password':'fixture,second"quoted',
            'category':prefix})
        ids.update([first['id'],second['id']])
        try:
            result = call('list_passwords',query=prefix,limit=1,offset=0,sort='name')
            assert result['total']==2 and len(result['items'])==1 and result['truncated']
            assert 'password' not in result['items'][0]
            last = call('list_passwords',query=prefix,limit=1,offset=1,sort='name')
            assert not last['truncated'] and last['items'][0]['id']!=result['items'][0]['id']
            detail=call('get_password_detail',id=first['id'])
            assert 'password' not in detail and detail['customFields'][0]['value']==''

            json_path=directory/'roundtrip.json'
            try:
                call('export_password_entries',path=str(json_path),format='json',confirmed=False,query=prefix)
                raise AssertionError('Export accepted without plaintext confirmation')
            except Exception as error:
                assert '确认' in str(error)
            assert not json_path.exists()
            exported=call('export_password_entries',path=str(json_path),format='json',confirmed=True,query=prefix,view='all')
            assert exported['count']==2
            payload=json.loads(json_path.read_text(encoding='utf-8'))
            assert payload['app']=='REPassCard' and payload['version']==1 and payload['count']==2
            entry=next(entry for entry in payload['passwords'] if entry['service'].endswith(' Mail'))
            assert entry['url']=='https://example.com' and entry['customFields'][0]['sensitive']
            assert entry['password']=='fixture-only-password-01!'

            csv_path=directory/'roundtrip.csv'
            call('export_password_entries',path=str(csv_path),format='csv',confirmed=True,query=prefix,view='all')
            assert csv_path.read_bytes().startswith(b'\xef\xbb\xbf')
            preview=call('preview_password_import',path=str(csv_path))
            assert preview['ready']==2 and preview['duplicates']==2
            call('discard_password_import',token=preview['token'])

            call('remove_password_entry',id=first['id'],permanent=True)
            ids.remove(first['id'])
            preview=call('preview_password_import',path=str(json_path))
            assert preview['ready']==2 and preview['duplicates']==1
            committed=call('commit_password_import',token=preview['token'],strategy='skip',decisions=[])
            assert committed['imported']==1 and committed['skipped']==1
            restored=call('list_passwords',query=prefix,limit=10)
            ids.update(entry['id'] for entry in restored['items'])
            restored_id=next(entry['id'] for entry in restored['items'] if entry['service'].endswith(' Mail'))
            editor=call('get_password_entry_for_edit',id=restored_id)
            assert editor['password']=='fixture-only-password-01!'
            assert editor['customFields'][0]['value']=='fixture-only-recovery'
        finally:
            for identity in ids:
                call('remove_password_entry',id=identity,permanent=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--exe',type=Path,required=True)
    args=parser.parse_args()
    with sync_playwright() as p:
        native.run_case(p,args.exe.resolve(),[],scenario)
    print('PASS: native encrypted save/read, metadata-only list/detail, pagination, export confirmation, JSON/CSV roundtrip and duplicate import')
