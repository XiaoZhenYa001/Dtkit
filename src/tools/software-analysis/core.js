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

export function filterSoftware(items, { query = '', scope = 'all', sort = 'name', publisher = '', status = 'all' } = {}, reports = new Map()) {
    const terms = string(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const reportFor = id => reports.peek ? reports.peek(id) : reports.get(id);
    const matchesStatus = item => {
        const report = reportFor(item.id);
        return status === 'analyzable' ? item.canAnalyze : status === 'no-location' ? !item.canAnalyze
            : status === 'unknown-size' ? item.estimatedBytes === null : status === 'measured' ? report?.complete === true
                : status === 'partial' ? Boolean(report && !report.complete) : status === 'unmeasured' ? !report
                    : status === 'large' ? item.estimatedBytes !== null && item.estimatedBytes >= 1024 ** 3 : true;
    };
    const filtered = items.filter(item => (scope === 'all' || item.scope === scope)
        && (!publisher || item.publisher === publisher) && matchesStatus(item)
        && terms.every(term => item.searchText.includes(term)));
    const measured = id => { const report = reportFor(id); return report?.complete ? count(report.totalBytes) : null; };
    const size = item => sort === 'estimated' ? item.estimatedBytes : measured(item.id);
    filtered.sort((a, b) => {
        if (sort === 'estimated' || sort === 'measured') {
            const left = size(a), right = size(b);
            if (left === null && right !== null) return 1;
            if (left !== null && right === null) return -1;
            if (left !== null && right !== null && left !== right) return right - left;
        }
        if (sort === 'publisher') {
            const difference = collator.compare(a.publisher, b.publisher);
            if (difference) return difference;
        }
        if (sort === 'date') {
            const left = registrationDate(a.installDate), right = registrationDate(b.installDate);
            if (left !== right) return right.localeCompare(left);
        }
        return collator.compare(a.name, b.name) || collator.compare(a.id, b.id);
    });
    return filtered;
}

/** Invalid or ambiguous installer dates must not sort as recent installations. */
export function registrationDate(value) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(string(value));
    if (!match) return '';
    const [, year, month, day] = match;
    const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === `${year}-${month}-${day}` ? `${year}-${month}-${day}` : '';
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
        rootFilesBytes: count(report.rootFilesBytes),
        fileTypesAvailable: report.fileTypesAvailable !== false && Array.isArray(report.fileTypes),
        fileTypes: (Array.isArray(report.fileTypes) ? report.fileTypes : []).slice(0, 64)
            .filter(item => item && typeof item.extension === 'string' && item.extension.length <= 64)
            .map(item => ({ extension: item.extension, bytes: count(item.bytes) ?? 0, files: count(item.files) ?? 0 })),
        largestDirectories: largest(report.largestDirectories), largestFiles: largest(report.largestFiles),
        warnings: (Array.isArray(report.warnings) ? report.warnings : []).filter(item => typeof item === 'string').slice(0, 30)
    };
}

export function directoryBreakdown(report) {
    let remaining = report.totalBytes;
    const rootBytes = count(report.rootFilesBytes);
    const rows = report.largestDirectories.slice(0, 6).map(item => {
        const bytes = Math.min(remaining, item.bytes); remaining -= bytes;
        return { label: item.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || item.path, path: item.path, bytes };
    });
    if (rootBytes !== null) {
        const bytes = Math.min(remaining, rootBytes); remaining -= bytes;
        if (bytes) rows.push({ label: '根目录直属文件', bytes });
    }
    if (remaining) rows.push({ label: rootBytes === null ? '其他已统计内容' : '其他直属目录', bytes: remaining });
    return rows.filter(item => item.bytes > 0).sort((a, b) => b.bytes - a.bytes);
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
