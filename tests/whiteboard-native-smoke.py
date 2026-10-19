"""Exercise whiteboard persistence, edit leases and formula PNGs in real WebView2.

Build the isolated identity with tests/native-webview.config.json first. The
shared harness rejects production storage and owns every process it starts.
Cleanup removes only this run's UUID documents after its windows have closed.
"""

import argparse
import importlib.util
import json
import os
import re
import tempfile
import uuid
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright


spec = importlib.util.spec_from_file_location('native_webview', Path(__file__).with_name('native-webview-ui-smoke.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'


def invoke(page, command, args=None):
    return page.evaluate('''({command,args}) => window.__TAURI__.core.invoke(command,args)''',
                         {'command': command, 'args': args or {}})


def snapshot(page):
    return page.evaluate('window.__DTKIT_TOOL_PAGE__.snapshot().state')


def ready(page):
    expect(page.locator('#whiteboardCanvas')).to_be_visible(timeout=20000)
    page.wait_for_function('window.__DTKIT_TOOL_PAGE__?.ready === true')
    page.wait_for_function('document.getElementById("whiteboardCanvas").width > 200')


def expect_count(page, count):
    expect(page.locator('#whiteboardObjectCount')).to_have_text(re.compile(rf'^\s*{count}\s'))


def panel(page, name):
    trigger = page.locator(f'[data-board-panel="{name}"]')
    if trigger.get_attribute('aria-expanded') != 'true':
        trigger.click()
    expect(trigger).to_have_attribute('aria-expanded', 'true')
    expect(page.locator(f'[data-board-panel-content="{name}"]')).to_be_visible()


def mode(page, name):
    button = page.locator(f'[data-board-mode="{name}"]')
    if not button.is_visible():
        panel(page, 'shape' if name in {'line', 'arrow', 'rect', 'ellipse'} else 'content')
    button.click()
    expect(button).to_have_attribute('aria-pressed', 'true')


def draw(page, start=(0.18, 0.40), end=(0.36, 0.47)):
    mode(page, 'pen')
    bounds = page.locator('#whiteboardCanvas').bounding_box()
    assert bounds and bounds['width'] > 200 and bounds['height'] > 200, bounds
    page.mouse.move(bounds['x'] + bounds['width'] * start[0], bounds['y'] + bounds['height'] * start[1])
    page.mouse.down()
    page.mouse.move(bounds['x'] + bounds['width'] * end[0], bounds['y'] + bounds['height'] * end[1], steps=12)
    page.mouse.up()


def insert(page, kind, value, position=(0.55, 0.57)):
    mode(page, kind)
    bounds = page.locator('#whiteboardCanvas').bounding_box()
    page.mouse.click(bounds['x'] + bounds['width'] * position[0], bounds['y'] + bounds['height'] * position[1])
    expect(page.locator('#whiteboardObjectDialog')).to_be_visible()
    page.locator('#whiteboardObjectInput').fill(value)
    if kind == 'formula':
        expect(page.locator('#whiteboardFormulaPreview .katex')).to_be_visible()
    page.locator('#whiteboardDialogConfirm').click()
    expect(page.locator('#whiteboardObjectDialog')).to_be_hidden()


def flush(page):
    return page.evaluate('window.__DTKIT_TOOL_PAGE__.flush()')


def save(page, name):
    page.locator('#whiteboardName').fill(name)
    page.locator('#whiteboardSave').click()
    page.wait_for_function('''() => {
        const value=window.__DTKIT_TOOL_PAGE__.snapshot().state;
        return value.isFormal && !value.dirty;
    }''', timeout=20000)
    return snapshot(page)['boardId']


def checked_whiteboards(layout):
    root = Path(layout['root']).resolve()
    whiteboards = Path(layout['whiteboards']).resolve()
    assert native.IDENTIFIER in str(root), f'Refusing production data: {root}'
    assert whiteboards == root / 'Kits' / 'Whiteboards', whiteboards
    assert whiteboards.is_relative_to(root), whiteboards
    return whiteboards


def read_document(root, board_id):
    assert str(uuid.UUID(board_id)) == board_id.lower(), board_id
    path = root / 'Boards' / board_id / 'board.json'
    assert path.resolve().is_relative_to(root), path
    return json.loads(path.read_text(encoding='utf-8'))


def cleanup_created_boards(root, identifiers, prefix):
    """Delete known UUID leaves; never recursively remove a storage directory."""
    assert native.IDENTIFIER in str(root.resolve()), root
    index = root / 'index.json'
    items = json.loads(index.read_text(encoding='utf-8')) if index.exists() else []
    # A forced takeover can create a recovery UUID before its UI promise settles.
    # Its unique run prefix proves ownership even if the test failed at that point.
    identifiers.update(item['id'] for item in items if str(item.get('name', '')).startswith(prefix))
    for identifier in identifiers:
        assert str(uuid.UUID(identifier)) == identifier.lower(), identifier
        board = (root / 'Boards' / identifier).resolve()
        assert board.parent == (root / 'Boards').resolve() and board.is_relative_to(root), board
        for filename in ('board.json', 'thumbnail.png'):
            path = board / filename
            assert path.resolve().parent == board, path
            path.unlink(missing_ok=True)
        if board.exists():
            assert not list(board.iterdir()), f'Unexpected files in this test board: {board}'
            board.rmdir()
        draft = root / 'Drafts' / f'{identifier}.json'
        assert draft.resolve().parent == (root / 'Drafts').resolve(), draft
        draft.unlink(missing_ok=True)
    if index.exists():
        remaining = [item for item in items if item['id'] not in identifiers]
        temporary = root / f'.index-whiteboard-smoke-{uuid.uuid4()}.tmp'
        temporary.write_text(json.dumps(remaining, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temporary, index)


def close_test_windows(pages, process):
    for page in reversed(pages):
        if page.is_closed():
            continue
        try:
            flush(page)
            page.locator('#quickClose').click(timeout=5000)
        except Exception:
            # The shared harness still stops only its own child process.
            pass
    try:
        native.wait_until(lambda: process.poll() is not None, seconds=10)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


def check_whiteboard(first, context, process):
    ready(first)
    layout = invoke(first, 'get_storage_layout')
    root = checked_whiteboards(layout)
    prefix = f'白板原生回归 {uuid.uuid4().hex[:10]}'
    created = {snapshot(first)['boardId']}
    pages = [first]
    try:
        # Draft-only boards must be discoverable after leaving the canvas even
        # before their first formal save (their UUID is absent from index.json).
        draft_only_id = snapshot(first)['boardId']
        draft_only_name = prefix + ' · 未正式保存草稿'
        draw(first)
        first.locator('#whiteboardName').fill(draft_only_name)
        flush(first)
        records = invoke(first, 'list_whiteboards')
        orphan = next(item for item in records if item['id'] == draft_only_id)
        assert orphan['hasDraft'] is True and orphan['name'] == draft_only_name, orphan
        assert not (root / 'Boards' / draft_only_id / 'board.json').exists()
        first.locator('#whiteboardHistoryRail').click()
        first.locator('#whiteboardNew').click()
        expect_count(first, 0)
        created.add(snapshot(first)['boardId'])
        first.locator('#whiteboardHistoryRail').click()
        first.locator(f'[data-board-id="{draft_only_id}"]').click()
        expect_count(first, 1)
        expect(first.locator('#whiteboardName')).to_have_value(draft_only_name)
        assert snapshot(first)['isFormal'] is False
        first.locator('#whiteboardHistoryRail').click()
        first.locator('#whiteboardNew').click()
        expect_count(first, 0)
        created.add(snapshot(first)['boardId'])

        draw(first)
        insert(first, 'text', '真实 WebView2 中文与 Emoji 🙂\n第二行', (0.40, 0.60))
        insert(first, 'formula', r'\frac{1}{2}+\sqrt{x^2+y^2}', (0.65, 0.38))
        expect_count(first, 3)
        expect(first.locator('#whiteboardFormulaLayer .katex')).to_be_visible()
        board_id = save(first, prefix)
        created.add(board_id)
        document = read_document(root, board_id)
        assert document['version'] == 2 and document['infinite'] is True
        assert [element['type'] for element in document['elements']] == ['stroke', 'text', 'formula']
        assert snapshot(first)['document'] is None, 'Native workspaces must not duplicate full documents in localStorage'
        thumbnail = root / 'Boards' / board_id / 'thumbnail.png'
        with Image.open(thumbnail) as image:
            assert image.format == 'PNG' and image.size == (320, 200)
            image.verify()

        # The actual Rust writer rejects a bad thumbnail before touching either file.
        before_document = (root / 'Boards' / board_id / 'board.json').read_bytes()
        before_thumbnail = thumbnail.read_bytes()
        error = first.evaluate('''async ({id,name,document}) => {
            try {await window.__TAURI__.core.invoke('save_whiteboard',{request:{id,name,document,thumbnailDataUrl:'data:image/png;base64,%%%'}});return null;}
            catch(error){return String(error);}
        }''', {'id': board_id, 'name': prefix, 'document': {**document, 'elements': []}})
        assert error and '缩略图' in error, error
        assert (root / 'Boards' / board_id / 'board.json').read_bytes() == before_document
        assert thumbnail.read_bytes() == before_thumbnail

        first.locator('#whiteboardName').fill(prefix + ' · 草稿改名')
        draw(first, (0.20, 0.72), (0.34, 0.77))
        expect_count(first, 4)
        stale_workspace = flush(first)
        assert stale_workspace['state']['document'] is None
        draft_path = root / 'Drafts' / f'{board_id}.json'
        draft = json.loads(draft_path.read_text(encoding='utf-8'))
        assert draft['name'] == prefix + ' · 草稿改名' and len(draft['document']['elements']) == 4
        assert len(read_document(root, board_id)['elements']) == 3

        # Replacing native data after the workspace snapshot must win on restore.
        latest = json.loads(json.dumps(draft['document']))
        latest['elements'].append({'id': str(uuid.uuid4()), 'type': 'note', 'color': '#242937', 'x': -80, 'y': -100, 'width': 220, 'height': 150, 'text': '快照后的原生最新内容'})
        latest_name = prefix + ' · 原生最新草稿'
        invoke(first, 'save_whiteboard_draft', {'request': {'id': board_id, 'name': latest_name, 'document': latest}})
        first.evaluate('snapshot => window.__DTKIT_TOOL_PAGE__.restore(snapshot)', stale_workspace)
        expect_count(first, 5)
        expect(first.locator('#whiteboardName')).to_have_value(latest_name)
        assert snapshot(first)['document'] is None

        with context.expect_page() as second_created:
            invoke(first, 'open_quick_host', {'target': {'kind': 'tool', 'toolId': 'whiteboard'}})
        second = second_created.value
        pages.append(second)
        ready(second)
        created.add(snapshot(second)['boardId'])
        first_instance = first.evaluate('window.__DTKIT_TOOL_PAGE_CONTEXT.instanceId')
        second_instance = second.evaluate('window.__DTKIT_TOOL_PAGE_CONTEXT.instanceId')
        assert first_instance != second_instance
        second.locator('#whiteboardHistoryRail').click()
        second.locator(f'[data-board-id="{board_id}"]').click()
        expect(second.locator('#whiteboardReadOnly')).to_be_visible()
        expect_count(second, 5)
        expect(second.locator('#whiteboardName')).to_have_value(latest_name)
        expect(second.locator('[data-board-mode="pen"]')).to_be_disabled()
        second.locator('#whiteboardCanvas').focus()
        second.keyboard.press('Control+z')
        expect_count(second, 5)

        # The waiting reader is deliberately stale when it takes the native lease.
        draw(first, (0.38, 0.73), (0.49, 0.78))
        expect_count(first, 6)
        flush(first)
        draw(first, (0.53, 0.74), (0.64, 0.79))
        expect_count(first, 7)
        second.locator('#whiteboardTakeOver').click()
        expect(second.locator('#whiteboardReadOnly')).to_be_hidden()
        expect_count(second, 6)
        expect(first.locator('#whiteboardReadOnly')).to_be_visible()
        flush(first)
        records = invoke(second, 'list_whiteboards')
        recovery = [item for item in records if item['name'].startswith(prefix) and '接管前恢复' in item['name']]
        assert len(recovery) == 1, recovery
        created.add(recovery[0]['id'])
        assert len(read_document(root, recovery[0]['id'])['elements']) == 7
        assert len(json.loads(draft_path.read_text(encoding='utf-8'))['document']['elements']) == 6
        assert snapshot(first)['recovery'] is True

        # Export a formula-only page: no raw LaTeX canvas fallback can satisfy the
        # tall fraction/root layout, and WebView2 must supply real KaTeX fonts.
        second.locator('#whiteboardHistoryRail').click()
        second.locator('#whiteboardNew').click()
        expect_count(second, 0)
        created.add(snapshot(second)['boardId'])
        insert(second, 'formula', r'\frac{\sqrt{x^2+y^2}}{1+\sum_{n=1}^{10} n}', (0.50, 0.50))
        expect_count(second, 1)
        export_id = save(second, prefix + ' · 公式导出')
        created.add(export_id)
        with tempfile.TemporaryDirectory(prefix='dtkit-whiteboard-png-') as directory:
            session = context.browser.new_browser_cdp_session()
            session.send('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': directory, 'eventsEnabled': True})
            with second.expect_download(timeout=20000) as download_created:
                panel(second, 'file')
                second.locator('#whiteboardExport').click()
            download = download_created.value
            assert download.failure() is None, download.failure()
            # WebView2 writes the real download into the CDP-selected directory;
            # Playwright's synthetic save_as artifact is empty for this native
            # browser. Verify the actual file, rather than that empty artifact.
            def completed_pngs():
                return [path for path in Path(directory).glob('*.png')
                        if path.is_file() and path.stat().st_size > len(PNG_SIGNATURE)]
            native.wait_until(lambda: len(completed_pngs()) == 1)
            destination = completed_pngs()[0]
            assert destination.resolve().is_relative_to(Path(directory).resolve())
            assert destination.read_bytes().startswith(PNG_SIGNATURE)
            with Image.open(destination) as image:
                assert image.format == 'PNG' and image.width <= 2400 and image.height <= 1600
                mask = image.convert('L').point(lambda value: 255 if value < 170 else 0)
                bounds = mask.getbbox()
                assert bounds and 30 < bounds[2] - bounds[0] < 600 and bounds[3] - bounds[1] > 45, bounds
            session.detach()
        print('Native whiteboard: draft-only history, drawing, text/KaTeX, formal/draft files, latest restore, edit leases, recovery copy and formula PNG passed', flush=True)
    finally:
        close_test_windows(pages, process)
        cleanup_created_boards(root, created, prefix)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', required=True, type=Path)
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert executable.is_file(), executable
    with sync_playwright() as playwright:
        native.run_case(playwright, executable, ['--tool', 'whiteboard'], check_whiteboard)
    print('Whiteboard native WebView2 smoke passed')
