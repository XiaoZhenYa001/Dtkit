import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configPath = resolve('src-tauri/tauri.conf.json');
const runnerPath = resolve('src/preview-runner.js');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const runnerHash = `'sha256-${createHash('sha256')
    .update(readFileSync(runnerPath))
    .digest('base64')}'`;

function updateScriptDirective(policy) {
    const directives = policy.split(';').map(directive => directive.trim()).filter(Boolean);
    const scriptIndex = directives.findIndex(directive => directive.startsWith('script-src '));
    if (scriptIndex < 0) throw new Error('script-src directive is missing');

    const hashPattern = /'sha256-[A-Za-z0-9+/=]+'/;
    directives[scriptIndex] = hashPattern.test(directives[scriptIndex])
        ? directives[scriptIndex].replace(hashPattern, runnerHash)
        : `${directives[scriptIndex]} ${runnerHash}`;
    return directives.join('; ');
}

config.app.security.csp = updateScriptDirective(config.app.security.csp);
config.app.security.devCsp = updateScriptDirective(config.app.security.devCsp);
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`Updated preview runner CSP hash: ${runnerHash}`);
