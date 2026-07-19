/**
 * 时间戳转换工具
 * 在 Unix 时间戳和日期时间之间相互转换
 *
 * 每个工具文件夹包含: index.js (主逻辑), template.html (HTML模板), style.css (样式)
 */
import { registerTool } from '../toolRegistry.js';
import '../../css/tools/timestamp-converter.css';

// 定时器引用，用于清理
let updateInterval = null;
// 事件监听器控制器
let abortController = null;

/**
 * 获取工具的 HTML 模板
 */
function getTemplate() {
    return `
        <div class="view-container">
            <div class="timestamp-container">
                <!-- 当前时间戳显示 -->
                <div class="current-time-section">
                    <div class="current-time-label">当前 Unix 时间戳</div>
                    <div class="current-time-display">
                        <span id="currentTimestamp" class="timestamp-value">--</span>
                        <button id="copyCurrentBtn" class="btn btn--icon" title="复制">
                            <i class="ri-file-copy-line"></i>
                        </button>
                    </div>
                </div>

                <!-- 转换区域 -->
                <div class="conversion-panels">
                    <!-- 时间戳转日期 -->
                    <div class="conversion-panel">
                        <div class="panel-header">
                            <h3 class="panel-title"><i class="ri-arrow-right-line"></i> 时间戳转日期</h3>
                        </div>
                        <div class="panel-body">
                            <div class="input-group">
                                <label class="label">Unix 时间戳</label>
                                <input type="text" id="timestampInput" class="input" placeholder="输入时间戳 (秒/毫秒)">
                            </div>
                            <button id="toDateBtn" class="btn btn--primary">
                                <i class="ri-calendar-line"></i> 转换为日期
                            </button>
                            <div id="dateResult" class="result-box">
                                等待输入...
                            </div>
                        </div>
                    </div>

                    <!-- 日期转时间戳 -->
                    <div class="conversion-panel">
                        <div class="panel-header">
                            <h3 class="panel-title"><i class="ri-arrow-left-line"></i> 日期转时间戳</h3>
                        </div>
                        <div class="panel-body">
                            <div class="input-group">
                                <label class="label">选择日期时间</label>
                                <div class="input-with-btn">
                                    <input type="datetime-local" id="dateInput" class="input">
                                    <button id="nowBtn" class="btn btn--secondary" title="使用当前时间">
                                        <i class="ri-time-line"></i> 现在
                                    </button>
                                </div>
                            </div>
                            <button id="toTimestampBtn" class="btn btn--primary">
                                <i class="ri-hashtag"></i> 转换为时间戳
                            </button>
                            <div id="timestampResult" class="result-box">
                                等待输入...
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 快速参考 -->
                <div class="quick-reference">
                    <h4 class="quick-ref-title">快速参考</h4>
                    <div id="quickReferenceGrid" class="quick-ref-grid">
                        <!-- 动态生成 -->
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * 获取工具的 CSS 样式
 */


/**
 * 设置结果框错误状态
 */
function setResultError(element, message) {
    element.innerHTML = `❌ ${message}`;
    element.className = 'result-box result-box--error';
}

/**
 * 初始化时间戳工具
 */
function initTimestampTool() {
    const currentTimestamp = document.getElementById('currentTimestamp');
    const timestampInput = document.getElementById('timestampInput');
    const dateInput = document.getElementById('dateInput');
    const toDateBtn = document.getElementById('toDateBtn');
    const toTimestampBtn = document.getElementById('toTimestampBtn');
    const nowBtn = document.getElementById('nowBtn');
    const dateResult = document.getElementById('dateResult');
    const timestampResult = document.getElementById('timestampResult');
    const quickReferenceGrid = document.getElementById('quickReferenceGrid');
    const copyCurrentBtn = document.getElementById('copyCurrentBtn');

    if (!currentTimestamp) return; // 如果不在时间戳视图中则返回

    // 清理之前的定时器和事件监听器
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    if (abortController) {
        abortController.abort();
    }
    abortController = new AbortController();
    const signal = abortController.signal;

    // 更新当前时间
    function updateCurrentTime() {
        const now = Date.now();
        currentTimestamp.textContent = now;
    }

    // 复制当前时间戳
    if (copyCurrentBtn) {
        copyCurrentBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(currentTimestamp.textContent).then(() => {
                copyCurrentBtn.innerHTML = '<i class="ri-check-line"></i>';
                setTimeout(() => {
                    copyCurrentBtn.innerHTML = '<i class="ri-file-copy-line"></i>';
                }, 1500);
            });
        }, { signal });
    }

    // 时间戳转日期
    function handleToDate() {
        const value = timestampInput.value.trim();
        if (!value) {
            setResultError(dateResult, '请输入时间戳');
            return;
        }

        let timestamp = parseInt(value);
        if (isNaN(timestamp)) {
            setResultError(dateResult, '无效的时间戳格式');
            return;
        }

        // 自动识别秒和毫秒
        if (timestamp < 10000000000) {
            timestamp *= 1000;
        }

        const date = new Date(timestamp);
        const isoStr = date.toISOString();
        const localStr = date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        const dateStr = date.toLocaleDateString('zh-CN');
        const timeStr = date.toLocaleTimeString('zh-CN', { hour12: false });

        dateResult.innerHTML = `
            <div class="result-content">
                <div class="result-row">
                    <span class="result-label">ISO 8601:</span>
                    <span class="result-value" data-copy-value="${isoStr}">${isoStr}</span>
                    <button class="btn btn--icon btn--copy" data-copy="${isoStr}" title="复制">
                        <i class="ri-file-copy-line"></i>
                    </button>
                </div>
                <div class="result-row">
                    <span class="result-label">本地时间:</span>
                    <span class="result-value">${localStr}</span>
                    <button class="btn btn--icon btn--copy" data-copy="${localStr}" title="复制">
                        <i class="ri-file-copy-line"></i>
                    </button>
                </div>
                <div class="result-row">
                    <span class="result-label">日期:</span>
                    <span class="result-value">${dateStr}</span>
                    <button class="btn btn--icon btn--copy" data-copy="${dateStr}" title="复制">
                        <i class="ri-file-copy-line"></i>
                    </button>
                </div>
                <div class="result-row">
                    <span class="result-label">时间:</span>
                    <span class="result-value">${timeStr}</span>
                    <button class="btn btn--icon btn--copy" data-copy="${timeStr}" title="复制">
                        <i class="ri-file-copy-line"></i>
                    </button>
                </div>
            </div>
        `;
        dateResult.className = 'result-box result-box--success';
    }

    // 日期转时间戳
    function handleToTimestamp() {
        const value = dateInput.value;
        if (!value) {
            setResultError(timestampResult, '请选择日期');
            return;
        }

        const date = new Date(value);
        const timestamp = date.getTime();
        const timestampSec = Math.floor(timestamp / 1000);

        timestampResult.innerHTML = `
            <div class="result-content">
                <div class="result-row">
                    <span class="result-label">秒级:</span>
                    <span class="result-value">${timestampSec}</span>
                    <button class="btn btn--icon btn--copy" data-copy="${timestampSec}" title="复制">
                        <i class="ri-file-copy-line"></i>
                    </button>
                </div>
                <div class="result-row">
                    <span class="result-label">毫秒级:</span>
                    <span class="result-value">${timestamp}</span>
                    <button class="btn btn--icon btn--copy" data-copy="${timestamp}" title="复制">
                        <i class="ri-file-copy-line"></i>
                    </button>
                </div>
            </div>
        `;
        timestampResult.className = 'result-box result-box--success';
    }

    // 使用当前时间
    function handleUseNow() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        dateInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;
    }

    // 绑定事件
    toDateBtn.addEventListener('click', handleToDate, { signal });
    toTimestampBtn.addEventListener('click', handleToTimestamp, { signal });
    nowBtn.addEventListener('click', handleUseNow, { signal });

    // 使用事件委托处理复制按钮点击
    const container = document.querySelector('.timestamp-container');
    if (container) {
        container.addEventListener('click', (e) => {
            const copyBtn = e.target.closest('[data-copy]');
            if (copyBtn) {
                const textToCopy = copyBtn.getAttribute('data-copy');
                navigator.clipboard.writeText(textToCopy).then(() => {
                    const origHTML = copyBtn.innerHTML;
                    copyBtn.innerHTML = '<i class="ri-check-line"></i>';
                    setTimeout(() => {
                        copyBtn.innerHTML = origHTML;
                    }, 1500);
                });
            }
        }, { signal });
    }

    // 渲染快速参考
    const quickReferences = [
        { label: '千位秒戳', value: '1000000000' },
        { label: '2024年1月1日', value: '1704067200' },
        { label: '2025年1月1日', value: '1735660800' },
        { label: '2026年1月1日', value: '1736121600' },
        { label: 'Unix 纪元', value: '0' },
        { label: '一天前', value: 'day-ago' },
        { label: '一周前', value: 'week-ago' },
        { label: '当前时间', value: 'now' }
    ];

    quickReferenceGrid.innerHTML = '';
    quickReferences.forEach(ref => {
        const item = document.createElement('div');
        item.className = 'quick-ref-item';

        let displayValue;
        let actualValue;

        if (ref.value === 'now') {
            actualValue = Math.floor(Date.now() / 1000);
            displayValue = actualValue;
        } else if (ref.value === 'day-ago') {
            actualValue = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
            displayValue = actualValue;
        } else if (ref.value === 'week-ago') {
            actualValue = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
            displayValue = actualValue;
        } else {
            actualValue = ref.value;
            displayValue = ref.value;
        }

        item.innerHTML = `
            <div class="quick-ref-label">${ref.label}</div>
            <div class="quick-ref-value">${displayValue}</div>
        `;

        item.addEventListener('click', () => {
            timestampInput.value = actualValue;
            toDateBtn.click();
        }, { signal });

        quickReferenceGrid.appendChild(item);
    });

    // 初始化
    const startVisibleClock = () => {
        if (updateInterval) clearInterval(updateInterval);
        updateCurrentTime();
        updateInterval = setInterval(updateCurrentTime, 1000);
    };
    const stopVisibleClock = () => {
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = null;
    };

    startVisibleClock();
    window.addEventListener('dtkit:power-state', event => {
        if (event.detail?.suspended) stopVisibleClock();
        else startVisibleClock();
    }, { signal });

    // 回车键触发转换
    timestampInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') toDateBtn.click();
    }, { signal });
    dateInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') toTimestampBtn.click();
    }, { signal });
}

/**
 * 销毁工具（清理资源）
 */
function destroyTimestampTool() {
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
}

// 注册工具
registerTool({
    id: 'timestamp-converter',
    name: '时间戳转换',
    icon: 'ri-time-line',
    colorClass: 'tool-card__icon--blue',
    category: 'dev',
    description: '在 Unix 时间戳和日期时间之间相互转换。',
    template: getTemplate,
    init: initTimestampTool,
    destroy: destroyTimestampTool
});

// 导出以便其他模块引用
export { initTimestampTool, destroyTimestampTool };
