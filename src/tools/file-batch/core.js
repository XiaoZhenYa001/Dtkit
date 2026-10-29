export const MAX_BATCH_FILES = 500;
export const DEFAULT_RENAME_OPTIONS = Object.freeze({
    find: '', replace: '', caseMode: 'keep', numberPadding: 1, numberStep: 1,
    trimWhitespace: false, removeStart: 0, removeEnd: 0, extensionCase: 'keep',
});

export function basename(path) {
    return String(path ?? '').split(/[\\/]/).at(-1) || '';
}

function nameParts(path) {
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    return dot > 0
        ? { stem: name.slice(0, dot), extension: name.slice(dot + 1) }
        : { stem: name, extension: '' };
}

export function extension(path) {
    return nameParts(path).extension;
}

function parentFolder(path) {
    const normalized = String(path ?? '').replace(/\\/g, '/')
        .replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
    const separator = normalized.lastIndexOf('/');
    if (separator < 0) return '';
    const parent = normalized.slice(0, separator).replace(/\/+$/, '');
    if (!parent || /^[a-z]:$/i.test(parent)) return '';
    if (parent.startsWith('//') && parent.slice(2).split('/').filter(Boolean).length <= 2) return '';
    return parent.slice(parent.lastIndexOf('/') + 1);
}

export function parseExtensions(value) {
    const values = Array.isArray(value) ? value : String(value ?? '').split(/[,，;；\s]+/);
    return [...new Set(values.map(item => String(item).trim().replace(/^\.+/, '').toLowerCase()).filter(Boolean))];
}

export function normalizeRenameOptions(input = {}) {
    const options = { ...DEFAULT_RENAME_OPTIONS, ...(input ?? {}) };
    options.find = String(options.find ?? '');
    options.replace = String(options.replace ?? '');
    if (Array.from(options.find).length > 160 || Array.from(options.replace).length > 160) {
        throw new Error('查找和替换内容不能超过 160 个字符');
    }
    if (!['keep', 'lower', 'upper'].includes(options.caseMode)) throw new Error('文件名大小写选项无效');
    if (!['keep', 'lower', 'upper'].includes(options.extensionCase)) throw new Error('扩展名大小写选项无效');
    if (typeof options.trimWhitespace !== 'boolean') throw new Error('清理首尾空白选项无效');
    for (const [key, minimum, maximum, label] of [
        ['numberPadding', 1, 8, '序号位数'], ['numberStep', 1, 10000, '序号步长'],
        ['removeStart', 0, 160, '删除开头字符数'], ['removeEnd', 0, 160, '删除结尾字符数'],
    ]) {
        options[key] = Number(options[key]);
        if (!Number.isInteger(options[key]) || options[key] < minimum || options[key] > maximum) {
            throw new Error(`${label}须为 ${minimum}–${maximum} 之间的整数`);
        }
    }
    return options;
}

function validateFilename(name) {
    if (!name || name.trim() !== name) throw new Error('文件名不能为空，也不能以空格开头或结尾');
    if (name.length > 255) throw new Error('文件名过长');
    if (name === '.' || name === '..' || /[\x00-\x1f\x7f-\x9f<>:\\/|?*]/.test(name)) {
        throw new Error('文件名包含 Windows 不支持的字符');
    }
    if (name.endsWith('.')) throw new Error('文件名不能以句点结尾');
    const stem = name.split('.')[0].toUpperCase();
    const numberedDevice = /^(?:COM|LPT)(\+?\d+)$/.exec(stem);
    if (['CON', 'PRN', 'AUX', 'NUL'].includes(stem)
        || (numberedDevice && Number(numberedDevice[1]) >= 1 && Number(numberedDevice[1]) <= 9)) {
        throw new Error('文件名使用了 Windows 保留名称');
    }
}

