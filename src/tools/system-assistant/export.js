export const STARTUP_CSV_HEADERS = Object.freeze([
    '名称', '状态', '范围', '来源', '命令', '程序路径', '来源位置', '关闭时间', '备注'
]);

const text = value => typeof value === 'string' ? value : '';

function csvCell(value) {
    // Quoting alone does not stop Excel evaluating a cell as a formula. Prefix
    // before any whitespace/control characters, preserving the original text.
    const safe = /^[\s\u0000-\u001F\u007F]*[=+\-@]/u.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
}

function disabledTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

/** Build a UTF-8-ready CSV string for exactly the supplied normalized entries. */
export function buildStartupCsv(items) {
    if (!Array.isArray(items)) throw new TypeError('导出启动项必须是列表');
    const rows = items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new TypeError('导出列表包含无效的启动项');
        }
        return [
            text(item.name),
            item.enabled ? '已启用' : item.managed ? '我关闭的' : '已关闭',
            item.scope === 'system' ? '所有用户' : '当前用户',
            text(item.sourceLabel) || (item.sourceKind === 'startupFolder' ? '启动文件夹' : '注册表'),
            text(item.command),
            text(item.targetPath),
            text(item.sourcePath) || text(item.sourceDetail),
            disabledTime(item.backupDisabledAt),
            text(item.disabledReason)
        ];
    });
    // The BOM makes Chinese text open as UTF-8 in Excel. A final CRLF also
    // leaves a header-only export as a complete, valid CSV record.
    return '\uFEFF' + [STARTUP_CSV_HEADERS, ...rows]
        .map(row => row.map(csvCell).join(','))
        .join('\r\n') + '\r\n';
}
