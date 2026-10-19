"""Exercise developer tools against the isolated Windows Tauri test build.

Build using tests/native-webview.config.json first. The shared native harness
rejects the production data directory and stops only the process it launches.
"""

import argparse
import hashlib
import importlib.util
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location('native_webview', Path(__file__).with_name('native-webview-ui-smoke.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512']


def digest_map(data, uppercase=False):
    result = {algorithm: hashlib.new(algorithm, data).hexdigest() for algorithm in ALGORITHMS}
    return {algorithm: value.upper() for algorithm, value in result.items()} if uppercase else result


def check_hash(page, context, process):
    expect(page.locator('#hashTextInput')).to_be_visible()
    for text in ['', ' \n\t', '\ufeff中文 / Emoji 🙂\x00UTF-8']:
        for uppercase in [False, True]:
            result = page.evaluate('''async ({text, algorithms, uppercase}) =>
                window.__TAURI__.core.invoke('calculate_text_hash', {text, algorithms, uppercase})''',
                {'text': text, 'algorithms': ALGORITHMS, 'uppercase': uppercase})
            assert result == digest_map(text.encode('utf-8'), uppercase), (text, uppercase, result)

    # Exercise the UI's native command path as well as the command contract.
    for text in ['', '真实原生校验 🙂']:
        page.locator('#hashTextInput').fill(text)
        page.locator('#hashCalculateBtn').click()
        expect(page.locator('#hashResultsList')).to_contain_text(hashlib.md5(text.encode('utf-8')).hexdigest().upper())

    with tempfile.TemporaryDirectory(prefix='dtkit-hash-native-') as directory:
        for name, content in [('empty.bin', b''), ('binary.bin', bytes(range(256)) * 12289)]:
            source = Path(directory) / name
            source.write_bytes(content)
            result = page.evaluate('''async ({filePath, algorithms}) => {
                const taskId = crypto.randomUUID();
                const events = [];
                const unlisten = await window.__TAURI__.event.listen('hash-progress', event => {
                    if (event.payload.taskId === taskId) events.push(event.payload);
                });
                try {
                    const hashes = await window.__TAURI__.core.invoke('calculate_file_hash', {
                        filePath, algorithms, uppercase: false, taskId
                    });
                    await new Promise(resolve => setTimeout(resolve, 100));
                    return {hashes, events};
                } finally { unlisten(); }
            }''', {'filePath': str(source), 'algorithms': ALGORITHMS})
            assert result['hashes'] == digest_map(content)
            if content:
                assert result['events'], 'The native file task emitted no observable progress'
            for event in result['events']:
                assert 0 <= event['progress'] <= 100
                assert event['totalBytes'] == len(content)
                assert 0 <= event['bytesProcessed'] <= len(content)
    page.locator('#quickClose').click()
    native.wait_until(lambda: process.poll() is not None)
    assert process.returncode == 0


def check_qr(page, context, process):
    expect(page.locator('#qrCodePreview[data-state="ready"]')).to_be_visible(timeout=15000)
    page.locator('#qrDataInput').fill('原生 PNG / SVG 导出 🙂')
    expect(page.locator('#qrCodePreview[data-state="ready"]')).to_be_visible()
    with tempfile.TemporaryDirectory(prefix='dtkit-qr-native-') as directory:
        # Replace only the folder chooser. Generation, the Tauri bridge and the
        # Rust file writer remain real; no native dialog needs human input.
        page.evaluate('''directory => {
            Object.defineProperty(window.__TAURI__, 'dialog', {configurable: true, value: {
                open: async options => {
                    if (!options.directory || options.multiple) throw new Error('Unexpected directory options');
                    return directory;
                }
            }});
        }''', directory)
        page.locator('#qrChooseDirectory').click()
        expect(page.locator('#qrSaveDirectory')).to_have_text(directory)
        logo = Path(directory) / 'logo.png'
        Image.new('RGB', (512, 128), '#0071e3').save(logo)
        page.locator('#qrLogo').set_input_files(logo)
        expect(page.locator('#qrLogoState')).to_have_text('已添加')
        expect(page.locator('[data-qr-download="png"]')).to_be_enabled(timeout=15000)
        for format in ['png', 'svg']:
            page.locator(f'[data-qr-download="{format}"]').click()
            native.wait_until(lambda: len(list(Path(directory).glob(f'qrcode-*.{format}'))) == 1)
            destination = next(Path(directory).glob(f'qrcode-*.{format}'))
            expect(page.locator('#qrStatus')).to_contain_text(str(destination))
            expect(page.locator('#qrStatus')).to_have_attribute('data-type', 'success')
            if format == 'png':
                assert destination.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n'
                with Image.open(destination) as output:
                    assert output.format == 'PNG' and output.size == (320, 320)
                    output.verify()
            else:
                document = ET.parse(destination).getroot()
                assert document.tag == '{http://www.w3.org/2000/svg}svg'
                assert document.attrib['width'] == '320' and document.attrib['height'] == '320'
                images = document.findall('.//{http://www.w3.org/2000/svg}image')
                assert len(images) == 1
                embedded = images[0].attrib.get('href') or images[0].attrib.get('{http://www.w3.org/1999/xlink}href')
                assert embedded.startswith('data:image/png;base64,')
        # The writer uses create_new; the UI must generate a fresh name each time.
        page.locator('[data-qr-download="png"]').click()
        native.wait_until(lambda: len(list(Path(directory).glob('qrcode-*.png'))) == 2)
        expect(page.locator('[data-qr-download="png"]')).to_be_enabled()
    page.locator('#quickClose').click()
    native.wait_until(lambda: process.poll() is not None)
    assert process.returncode == 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', required=True, type=Path)
    parser.add_argument('--tool', choices=['hash-tool', 'qr-generator', 'all'], default='all')
    args = parser.parse_args()
    executable = args.exe.resolve()
    with sync_playwright() as playwright:
        if args.tool in ['hash-tool', 'all']:
            native.run_case(playwright, executable, ['--tool', 'hash-tool'], check_hash)
        if args.tool in ['qr-generator', 'all']:
            native.run_case(playwright, executable, ['--tool', 'qr-generator'], check_qr)
    print('Developer tools native smoke passed')
