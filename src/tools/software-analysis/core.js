export const PAGE_SIZE = 60;
export const REPORT_CACHE_LIMIT = 20;
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const string = value => typeof value === 'string' ? value : '';
const count = value => Number.isFinite(value) && value >= 0 ? value : null;

export function formatBytes(value) {
    if (count(value) === null) return '未提供';
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const scaled = value / (1024 ** Math.max(0, exponent));
    return `${scaled.toLocaleString('zh-CN', { maximumFractionDigits: exponent > 0 ? 1 : 0 })} ${units[Math.max(0, exponent)]}`;
}

export function formatCount(value) { return Math.floor(count(value) ?? 0).toLocaleString('zh-CN'); }
export function formatDuration(value) {
    const seconds = Math.max(0, count(value) ?? 0) / 1000;
    return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}

/** Windows comparisons are lexical: no disk access or filesystem probing. */
export function normalizeWindowsPath(value) {
    let path = string(value).trim().replace(/\//g, '\\');
    if (path.toLocaleLowerCase().startsWith('\\\\?\\unc\\')) path = `\\\\${path.slice(8)}`;
    else if (path.startsWith('\\\\?\\')) path = path.slice(4);
    if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+)/i.test(path)) return '';
    path = path.replace(/\\+$/g, '').toLocaleLowerCase();
    if (path.split('\\').some(part => part === '.' || part === '..')) return '';
    return path;
}

export function isPathWithin(path, root) {
    const target = normalizeWindowsPath(path), directory = normalizeWindowsPath(root);
    return Boolean(target && directory && (target === directory || target.startsWith(`${directory}\\`)));
}

export function prepareSoftware(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).filter(item => {
        if (!item || !string(item.id) || seen.has(item.id)) return false;
        seen.add(item.id); return true;
    }).map(item => {
        const normalized = {
            id: item.id, name: string(item.name) || '未命名软件', version: string(item.version),
            publisher: string(item.publisher), installLocation: string(item.installLocation),
            estimatedBytes: count(item.estimatedBytes), installDate: string(item.installDate),
            scope: item.scope === 'user' ? 'user' : 'system', source: string(item.source),
            canAnalyze: item.canAnalyze === true, reason: string(item.reason)
        };
        normalized.searchText = [normalized.name, normalized.version, normalized.publisher, normalized.installLocation]
            .join(' ').toLocaleLowerCase();
        return normalized;
    });
}

export function filterSoftware(items, { query = '', scope = 'all', sort = 'name' } = {}, reports = new Map()) {
    const terms = string(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const filtered = items.filter(item => (scope === 'all' || item.scope === scope)
        && terms.every(term => item.searchText.includes(term)));
    const measured = id => { const report = reports.peek ? reports.peek(id) : reports.get(id); return report?.complete ? count(report.totalBytes) : null; };
    const size = item => sort === 'estimated' ? item.estimatedBytes : measured(item.id);
    filtered.sort((a, b) => {
        if (sort === 'estimated' || sort === 'measured') {
            const left = size(a), right = size(b);
            if (left === null && right !== null) return 1;
            if (left !== null && right === null) return -1;
            if (left !== null && right !== null && left !== right) return right - left;
        }
        return collator.compare(a.name, b.name) || collator.compare(a.id, b.id);
    });
    return filtered;
}

export function paginateSoftware(items, requestedPage = 1) {
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const page = Math.max(1, Math.min(Math.floor(Number(requestedPage)) || 1, pages));
    return { items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, pages, total: items.length };
}

/** Only bounded aggregates enter the page cache; never retain a file tree. */
export function prepareReport(report = {}) {
    const largest = values => (Array.isArray(values) ? values : []).slice(0, 20)
        .map(item => ({ path: string(item?.path), bytes: count(item?.bytes) ?? 0 }));
    return {
        requestId: string(report.requestId), softwareId: string(report.softwareId) || null,
        root: string(report.root), totalBytes: count(report.totalBytes) ?? 0,
        files: count(report.files) ?? 0, directories: count(report.directories) ?? 0,
        skipped: count(report.skipped) ?? 0, elapsedMs: count(report.elapsedMs) ?? 0,
        complete: report.complete === true, cancelled: report.cancelled === true,
        largestDirectories: largest(report.largestDirectories), largestFiles: largest(report.largestFiles),
        warnings: (Array.isArray(report.warnings) ? report.warnings : []).filter(item => typeof item === 'string').slice(0, 30)
    };
}

export function createReportCache(limit = REPORT_CACHE_LIMIT) {
    const values = new Map();
    const maximum = Math.min(REPORT_CACHE_LIMIT, Math.max(1, Math.floor(Number(limit)) || REPORT_CACHE_LIMIT));
    return {
        get size() { return values.size; },
        get(key) { const value = values.get(key); if (value) { values.delete(key); values.set(key, value); } return value; },
        peek: key => values.get(key), has: key => values.has(key), clear: () => values.clear(),
        entries: () => values.entries(),
        set(key, report) {
            values.delete(key); values.set(key, prepareReport(report));
            if (values.size > maximum) values.delete(values.keys().next().value);
            return this;
        }
    };
}
