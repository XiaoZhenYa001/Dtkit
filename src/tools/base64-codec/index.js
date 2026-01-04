/**
 * Base64 编解码工具
 * 支持文本的 Base64 编码和解码
 */
import { registerTool } from '../toolRegistry.js';

let base64State = {
    currentText: '',
    currentEncoded: '',
    abortController: null,
};

/**
 * 获取工具的 HTML 模板
 */
function getTemplate() {
    return `
        <div class="base64-container">
            <!-- 工具栏 -->
            <div class="base64-toolbar">
                <h2 class="base64-title">Base64 编解码</h2>
                <div class="base64-buttons">
                    <button id="base64EncodeBtn" class="btn btn--primary">
                        <i class="ri-lock-line"></i> 编码
                    </button>
                    <button id="base64DecodeBtn" class="btn btn--secondary">
                        <i class="ri-lock-unlock-line"></i> 解码
                    </button>
                    <button id="base64ClearBtn" class="btn btn--secondary">
                        <i class="ri-delete-bin-line"></i> 清空
                    </button>
                </div>
            </div>

            <!-- 编辑器区域 -->
            <div class="base64-editor-container">
                <!-- 输入面板 -->
                <div class="base64-panel">
                    <div class="base64-panel-header">
                        <span class="base64-panel-label">原始文本 / Base64</span>
                        <div class="base64-panel-actions">
                            <button id="base64CopyInputBtn" class="base64-copy-btn" title="复制输入">
                                <i class="ri-file-copy-line"></i>
                            </button>
                        </div>
                    </div>
                    <textarea id="base64Input" class="base64-textarea" placeholder="输入文本或 Base64 字符串..."></textarea>
                </div>

                <!-- 输出面板 -->
                <div class="base64-panel">
                    <div class="base64-panel-header">
                        <span class="base64-panel-label">转换结果</span>
                        <div class="base64-panel-actions">
                            <button id="base64CopyBtn" class="base64-copy-btn" title="复制输出">
                                <i class="ri-file-copy-line"></i>
                            </button>
                        </div>
                    </div>
                    <textarea id="base64Output" class="base64-textarea" readonly placeholder="转换结果将显示在这里..."></textarea>
                </div>
            </div>

            <!-- 统计栏 -->
            <div id="base64Stats" class="base64-stats">
                <div class="stat-item">
                    <span class="stat-label">输入:</span>
                    <span class="stat-value">0 字符</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">输出:</span>
                    <span class="stat-value">0 字符</span>
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
        .base64-container {
            display: flex;
            flex-direction: column;
            height: 100%;
            padding: 0;
            gap: 0;
        }

        .base64-toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            height: 3.5rem;
            padding: 0 var(--spacing-lg);
            background-color: var(--color-bg-secondary);
            border-bottom: 1px solid var(--color-border);
            gap: var(--spacing-lg);
        }

        .base64-title {
            font-size: var(--font-size-lg);
            font-weight: 600;
            color: var(--color-text-primary);
            margin: 0;
        }

        .base64-buttons {
            display: flex;
            gap: var(--spacing-sm);
        }

        .base64-editor-container {
            display: flex;
            flex: 1;
            gap: var(--spacing-lg);
            padding: var(--spacing-lg);
            background-color: var(--color-bg-primary);
            overflow: hidden;
        }

        .base64-panel {
            flex: 1;
            display: flex;
            flex-direction: column;
            background-color: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            border-radius: var(--radius-lg);
            overflow: hidden;
            box-shadow: var(--shadow-sm);
        }

        .base64-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            height: 2rem;
            padding: 0 var(--spacing-md);
            background-color: var(--color-bg-tertiary);
            border-bottom: 1px solid var(--color-border);
        }

        .base64-panel-label {
            font-size: var(--font-size-xs);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--color-text-secondary);
        }

        .base64-panel-actions {
            display: flex;
            gap: var(--spacing-sm);
        }

        .base64-copy-btn {
            background: none;
            border: none;
            color: var(--color-text-tertiary);
            cursor: pointer;
            padding: 0.25rem;
            border-radius: var(--radius-sm);
            transition: all var(--transition-fast);
            font-size: var(--font-size-base);
        }

        .base64-copy-btn:hover {
            color: var(--color-primary);
        }

        .base64-textarea {
            flex: 1;
            padding: var(--spacing-md);
            font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
            font-size: var(--font-size-sm);
            color: var(--color-text-primary);
            background: transparent;
            border: none;
            outline: none;
            resize: none;
            line-height: 1.5;
        }

        .base64-textarea::placeholder {
            color: var(--color-text-tertiary);
        }

        .base64-stats {
            display: flex;
            align-items: center;
            justify-content: flex-start;
            gap: var(--spacing-lg);
            height: 2rem;
            padding: 0 var(--spacing-lg);
            background-color: var(--color-bg-secondary);
            border-top: 1px solid var(--color-border);
            font-size: var(--font-size-xs);
        }

        .stat-item {
            display: flex;
            gap: var(--spacing-sm);
            align-items: center;
        }

        .stat-label {
            color: var(--color-text-tertiary);
            font-weight: 500;
        }

        .stat-value {
            color: var(--color-primary);
            font-weight: 600;
            font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
        }

        @media (max-width: 1024px) {
            .base64-editor-container {
                flex-direction: column;
            }
        }

        @media (max-width: 768px) {
            .base64-toolbar {
                flex-wrap: wrap;
                height: auto;
                padding: var(--spacing-md);
            }
            
            .base64-buttons {
                flex-wrap: wrap;
                width: 100%;
            }
        }
    `;
}

