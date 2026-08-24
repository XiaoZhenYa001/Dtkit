import { showToast } from '../../core/utils.js';

export const CURRENT_VERSION = '0.2.7';
export const RELEASES_PAGE = 'https://github.com/XiaoZhenYa001/Dtkit/releases';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/XiaoZhenYa001/Dtkit/releases/latest';

const invoke = (...args) => globalThis.window?.__TAURI__?.core?.invoke?.(...args);
let initialized = false;
let busy = false;
let shouldOpenReleases = false;

export function parseVersion(value) {
    const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
    return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) throw new Error('版本号格式无效');
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
}

export async function fetchLatestRelease(fetchImpl = globalThis.fetch, timeoutMs = 8_000) {
    if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持联网检查');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(LATEST_RELEASE_API, {
            method: 'GET',
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            },
            signal: controller.signal,
            cache: 'no-store'
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
        const release = await response.json();
        if (!parseVersion(release?.tag_name)) throw new Error('Release 缺少有效版本号');
        return { version: release.tag_name.replace(/^v/i, ''), name: release.name || release.tag_name };
    } finally {
        clearTimeout(timeout);
    }
}

async function openReleases() {
    try {
        await invoke('open_release_page');
    } catch (error) {
        showToast(`无法打开发布页：${error}`, 'error');
    }
}

export function initUpdateChecker() {
    if (initialized) return;
    const button = document.getElementById('checkUpdateButton');
    const status = document.getElementById('updateCheckStatus');
    if (!button || !status) return;
    initialized = true;

    button.addEventListener('click', async () => {
        if (shouldOpenReleases) {
            await openReleases();
            return;
        }
        if (busy) return;

        busy = true;
        button.disabled = true;
        button.textContent = '检查中…';
        status.textContent = '';
        button.removeAttribute('data-state');
        try {
            const release = await fetchLatestRelease();
            if (!release) {
                status.textContent = '暂无正式版本';
                button.textContent = '打开发布页';
                shouldOpenReleases = true;
                showToast('GitHub 暂无正式 Release，可前往发布页查看。', 'info');
            } else if (compareVersions(release.version, CURRENT_VERSION) > 0) {
                status.textContent = `发现 v${release.version}`;
                button.textContent = '前往下载';
                button.dataset.state = 'available';
                shouldOpenReleases = true;
                showToast(`发现新版本 v${release.version}`, 'success');
            } else {
                status.textContent = `已是最新 v${CURRENT_VERSION}`;
                button.textContent = '再次检查';
                showToast('当前已经是最新正式版本。', 'success');
            }
        } catch (error) {
            status.textContent = error?.name === 'AbortError' ? '检查超时' : '暂时无法检查';
            button.textContent = '打开发布页';
            shouldOpenReleases = true;
            showToast('自动检查失败，可直接打开 GitHub 发布页。', 'warning');
        } finally {
            busy = false;
            button.disabled = false;
        }
    });
}