export function renderRename(path, index, pattern = '{name}_{n}{dotext}', input = {}) {
    const options = normalizeRenameOptions(input);
    if (typeof pattern !== 'string' || !pattern || Array.from(pattern).length > 160) {
        throw new Error('重命名模板不能为空且不能超过 160 个字符');
    }
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error('文件序号超出有效范围');
    const parts = nameParts(path);
    let stem = options.trimWhitespace ? parts.stem.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') : parts.stem;
    const characters = Array.from(stem);
    stem = characters.slice(options.removeStart, Math.max(0, characters.length - options.removeEnd)).join('');
    if (options.find) stem = stem.split(options.find).join(options.replace);
    if (options.caseMode === 'lower') stem = stem.toLowerCase();
    if (options.caseMode === 'upper') stem = stem.toUpperCase();
    let ext = parts.extension;
    if (options.extensionCase === 'lower') ext = ext.toLowerCase();
    if (options.extensionCase === 'upper') ext = ext.toUpperCase();
    const tokens = {
        name: stem,
        ext,
        dotext: ext ? `.${ext}` : '',
        n: String(index).padStart(options.numberPadding, '0'),
        folder: parentFolder(path),
    };
    // Expand only tokens written in the template, never tokens inside a source name.
    const name = pattern.replace(/\{(name|ext|dotext|n|folder)\}/g, (_, token) => tokens[token]);
    validateFilename(name);
    return name;
}

function sourceKey(path) {
    return String(path).replace(/\//g, '\\')
        .replace(/^\\\\\?\\UNC\\/i, '\\\\')
        .replace(/^\\\\\?\\/, '')
        .toLowerCase();
}

export function mergeSources(existing = [], incoming = [], limit = MAX_BATCH_FILES) {
    const sources = [];
    const seen = new Set();
    let added = 0;
    let duplicates = 0;
    let overflow = 0;
    const maximum = Number.isInteger(limit) && limit >= 0 ? limit : MAX_BATCH_FILES;
    for (const path of existing) {
        if (typeof path !== 'string' || !path || seen.has(sourceKey(path))) continue;
        seen.add(sourceKey(path));
        if (sources.length < maximum) sources.push(path);
    }
    for (const path of incoming) {
        if (typeof path !== 'string' || !path) continue;
        const key = sourceKey(path);
        if (seen.has(key)) { duplicates += 1; continue; }
        seen.add(key);
        if (sources.length >= maximum) { overflow += 1; continue; }
        sources.push(path);
        added += 1;
    }
    return { sources, added, duplicates, overflow };
}

const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function sortSources(sources, mode = 'manual') {
    const result = [...sources];
    if (mode === 'name-asc') result.sort((a, b) => nameCollator.compare(basename(a), basename(b)));
    if (mode === 'name-desc') result.sort((a, b) => nameCollator.compare(basename(b), basename(a)));
    if (mode === 'extension') result.sort((a, b) => nameCollator.compare(extension(a), extension(b)) || nameCollator.compare(basename(a), basename(b)));
    return result;
}

export function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
    const amount = bytes / 1024 ** index;
    return `${index === 0 ? Math.round(amount) : Number(amount.toFixed(amount >= 100 ? 0 : 1))} ${units[index]}`;
}

export function csvCell(value) {
    let cell = String(value ?? '');
    if (/^(?:[\p{White_Space}\uFEFF]*[=+@-]|[\t\r\n])/u.test(cell)) cell = "'" + cell;
    return '"' + cell.replaceAll('"', '""') + '"';
}

export function batchCsv(items, { operation = '', taskStatus = null, processed = 0, error = '' } = {}) {
    const completed = Math.max(0, Math.floor(Number(processed) || 0));
    const state = (item, index) => {
        if (item.excluded) return '排除';
        if (item.conflict) return `冲突：${item.conflict}`;
        if (taskStatus) return index < completed ? '已完成' : taskStatus === 'running' ? '等待' : '未处理';
        return item.draft ? '待检查' : '已检查';
    };
    const rows = [['原文件', '目标路径', '操作', '大小（字节）', '检查或执行状态', '任务提示'],
        ...items.map((item, index) => [item.source, item.target, operation, item.size, state(item, index), error])];
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function requestFingerprint(request) {
    const operation = request.operation || 'rename';
    return JSON.stringify({
        sources: request.sources ?? [], operation,
        extensions: parseExtensions(request.extensions).sort(),
        ...(operation === 'rename' ? {
            namePattern: request.namePattern ?? '{name}_{n}{dotext}',
            startIndex: Number(request.startIndex ?? 1),
            renameOptions: normalizeRenameOptions(request.renameOptions),
        } : {}),
        ...(['copy', 'move'].includes(operation) ? { destination: request.destination || null } : {}),
        ...(operation === 'delete' ? { permanent: Boolean(request.permanent) } : {}),
    });
}
