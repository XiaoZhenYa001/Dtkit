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
