import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import test from 'node:test';

function collectJavaScriptFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return collectJavaScriptFiles(path);
        return extname(entry.name) === '.js' ? [path] : [];
    });
}

test('templated tools load external CSS instead of registering inline style strings', () => {
    const failures = [];

    for (const path of collectJavaScriptFiles(resolve('src/tools'))) {
        const source = readFileSync(path, 'utf8');
        if (/function\s+getStyles\s*\(/.test(source) || /styles:\s*getStyles/.test(source)) {
            failures.push(`${path}: still registers a runtime CSS string`);
        }
        const registersTemplate = source.includes('registerTool({') && /\btemplate:\s*[A-Za-z_$]/.test(source);
        const importsCss = /import\s+['"][^'"]+\.css['"]/.test(source);
        if (registersTemplate && !importsCss) {
            failures.push(`${path}: templated tool has no external CSS import`);
        }
    }

    assert.deepEqual(failures, []);
});

test('application modules do not construct runtime style elements', () => {
    const isolatedPreviewRunner = resolve('src/preview-runner.js');
    const failures = [];

    for (const path of collectJavaScriptFiles(resolve('src'))) {
        if (resolve(path) === isolatedPreviewRunner) continue;
        const source = readFileSync(path, 'utf8');
        if (/createElement\(['"]style['"]\)|style\.cssText/.test(source)) {
            failures.push(path);
        }
    }

    assert.deepEqual(failures, []);
});

test('semantic primary and danger buttons keep explicit accessible interaction states', () => {
    const expectations = [
        ['src/css/tools/file-batch.css', ['.batch-button--primary:hover:not(:disabled)', '.batch-button--danger:hover:not(:disabled)', '.batch-button:focus-visible']],
        ['src/css/tools/transfer-station.css', ['.transfer-button--primary:hover:not(:disabled)', '.transfer-button--danger:hover:not(:disabled)', '.transfer-button:focus-visible']],
        ['src/css/tools/resource-center.css', ['.resource-button--primary:hover:not(:disabled)', '.resource-button:focus-visible']],
        ['src/css/tools/text-snippets.css', ['.snippet-primary:hover:not(:disabled)', '.snippet-primary:focus-visible']],
        ['src/css/tools/whiteboard.css', ['.whiteboard-object-dialog__panel footer button:last-child:hover:not(:disabled)', '.whiteboard-object-dialog__panel footer button:focus-visible']],
        ['src/css/settings.css', ['.modal-btn--primary:hover:not(:disabled)', '.modal-btn--danger:hover:not(:disabled)', '.modal-btn:focus-visible']],
    ];

    const failures = [];
    for (const [path, selectors] of expectations) {
        const source = readFileSync(resolve(path), 'utf8');
        for (const selector of selectors) {
            if (!source.includes(selector)) failures.push(`${path}: missing ${selector}`);
        }
    }

    assert.deepEqual(failures, []);
});
