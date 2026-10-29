import { formatBytes, formatCount, prepareReport } from './core.js';

const reportFor = (reports, id) => reports.peek ? reports.peek(id) : reports.get(id);
const scanStatus = report => !report ? '未扫描' : report.complete ? '完整' : report.cancelled ? '已取消（部分）' : '不完整';

// Quoting protects delimiters; the prefix also prevents spreadsheet formulas.
export function csvCell(value) {
    let text = String(value ?? '');
    if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
}

export function inventoryCsv(items, reports) {
    const rows = [['软件名称', '版本', '发布者', '安装范围', '登记日期', '安装位置', '登记大小（字节）', '已统计逻辑大小（字节）', '扫描状态', '登记来源'],
        ...items.map(item => {
            const report = reportFor(reports, item.id);
            return [item.name, item.version, item.publisher, item.scope === 'user' ? '当前用户' : '所有用户', item.installDate,
                item.installLocation, item.estimatedBytes, report?.totalBytes, scanStatus(report), item.source];
        })];
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function reportJson(item, source, exportedAt = new Date().toISOString()) {
    const report = prepareReport(source);
    return JSON.stringify({ format: 'dtkit-software-report', version: 1, exportedAt,
        software: { name: item.name, version: item.version, publisher: item.publisher, source: item.source,
            installLocation: item.installLocation, estimatedBytes: item.estimatedBytes, manual: item.manual === true },
        measurement: 'logical-file-bytes',
        scopeNote: '仅包含报告根目录内已读取的文件；未自动归属其他位置的数据或共享文件。逻辑大小不等于实际分配空间；硬链接可能重复计数。',
        report }, null, 2);
}

export function reportSummary(item, report) {
    const lines = [`软件空间分析：${item.name}`, `分析位置：${report.root}`, `结果：${scanStatus(report)}`,
        `登记大小：${formatBytes(item.estimatedBytes)}`, `已统计逻辑大小：${formatBytes(report.totalBytes)}`,
        `文件：${formatCount(report.files)} · 目录：${formatCount(report.directories)} · 跳过：${formatCount(report.skipped)}`,
        '', '直属目录（最多列出前 5 项）：', ...report.largestDirectories.slice(0, 5).map(row => `${formatBytes(row.bytes)}  ${row.path}`),
        '', '仅统计分析位置及其子目录内已读取的文件。逻辑文件大小不等于磁盘实际分配空间；硬链接可能重复计数。'];
    if (!report.complete) lines.push('结果不完整，不能作为全目录占用结论。');
    if (report.warnings.length) lines.push('', '扫描提示：', ...report.warnings);
    return lines.join('\n');
}
