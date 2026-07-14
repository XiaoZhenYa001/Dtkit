import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import test from 'node:test';

function collectSourceMarkup(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return collectSourceMarkup(path);
        return ['.html', '.js'].includes(extname(entry.name)) ? [path] : [];
    });
}

function getDirective(csp, directiveName) {
    return csp
        .split(';')
        .map(directive => directive.trim())
        .find(directive => directive.startsWith(`${directiveName} `)) || '';
}

test('production CSP rejects inline styles while development CSP supports Vite HMR', () => {
    const config = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'));
    const { csp, devCsp } = config.app.security;

    assert.ok(!getDirective(csp, 'style-src').includes("'unsafe-inline'"));
    assert.ok(getDirective(csp, 'style-src').includes('blob:'));
    assert.ok(!getDirective(csp, 'connect-src').includes('ws://127.0.0.1:1420'));
    assert.ok(getDirective(devCsp, 'style-src').includes("'unsafe-inline'"));
    assert.ok(getDirective(devCsp, 'connect-src').includes('ws://127.0.0.1:1420'));

    const runnerSource = readFileSync(resolve('src/preview-runner.js'));
    const runnerHash = `'sha256-${createHash('sha256').update(runnerSource).digest('base64')}'`;
    assert.ok(
        getDirective(csp, 'script-src').includes(runnerHash),
        'Preview runner hash is stale; run npm run csp:hash'
    );
    assert.ok(
        getDirective(devCsp, 'script-src').includes(runnerHash),
        'Preview runner dev hash is stale; run npm run csp:hash'
    );
});

test('application markup contains no CSP-blocked style attributes', () => {
    const violations = [];
    for (const path of collectSourceMarkup(resolve('src'))) {
        const source = readFileSync(path, 'utf8');
        if (/<[^>]*\sstyle\s*=/.test(source)) violations.push(`${path}: style attribute`);
        if (/setAttribute\(\s*['"]style['"]|style\.cssText/.test(source)) {
            violations.push(`${path}: blocked runtime style assignment`);
        }
    }

    assert.deepEqual(violations, []);
});