/**
 * 初始化 Base64 工具
 */
export function initBase64Tool() {
    // 清理之前的事件监听器
    if (base64State.abortController) {
        base64State.abortController.abort();
    }
    base64State.abortController = new AbortController();
    const { signal } = base64State.abortController;

    const inputArea = document.getElementById('base64Input');
    const outputArea = document.getElementById('base64Output');
    const encodeBtn = document.getElementById('base64EncodeBtn');
    const decodeBtn = document.getElementById('base64DecodeBtn');
    const copyBtn = document.getElementById('base64CopyBtn');
    const clearBtn = document.getElementById('base64ClearBtn');
    const copyInputBtn = document.getElementById('base64CopyInputBtn');

    if (!inputArea) return;

    // 输入变化时实时转换
    inputArea.addEventListener('input', () => {
        base64State.currentText = inputArea.value;
        autoConvert();
        updateStats();
    }, { signal });

    // 手动编码
    if (encodeBtn) {
        encodeBtn.addEventListener('click', () => {
            encodeBase64();
        }, { signal });
    }

    // 手动解码
    if (decodeBtn) {
        decodeBtn.addEventListener('click', () => {
            decodeBase64();
        }, { signal });
    }

    // 复制输出
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            copyToClipboard(outputArea.value, copyBtn);
        }, { signal });
    }

    // 复制输入
    if (copyInputBtn) {
        copyInputBtn.addEventListener('click', () => {
            copyToClipboard(inputArea.value, copyInputBtn);
        }, { signal });
    }

    // 清空
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            inputArea.value = '';
            outputArea.value = '';
            base64State.currentText = '';
            base64State.currentEncoded = '';
            updateStats();
        }, { signal });
    }

    updateStats();
}

function autoConvert() {
    const input = base64State.currentText;
    const outputArea = document.getElementById('base64Output');
    if (!outputArea) return;

    // 尝试自动检测输入是否为 Base64
    if (isBase64(input)) {
        try {
            const decoded = atob(input);
            outputArea.value = decoded;
            base64State.currentEncoded = input;
        } catch (e) {
            encodeBase64();
        }
    } else {
        // 编码普通文本
        try {
            // 使用 UTF-8 编码
            const encoded = btoa(unescape(encodeURIComponent(input)));
            outputArea.value = encoded;
            base64State.currentEncoded = encoded;
        } catch (e) {
            outputArea.value = '输入包含无法编码的字符';
        }
    }
}

function encodeBase64() {
    const inputArea = document.getElementById('base64Input');
    const outputArea = document.getElementById('base64Output');
    const input = inputArea.value;

    try {
        // 使用 UTF-8 编码支持中文
        const encoded = btoa(unescape(encodeURIComponent(input)));
        outputArea.value = encoded;
        base64State.currentEncoded = encoded;
        updateStats();
    } catch (error) {
        outputArea.value = '❌ 编码失败：' + error.message;
    }
}

function decodeBase64() {
    const inputArea = document.getElementById('base64Input');
    const outputArea = document.getElementById('base64Output');
    const input = inputArea.value;

    try {
        // 使用 UTF-8 解码支持中文
        const decoded = decodeURIComponent(escape(atob(input)));
        outputArea.value = decoded;
        base64State.currentEncoded = input;
        updateStats();
    } catch (error) {
        outputArea.value = '❌ 解码失败：请确保输入为有效的 Base64 字符串';
    }
}

function isBase64(str) {
    if (!str || str.length === 0) return false;
    if (str.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
}

function copyToClipboard(text, btn) {
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
        if (btn) {
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<i class="ri-check-line"></i>';
            setTimeout(() => {
                btn.innerHTML = originalHTML;
            }, 2000);
        }
    });
}

function updateStats() {
    const inputArea = document.getElementById('base64Input');
    const outputArea = document.getElementById('base64Output');
    const statsDiv = document.getElementById('base64Stats');

    if (!statsDiv || !inputArea || !outputArea) return;

    const input = inputArea.value;
    const inputSize = new Blob([input]).size;
    const output = outputArea.value;
    const outputSize = new Blob([output]).size;

    statsDiv.innerHTML = `
        <div class="stat-item">
            <span class="stat-label">输入:</span>
            <span class="stat-value">${input.length} 字符 (${inputSize} 字节)</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">输出:</span>
            <span class="stat-value">${output.length} 字符 (${outputSize} 字节)</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">膨胀比:</span>
            <span class="stat-value">${inputSize > 0 ? ((outputSize / inputSize * 100).toFixed(1) + '%') : '-'}</span>
        </div>
    `;
}

export function destroyBase64Tool() {
    // 清理事件监听器
    if (base64State.abortController) {
        base64State.abortController.abort();
        base64State.abortController = null;
    }
    base64State.currentText = '';
    base64State.currentEncoded = '';
}

registerTool({
    id: 'base64-codec',
    name: 'Base64 编解码',
    icon: 'ri-lock-2-line',
    colorClass: 'tool-card__icon--green',
    category: 'dev',
    description: 'Base64 编码和解码，支持文本和二进制数据',
    template: getTemplate,
    styles: getStyles,
    init: initBase64Tool,
    destroy: destroyBase64Tool
});
