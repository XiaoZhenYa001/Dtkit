import { escapeHtml as escape } from '../../core/html.js';
import { directoryBreakdown, formatBytes, formatCount, formatDuration } from './core.js';

const percentage = (bytes, total) => total > 0 ? `${(bytes / total * 100).toFixed(1)}%` : '0%';

function largeItems(items, total, directories, blocked) {
    return `<section class="software-large-items"><header><h4>${directories ? '直属目录' : '最大文件'}</h4><span>最多 20 项</span></header>${items.length ? `<ol>${items.map(item => `<li>
        <div><span title="${escape(item.path)}">${escape(item.path)}</span><strong>${formatBytes(item.bytes)} <small>${percentage(item.bytes, total)}</small></strong></div>
        <meter min="0" max="${Math.max(1, total)}" value="${Math.min(total, item.bytes)}" aria-label="${escape(item.path)} ${formatBytes(item.bytes)}"></meter>
        <div class="software-item-actions">${directories ? `<button class="software-drill" type="button" data-software-drill="${escape(item.path)}"${blocked ? ' disabled' : ''}>深入分析 <i class="ri-arrow-right-line" aria-hidden="true"></i></button>` : ''}<button type="button" data-software-copy="${escape(item.path)}">复制路径</button><button type="button" data-software-reveal="${escape(item.path)}">打开位置 <i class="ri-arrow-right-up-line" aria-hidden="true"></i></button></div>
        </li>`).join('')}</ol>` : `<p class="software-subtle">${directories ? '所选目录没有已统计的直属子目录。' : '没有已统计的文件。'}</p>`}</section>`;
}

export function reportMarkup(report, blocked) {
    const rows = directoryBreakdown(report);
    return `<section class="software-report">
        <div class="software-report-status${report.complete ? ' is-complete' : ''}"><span><i class="${report.complete ? 'ri-checkbox-circle-line' : 'ri-information-line'}" aria-hidden="true"></i>${report.complete ? '扫描完成' : report.cancelled ? '已取消 · 部分结果' : '部分结果'}</span><span>${formatDuration(report.elapsedMs)}</span></div>
        ${!report.complete || report.skipped ? `<p class="software-quality-note">${report.cancelled ? '扫描已停止，以下仅为停止前已统计的数据。' : '存在未读取或未统计的内容，以下仅显示已统计部分。'}跳过 ${formatCount(report.skipped)} 项，不计入大小。</p>` : ''}
        <div class="software-report-tools"><button id="softwareExportReport" class="software-button" type="button"${blocked ? ' disabled' : ''}><i class="ri-download-2-line" aria-hidden="true"></i>导出报告 JSON</button><button id="softwareCopySummary" class="software-button" type="button"${blocked ? ' disabled' : ''}><i class="ri-file-copy-line" aria-hidden="true"></i>复制摘要</button></div>
        <section class="software-breakdown"><header><h4>空间分布</h4><span>${report.complete ? '占目录已统计大小' : '仅占已统计部分'}</span></header>
            ${rows.length ? `<div class="software-distribution" role="img" aria-label="${escape(rows.map(row => `${row.label} ${percentage(row.bytes, report.totalBytes)}`).join('，'))}">${rows.map(row => `<span data-software-share="${row.bytes}" title="${escape(row.label)} · ${formatBytes(row.bytes)}"></span>`).join('')}</div><ul class="software-legend">${rows.map(row => `<li><i aria-hidden="true"></i><span title="${escape(row.path || row.label)}">${escape(row.label)}</span><strong>${formatBytes(row.bytes)}</strong><small>${percentage(row.bytes, report.totalBytes)}</small></li>`).join('')}</ul>` : '<p class="software-subtle">未统计到可显示占比的文件。</p>'}
        </section>
        <section class="software-file-types"><header><h4>文件类型</h4><span>同次扫描聚合</span></header>
            ${!report.fileTypesAvailable ? '<p class="software-subtle">此报告未包含文件类型统计，重新分析后可查看。</p>' : report.fileTypes.length ? `<ol>${report.fileTypes.map(row => `<li><div><span>${escape(row.extension === '*' ? '其他类型' : row.extension || '无扩展名')} <small>${formatCount(row.files)} 个文件</small></span><strong>${formatBytes(row.bytes)} · ${percentage(row.bytes, report.totalBytes)}</strong></div><meter min="0" max="${Math.max(1, report.totalBytes)}" value="${Math.min(report.totalBytes, row.bytes)}" aria-label="${escape(row.extension || '无扩展名')} ${formatBytes(row.bytes)}"></meter></li>`).join('')}</ol>` : '<p class="software-subtle">未统计到文件类型。</p>'}
        </section>
        ${report.warnings.length ? `<details class="software-report-warnings"><summary>扫描提示（${report.warnings.length}）</summary><ul>${report.warnings.map(warning => `<li>${escape(warning)}</li>`).join('')}</ul></details>` : ''}
        ${largeItems(report.largestDirectories, report.totalBytes, true, blocked)}${largeItems(report.largestFiles, report.totalBytes, false, blocked)}
    </section>`;
}
