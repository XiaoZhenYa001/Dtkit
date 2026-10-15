import '../css/tool-loading.css';

const profiles = [
    ['calendar', ['timetable'], '把一周的安排，清楚呈现'],
    ['clock', ['alarm-clock', 'timestamp-converter', 'crontab-explainer'], '让时间更有条理'],
    ['code', ['json-formatter', 'base64-codec', 'hash-tool', 'url-encoder', 'html-preview', 'unit-converter'], '准备好每一次转换'],
    ['palette', ['color-picker'], '找到恰好的颜色'],
    ['canvas', ['whiteboard', 'clipboard-puzzle', 'screenshot-annotator', 'region-mirror', 'qr-generator'], '为你的创作展开画布'],
    ['notes', ['sticky-notes', 'text-snippets'], '让灵感各就各位'],
    ['files', ['file-batch', 'transfer-station', 'startup-manager', 'context-menu', 'resource-center', 'system-assistant', 'desktop-app-manager'], '让常用操作井然有序']
];

export function createToolLoading({ toolId, name, icon = 'ri-apps-2-line', retry }) {
    const [kind, , caption] = profiles.find(([, ids]) => ids.includes(toolId)) || ['tiles', [], '即将准备就绪'];
    const element = document.createElement('section'); element.className = 'tool-loading'; element.dataset.motif = kind; element.dataset.toolId = toolId;
    const body = document.createElement('div'); body.className = 'tool-loading__body';
    const art = document.createElement('div'); art.className = 'tool-loading__art'; art.setAttribute('aria-hidden', 'true');
    const emblem = document.createElement('i'); emblem.className = `tool-loading__icon ${icon}`;
    art.append(emblem);
    const pattern = document.createElement('div'); pattern.className = 'tool-loading__pattern';
    for (let index = 0; index < (kind === 'calendar' ? 21 : 12); index++) {
        const cell = document.createElement('span'); cell.style.setProperty('--tile-index', index); pattern.append(cell);
    }
    art.append(pattern);
    const heading = document.createElement('h2'); heading.textContent = name || '工具';
    const subtitle = document.createElement('p'); subtitle.className = 'tool-loading__caption'; subtitle.textContent = caption;
    const status = document.createElement('p'); status.className = 'tool-loading__status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tool-loading__retry'; button.textContent = '重新打开'; button.hidden = true;
    button.addEventListener('click', () => { restart(); retry?.(); });
    body.append(art, heading, subtitle, status, button); element.append(body);
    function restart() { element.hidden = false; delete element.dataset.failed; button.hidden = true; status.textContent = '正在准备工具'; element.setAttribute('aria-busy', 'true'); }
    restart();
    return { element,
        stage(text) { status.textContent = text; },
        fail(message) { element.dataset.failed = 'true'; status.textContent = `暂时无法打开：${message}`; button.hidden = !retry; element.setAttribute('aria-busy', 'false'); },
        restart,
        dispose() { element.remove(); },
        finish() { element.hidden = true; element.setAttribute('aria-busy', 'false'); }
    };
}
