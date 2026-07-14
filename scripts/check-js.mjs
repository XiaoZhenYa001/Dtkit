import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

function collectJavaScriptFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return collectJavaScriptFiles(path);
        return extname(entry.name) === '.js' || extname(entry.name) === '.mjs' ? [path] : [];
    });
}

const files = [
    'vite.config.js',
    ...collectJavaScriptFiles('src'),
    ...collectJavaScriptFiles('scripts'),
    ...collectJavaScriptFiles('tests')
];

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        encoding: 'utf8',
        stdio: 'pipe'
    });

    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout);
        process.stderr.write(`JavaScript syntax check failed: ${file}\n`);
        process.exit(result.status || 1);
    }
}

console.log(`JavaScript syntax check passed for ${files.length} files.`);
