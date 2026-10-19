"""Exercise real software-analysis IPC using only temporary scan fixtures.

Requires the isolated tests/native-webview.config.json build. No software is
installed, removed, started, or changed by this test.
"""

import argparse
import importlib.util
import json
import tempfile
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_smoke', ROOT / 'tests/native-webview-ui-smoke.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def scenario(page, context, process):
    expect(page.locator('.software-shell')).to_be_visible()
    native.wait_until(lambda: page.evaluate('Boolean(window.__DTKIT_TOOL_PAGE__?.ready)'))
    started = time.perf_counter()
    snapshot = page.evaluate('window.__TAURI__.core.invoke("list_installed_software", {refresh:true})')
    first_ms = round((time.perf_counter() - started) * 1000, 1)
    assert isinstance(snapshot['items'], list)
    assert len({item['id'] for item in snapshot['items']}) == len(snapshot['items'])
    assert all(item['scope'] in ['user', 'system'] for item in snapshot['items'])
    started = time.perf_counter()
    cached = page.evaluate('window.__TAURI__.core.invoke("list_installed_software", {refresh:false})')
    cached_ms = round((time.perf_counter() - started) * 1000, 1)
    assert cached['cached'] is True
    assert [item['id'] for item in cached['items']] == [item['id'] for item in snapshot['items']]

    with tempfile.TemporaryDirectory(prefix='dtkit-software-scan-') as temporary:
        fixture = Path(temporary)
        (fixture / 'cache' / 'nested').mkdir(parents=True)
        (fixture / 'program.bin').write_bytes(b'x' * 11)
        (fixture / 'cache' / 'data.bin').write_bytes(b'x' * 128)
        (fixture / 'cache' / 'nested' / 'log.bin').write_bytes(b'x' * 37)
        report = page.evaluate('''path => window.__TAURI__.core.invoke('analyze_software_space', {
            requestId:'native-fixture', softwareId:null, path
        })''', str(fixture))
        assert report['totalBytes'] == 176, report
        assert report['files'] == 3 and report['complete'] and not report['cancelled'], report
        assert len(report['largestDirectories']) == 1, report
        assert report['largestDirectories'][0]['bytes'] == 165, report
        assert report['largestFiles'][0]['bytes'] == 128, report
        assert page.evaluate("window.__TAURI__.core.invoke('cancel_software_analysis', {requestId:'native-fixture'})") is False

        # A wide tree exercises bounded result retention without reading contents.
        for index in range(300):
            (fixture / f'file-{index:04}.bin').write_bytes(b'x' * (index + 1))
        wide = page.evaluate('''path => window.__TAURI__.core.invoke('analyze_software_space', {
            requestId:'native-wide', softwareId:null, path
        })''', str(fixture))
        assert wide['totalBytes'] == 176 + sum(range(1, 301)), wide
        assert wide['files'] == 303 and wide['complete'], wide
        assert len(wide['largestFiles']) <= 20, wide

    rejected = page.evaluate('''async () => {
        try {
            await window.__TAURI__.core.invoke('analyze_software_space', {
                requestId:'native-root', softwareId:null, path:'C:\\\\'
            });
            return false;
        } catch { return true; }
    }''')
    assert rejected, 'A drive root must not become a software-directory scan'

    print(json.dumps({
        'registeredSoftware': len(snapshot['items']),
        'inventoryRefreshMs': first_ms, 'inventoryCachedMs': cached_ms,
        'fixtureFiles': wide['files'], 'fixtureScanMs': wide['elapsedMs'],
        'largestFilesRetained': len(wide['largestFiles'])
    }, ensure_ascii=False), flush=True)
    assert page.evaluate('window.__TAURI__.core.invoke("get_resource_snapshot").then(s => s.toolOnly && !s.mainWindowOpen)')
    page.locator('#quickClose').click()
    native.wait_until(lambda: process.poll() is not None)
    assert process.returncode == 0, process.returncode


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    arguments = parser.parse_args()
    with sync_playwright() as playwright:
        native.run_case(playwright, arguments.exe.resolve(), ['--tool', 'software-analysis'], scenario)
    print('Software analysis native IPC and standalone release passed', flush=True)
