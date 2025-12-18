/**
 * 时间戳转换工具
 * 在 Unix 时间戳和日期时间之间相互转换
 */
import { registerTool } from './toolRegistry.js';

// 定时器引用，用于清理
let updateInterval = null;

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
    init: initTimestampTool,
    destroy: destroyTimestampTool
});

// 导出以便其他模块引用
export { initTimestampTool, destroyTimestampTool };
