import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const registry = fs.readFileSync(new URL('../src/tools/toolRegistry.js', import.meta.url), 'utf8');
const snippets = fs.readFileSync(new URL('../src-tauri/src/infrastructure/snippets.rs', import.meta.url), 'utf8');
const snippetUi = fs.readFileSync(new URL('../src/tools/text-snippets/index.js', import.meta.url), 'utf8');
const screenshot = fs.readFileSync(new URL('../src-tauri/src/infrastructure/screenshot.rs', import.meta.url), 'utf8');
const screenshotUi = fs.readFileSync(new URL('../src/tools/screenshot-annotator/index.js', import.meta.url), 'utf8');
const qr = fs.readFileSync(new URL('../src/tools/qr-generator/index.js', import.meta.url), 'utf8');

test('tool modules stay lazy and disabled modules cannot load', () => {
    assert.match(registry, /if \(!tool\.enabled\) throw new Error/);
    assert.match(registry, /options\.includeDisabled/);
});

test('text snippets use a bounded lazy native cache without polling', () => {
    assert.match(snippets, /RwLock<Option<\(PathBuf, Vec<Snippet>\)>>/);
    assert.match(snippets, /MAX_RESULTS/);
    assert.doesNotMatch(snippets, /sleep\(|interval/);
    assert.match(snippetUi, /id="snippetEditorCancel" type="button"/);
    assert.match(snippetUi, /saving = true/);
});

test('screenshot capture releases every GDI resource and is user-triggered', () => {
    assert.match(screenshot, /ReleaseDC/);
    assert.match(screenshot, /DeleteDC/);
    assert.match(screenshot, /DeleteObject/);
    assert.doesNotMatch(screenshot, /loop \{|while /);
    assert.match(screenshotUi, /captureGeneration \+= 1/);
    assert.match(screenshotUi, /releaseBackground\(\)/);
    assert.doesNotMatch(screenshotUi, /\bprompt\(/);
    assert.match(screenshotUi, /captureTextDialog/);
    assert.match(screenshotUi, /if \(isQuickHost\(\)\) await capture\(\)/);
});

test('temporary QR reuses transfer station commands', () => {
    assert.match(qr, /invoke\('import_transfer_files'/);
    assert.match(qr, /invoke\('start_lan_share'/);
    assert.match(qr, /invoke\('stop_lan_share'/);
    assert.doesNotMatch(qr, /setInterval/);
    assert.match(qr, /qrGeneration \+= 1/);
    assert.match(qr, /aria-selected/);
    assert.match(qr, /relativeLuminance/);
});
