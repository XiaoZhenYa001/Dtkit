/**
 * 时间戳转换工具
 * 在 Unix 时间戳和日期时间之间相互转换
 * 
 * 每个工具文件夹包含: index.js (主逻辑), template.html (HTML模板), style.css (样式)
 */
import { registerTool } from '../toolRegistry.js';

// 定时器引用，用于清理
let updateInterval = null;

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
function getStyles() {
    return `
        .timestamp-container {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-lg);
            padding: var(--spacing-lg);
            max-width: 1200px;
            margin: 0 auto;
        }

        .current-time-section {
            background: linear-gradient(135deg, var(--color-primary) 0%, #6366f1 100%);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
            text-align: center;
            color: white;
        }

        .current-time-label {
            font-size: var(--font-size-sm);
            opacity: 0.9;
            margin-bottom: var(--spacing-xs);
        }

        .current-time-display {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--spacing-md);
        }

        .timestamp-value {
            font-family: var(--font-mono);
            font-size: 2rem;
            font-weight: 700;
        }

        .current-time-display .btn--icon {
            background: rgba(255,255,255,0.2);
            color: white;
            border: none;
        }

        .current-time-display .btn--icon:hover {
            background: rgba(255,255,255,0.3);
        }

        .conversion-panels {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: var(--spacing-lg);
        }

        .conversion-panel {
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-lg);
            overflow: hidden;
        }

        .panel-header {
            padding: var(--spacing-md) var(--spacing-lg);
            background: var(--color-bg-tertiary);
            border-bottom: 1px solid var(--color-border);
        }

        .panel-title {
            font-size: var(--font-size-md);
            font-weight: 600;
            color: var(--color-text-primary);
            margin: 0;
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
        }

        .panel-body {
            padding: var(--spacing-lg);
            display: flex;
            flex-direction: column;
            gap: var(--spacing-md);
        }

        .input-with-btn {
            display: flex;
            gap: var(--spacing-sm);
        }

        .input-with-btn .input {
            flex: 1;
        }

        .result-box {
            background: var(--color-bg-tertiary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-md);
            padding: var(--spacing-md);
            font-family: var(--font-mono);
            font-size: var(--font-size-sm);
            min-height: 60px;
        }

        .result-box--success {
            background: rgba(34, 197, 94, 0.1);
            border-color: rgba(34, 197, 94, 0.3);
        }

        .result-box--error {
            background: rgba(239, 68, 68, 0.1);
            border-color: rgba(239, 68, 68, 0.3);
            color: #ef4444;
        }

        .result-content {
            display: flex;
            flex-direction: column;
            gap: var(--spacing-xs);
        }

        .result-row {
            display: flex;
            gap: var(--spacing-md);
        }

        .result-label {
            color: var(--color-text-secondary);
            min-width: 80px;
        }

        .result-value {
            color: var(--color-text-primary);
            font-weight: 500;
        }

        .quick-reference {
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-lg);
            padding: var(--spacing-lg);
        }

        .quick-ref-title {
            font-size: var(--font-size-sm);
            font-weight: 600;
            color: var(--color-text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin: 0 0 var(--spacing-md) 0;
        }

        .quick-ref-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: var(--spacing-sm);
        }

        .quick-ref-item {
            background: var(--color-bg-tertiary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-md);
            padding: var(--spacing-sm) var(--spacing-md);
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .quick-ref-item:hover {
            background: var(--color-bg-primary);
            border-color: var(--color-primary);
        }

        .quick-ref-label {
            font-size: var(--font-size-xs);
            color: var(--color-text-secondary);
        }

        .quick-ref-value {
            font-family: var(--font-mono);
            font-size: var(--font-size-sm);
            color: var(--color-text-primary);
            font-weight: 500;
        }
    `;
}

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
    
    // 清理之前的定时器
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    
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
        });
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
            second: '2-digit'
        });
        
        dateResult.innerHTML = `
            <div class="result-content">
                <div class="result-row">
                    <span class="result-label">ISO 8601:</span>
                    <span class="result-value">${isoStr}</span>
                </div>
                <div class="result-row">
                    <span class="result-label">本地时间:</span>
                    <span class="result-value">${localStr}</span>
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
        
        timestampResult.innerHTML = `
            <div class="result-content">
                <div class="result-row">
                    <span class="result-label">秒级:</span>
                    <span class="result-value">${Math.floor(timestamp / 1000)}</span>
                </div>
                <div class="result-row">
                    <span class="result-label">毫秒级:</span>
                    <span class="result-value">${timestamp}</span>
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
    toDateBtn.addEventListener('click', handleToDate);
    toTimestampBtn.addEventListener('click', handleToTimestamp);
    nowBtn.addEventListener('click', handleUseNow);
    
    // 渲染快速参考
    const quickReferences = [
        { label: '千位秒戳', value: '1000000000' },
        { label: '2024年1月1日', value: '1704067200' },
        { label: 'Unix 纪元', value: '0' },
        { label: '当前时间', value: 'now' }
    ];
    
    quickReferenceGrid.innerHTML = '';
    quickReferences.forEach(ref => {
        const item = document.createElement('div');
        item.className = 'quick-ref-item';
        item.innerHTML = `
            <div class="quick-ref-label">${ref.label}</div>
            <div class="quick-ref-value">${ref.value === 'now' ? Math.floor(Date.now() / 1000) : ref.value}</div>
        `;
        
        item.addEventListener('click', () => {
            const valueToUse = ref.value === 'now' ? Math.floor(Date.now() / 1000) : ref.value;
            timestampInput.value = valueToUse;
            toDateBtn.click();
        });
        
        quickReferenceGrid.appendChild(item);
    });
    
    // 初始化
    updateCurrentTime();
    updateInterval = setInterval(updateCurrentTime, 1000);
    
    // 回车键触发转换
    timestampInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') toDateBtn.click();
    });
    dateInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') toTimestampBtn.click();
    });
}

/**
 * 销毁工具（清理资源）
 */
function destroyTimestampTool() {
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
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
    styles: getStyles,
    init: initTimestampTool,
    destroy: destroyTimestampTool
});

// 导出以便其他模块引用
export { initTimestampTool, destroyTimestampTool };
